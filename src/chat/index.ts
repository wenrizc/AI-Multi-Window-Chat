import { PORT_NAME } from '../shared/constants';
import { getConfig } from '../shared/storage';
import type { FailureCode } from '../shared/errors';
import type {
  ChatRequest,
  ChatSession,
  FeatureSettings,
  PersistedMessage,
  PromptConfig,
  ProviderConfig,
  StreamEvent
} from '../shared/types';
import {
  escapeHtml,
  formatUsageLabel,
  getModel,
  normalizeMaxContextMessages,
  nowIso,
  sliceMessageWindow,
  uid,
  writeTextToClipboard
} from '../shared/utils';
import { renderMarkdown, safeLinkHref } from './markdown';

const COMPOSER_STATUS_AUTO_HIDE_MS = 1000;
const COPY_BUTTON_RESET_MS = 1200;
/**
 * Streaming markdown is re-rendered on a trailing timer instead of once per
 * delta, so a fast token stream cannot trigger hundreds of full parses.
 */
const ASSISTANT_RENDER_INTERVAL_MS = 60;
/** Maximum number of manual retries offered for a retryable failure. */
const MAX_RETRY_ATTEMPTS = 3;
const SCROLL_PIN_THRESHOLD_PX = 48;
const COPY_ICON_SVG = `
  <svg class="message-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="10" height="10" rx="2"></rect>
    <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"></path>
  </svg>
`;
const COPIED_ICON_SVG = `
  <svg class="message-copy-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m5 12 4 4L19 6"></path>
  </svg>
`;

type ComposerStatusVariant = 'busy' | 'success' | 'warning' | 'error';

type AssistantRenderState = {
  container: HTMLElement;
  content: HTMLElement;
  reasoningWrap: HTMLElement;
  reasoning: HTMLElement;
  toolsWrap: HTMLDetailsElement;
  toolsBody: HTMLElement;
  footer: HTMLElement;
};

function getExpectedMessageOrigin(): string {
  // The embedded chat receives messages from the page that owns the iframe.
  // A standalone extension page receives them from the extension itself.
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      // Fall through to the current document origin for malformed referrers.
    }
  }
  return window.location.origin;
}

function isTrustedWindowMessage(event: MessageEvent): boolean {
  const sourceIsParent = event.source === window.parent || event.source === window;
  return sourceIsParent && event.origin === getExpectedMessageOrigin();
}

class ChatWindowApp {
  private chatId = uid('chat');
  private windowTitle = '';
  private profileId: string | null = null;
  private promptId: string | null = null;
  private messages: PersistedMessage[] = [];
  private providers: ProviderConfig[] = [];
  private prompts: PromptConfig[] = [];
  private featureSettings: FeatureSettings | null = null;
  private isLoading = false;
  private port = chrome.runtime.connect({ name: PORT_NAME });
  private currentRequestId: string | null = null;
  private currentAssistantState: AssistantRenderState | null = null;
  private currentAssistantText = '';
  private currentReasoningText = '';
  private currentToolCalls: PersistedMessage['toolCalls'] = [];
  private currentModelId: string | null = null;
  private settingsOpen = false;
  private streamingEnabled = true;
  private streamingOverride: boolean | null = null;
  private maxContextMessages: number | null = null;
  private maxContextMessagesOverride: number | null = null;
  private currentMode: PersistedMessage['mode'] = 'chat';
  private composerStatusTimer: number | null = null;
  private composerStatusKey: string | null = null;
  private copyButtonTimers = new WeakMap<HTMLButtonElement, number>();

  /** Throttled streaming render state. */
  private renderTimer: number | null = null;
  private renderInFlight = false;
  private assistantContentVersion = 0;
  /** Set when the final response render is authoritative; blocks late flushes. */
  private renderSealed = false;

  /** Replayable snapshot for the manual retry action. */
  private retryTemplate: Omit<ChatRequest, 'requestId'> | null = null;
  private retryAttempts = 0;
  private userPinnedToBottom = true;

  private elements = {
    messagesContainer: document.getElementById('messagesContainer') as HTMLElement,
    composerStatus: document.getElementById('composerStatus') as HTMLElement,
    composerStatusText: document.getElementById('composerStatusText') as HTMLElement,
    composerRetryBtn: document.getElementById('composerRetryBtn') as HTMLButtonElement,
    messageInput: document.getElementById('messageInput') as HTMLTextAreaElement,
    sendBtn: document.getElementById('sendBtn') as HTMLButtonElement,
    promptSelect: document.getElementById('promptSelect') as HTMLSelectElement,
    profileSelect: document.getElementById('profileSelect') as HTMLSelectElement,
    searchToggle: document.getElementById('searchToggle') as HTMLInputElement,
    streamingToggle: document.getElementById('streamingToggle') as HTMLInputElement,
    maxContextMessagesInput: document.getElementById('maxContextMessagesInput') as HTMLInputElement,
    settingsPanel: document.getElementById('settingsPanel') as HTMLElement,
    settingsCloseBtn: document.getElementById('settingsCloseBtn') as HTMLButtonElement
  };

  constructor() {
    this.init().catch((error) => {
      console.error(error);
      this.setLocalizedComposerStatus('chat__statusInitFailed', 'error', undefined, getErrorMessage(error));
    });
  }

  private async init() {
    document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
    if (typeof updatePageTranslations === 'function') {
      updatePageTranslations();
    }

    this.bindEvents();
    this.port.onMessage.addListener((event) => {
      void this.handleStreamEvent(event as StreamEvent);
    });

    window.addEventListener('message', (event) => {
      if (!isTrustedWindowMessage(event)) {
        return;
      }
      if (event.data?.type === 'INIT_CHAT') {
        this.applyInitPayload(event.data);
        return;
      }
      if (event.data?.type === 'WINDOW_TITLE_CHANGED') {
        this.windowTitle = typeof event.data.title === 'string' ? event.data.title : this.windowTitle;
        return;
      }
      if (event.data?.type === 'TOGGLE_SETTINGS_PANEL') {
        this.toggleSettingsPanel();
      }
    });

    await this.reloadStore();
    this.renderSelectors();
  }

  private async reloadStore() {
    const config = await getConfig();
    this.providers = config.providers;
    this.prompts = config.prompts;
    this.featureSettings = config.featureSettings;

    if (!this.profileId) {
      this.profileId = config.featureSettings.defaultProviderId;
    }
    if (!this.promptId) {
      this.promptId = config.featureSettings.defaultPromptId;
    }

    this.elements.searchToggle.checked = config.featureSettings.search.enabledByDefault;
  }

  private applyInitPayload(payload: {
    chatId?: string;
    windowTitle?: string;
    profileId?: string | null;
    promptId?: string | null;
    streamingOverride?: boolean | null;
    maxContextMessagesOverride?: number | null;
    historyMessages?: PersistedMessage[];
    initialMessage?: string;
  }) {
    this.chatId = payload.chatId || this.chatId;
    this.windowTitle = payload.windowTitle || this.windowTitle;
    this.profileId = payload.profileId || this.profileId;
    this.promptId = payload.promptId || this.promptId;
    if ('streamingOverride' in payload) {
      this.streamingOverride = payload.streamingOverride ?? null;
    }
    if ('maxContextMessagesOverride' in payload) {
      this.maxContextMessagesOverride = payload.maxContextMessagesOverride ?? null;
    }

    if (Array.isArray(payload.historyMessages) && payload.historyMessages.length > 0) {
      this.messages = payload.historyMessages;
      this.renderHistory().catch((error) => {
        console.error(error);
      });
    }

    if (payload.initialMessage) {
      this.elements.messageInput.value = payload.initialMessage;
      this.adjustTextareaHeight();
    }

    this.renderSelectors();
  }

  private bindEvents() {
    this.elements.sendBtn.addEventListener('click', () => this.handlePrimaryAction());
    this.elements.composerRetryBtn.addEventListener('click', () => this.retryLastRequest());
    this.elements.settingsCloseBtn.addEventListener('click', () => this.setSettingsPanelOpen(false));
    this.elements.messagesContainer.addEventListener('scroll', () => {
      const el = this.elements.messagesContainer;
      this.userPinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_THRESHOLD_PX;
    });
    this.elements.messageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.sendMessage();
      }
    });
    this.elements.messageInput.addEventListener('input', () => {
      this.adjustTextareaHeight();
      if (!this.isLoading) {
        this.clearComposerStatus();
      }
    });
    this.elements.profileSelect.addEventListener('change', () => {
      this.profileId = this.elements.profileSelect.value || null;
      this.clearComposerStatus();
      this.syncStreamingControl();
    });
    this.elements.promptSelect.addEventListener('change', () => {
      this.promptId = this.elements.promptSelect.value || null;
      if (!this.promptId || this.prompts.some((prompt) => prompt.id === this.promptId)) {
        this.clearComposerStatus();
      }
    });
    this.elements.searchToggle.addEventListener('change', () => {
      if (!this.elements.searchToggle.checked || this.featureSettings?.search.tavilyApiKey.trim()) {
        this.clearComposerStatus();
      }
    });
    this.elements.streamingToggle.addEventListener('change', () => {
      const model = this.getCurrentModel();
      const modelDefault = model?.supportsStreaming ?? true;
      const next = this.elements.streamingToggle.checked;
      this.streamingOverride = next === modelDefault ? null : next;
      this.syncSessionSettingsFromModel();
      this.clearComposerStatus();
    });
    this.elements.maxContextMessagesInput.addEventListener('change', () => {
      const model = this.getCurrentModel();
      const modelDefault = model?.maxContextMessages ?? null;
      const next = normalizeMaxContextMessages(this.elements.maxContextMessagesInput.value);
      this.maxContextMessagesOverride = next === modelDefault ? null : next;
      this.syncSessionSettingsFromModel();
      this.clearComposerStatus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.settingsOpen) {
        return;
      }
      const target = event.target;
      if (target instanceof Node && this.elements.settingsPanel.contains(target)) {
        return;
      }
      this.setSettingsPanelOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.settingsOpen) {
        this.setSettingsPanelOpen(false);
      }
    });
  }

  private handlePrimaryAction() {
    if (this.isLoading) {
      this.abortCurrentRequest();
      return;
    }
    void this.sendMessage();
  }

  private createReasoningBlock(summary: string): HTMLElement {
    const reasoning = document.createElement('div');
    reasoning.className = 'message-reasoning';
    reasoning.innerHTML = `
      <div class="message-reasoning-title">${escapeHtml(t('chat__reasoningSummary'))}</div>
      <div class="message-reasoning-body">${escapeHtml(summary).replace(/\n/g, '<br>')}</div>
    `;
    return reasoning;
  }

  private renderToolCalls(
    wrap: HTMLDetailsElement,
    body: HTMLElement,
    toolCalls: PersistedMessage['toolCalls'],
    forceOpen = false
  ) {
    if (!toolCalls.length) {
      wrap.hidden = true;
      wrap.open = false;
      body.innerHTML = '';
      return;
    }

    wrap.hidden = false;
    const pending = toolCalls.some((toolCall) => toolCall.status === 'pending');
    wrap.open = forceOpen || pending;

    const summary = wrap.querySelector('.message-tools-summary') as HTMLElement;
    const title = summary.querySelector('.message-tools-title') as HTMLElement;
    const meta = summary.querySelector('.message-tools-meta') as HTMLElement;
    title.innerHTML = pending
      ? `<span class="message-tools-spinner" aria-hidden="true"></span>${escapeHtml(t('chat__toolCalls'))}`
      : escapeHtml(t('chat__toolCalls'));
    meta.innerHTML = `
      <span class="message-tools-status">${escapeHtml(pending ? t('chat__toolStatusPending') : t('chat__toolStatusDone'))}</span>
      <span>${toolCalls.length}</span>
    `;

    body.innerHTML = toolCalls.map((toolCall) => `
      <div class="message-tool-entry">
        <div class="message-tool-entry-header">
          <span class="message-tool-entry-name">${escapeHtml(toolCall.name)}</span>
          <span class="message-tool-entry-status">${escapeHtml(this.getToolStatusLabel(toolCall.status))}</span>
        </div>
        <div class="message-tool-entry-args">${escapeHtml(toolCall.arguments)}</div>
        <div class="message-tool-entry-output">${escapeHtml(toolCall.output || t('chat__toolWaiting'))}</div>
      </div>
    `).join('');
  }

  private getToolStatusLabel(status: PersistedMessage['toolCalls'][number]['status']) {
    if (status === 'completed') {
      return t('chat__toolStatusCompleted');
    }
    if (status === 'failed') {
      return t('chat__toolStatusFailed');
    }
    return t('chat__toolStatusPending');
  }

  private setSettingsPanelOpen(open: boolean) {
    this.settingsOpen = open;
    this.elements.settingsPanel.hidden = !open;
    if (open) {
      window.requestAnimationFrame(() => {
        this.elements.profileSelect.focus({ preventScroll: true });
      });
    }
  }

  private toggleSettingsPanel() {
    this.setSettingsPanelOpen(!this.settingsOpen);
  }

  private hydrateMessageFooter(footer: HTMLElement, getContent: () => string) {
    footer.textContent = '';

    const usageLabel = document.createElement('span');
    usageLabel.className = 'message-footer-usage';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'message-copy-btn';
    this.setCopyButtonState(copyBtn, false);
    copyBtn.addEventListener('click', () => {
      void this.copyAssistantMessage(copyBtn, getContent);
    });

    footer.append(usageLabel, copyBtn);
  }

  private setUsageFooter(footer: HTMLElement, usage: PersistedMessage['tokenUsage']) {
    const usageLabel = footer.querySelector('.message-footer-usage') as HTMLElement | null;
    if (!usage) {
      if (usageLabel) {
        usageLabel.textContent = '';
      } else {
        footer.textContent = '';
      }
      return;
    }

    if (usageLabel) {
      usageLabel.textContent = formatUsageLabel(usage);
      return;
    }

    footer.textContent = formatUsageLabel(usage);
  }

  private setCopyButtonState(button: HTMLButtonElement, copied: boolean) {
    const label = copied ? t('chat__btnCopiedMessage') : t('chat__btnCopyMessage');
    button.innerHTML = copied ? COPIED_ICON_SVG : COPY_ICON_SVG;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.copied = copied ? 'true' : 'false';
  }

  private async copyAssistantMessage(button: HTMLButtonElement, getContent: () => string) {
    const content = getContent().trim();
    if (!content) {
      return;
    }

    const copied = await writeTextToClipboard(content);
    if (!copied) {
      return;
    }

    const existingTimer = this.copyButtonTimers.get(button);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    this.setCopyButtonState(button, true);
    const resetTimer = window.setTimeout(() => {
      this.setCopyButtonState(button, false);
      this.copyButtonTimers.delete(button);
    }, COPY_BUTTON_RESET_MS);
    this.copyButtonTimers.set(button, resetTimer);
  }

  private renderSelectors() {
    this.elements.profileSelect.innerHTML = this.providers.length
      ? this.providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join('')
      : `<option value="">${escapeHtml(t('chat__noProvider'))}</option>`;

    this.elements.promptSelect.innerHTML = [
      `<option value="">${escapeHtml(t('prompt__noPrompt'))}</option>`,
      ...this.prompts.map((prompt) => `<option value="${prompt.id}">${escapeHtml(prompt.name)}</option>`)
    ].join('');

    if (this.profileId) {
      this.elements.profileSelect.value = this.profileId;
    }
    if (this.promptId) {
      this.elements.promptSelect.value = this.promptId;
    }
    this.syncStreamingControl();
  }

  private getCurrentModel() {
    const provider = this.providers.find((item) => item.id === this.profileId);
    return provider ? getModel(provider, provider.defaultModel) : null;
  }

  private syncSessionSettingsFromModel() {
    const model = this.getCurrentModel();
    const modelStreaming = model?.supportsStreaming ?? true;
    const modelMaxContextMessages = model?.maxContextMessages ?? null;

    if (this.streamingOverride !== null && this.streamingOverride === modelStreaming) {
      this.streamingOverride = null;
    }
    if (this.maxContextMessagesOverride !== null && this.maxContextMessagesOverride === modelMaxContextMessages) {
      this.maxContextMessagesOverride = null;
    }

    this.streamingEnabled = this.streamingOverride ?? modelStreaming;
    this.maxContextMessages = this.maxContextMessagesOverride ?? modelMaxContextMessages;
    this.elements.streamingToggle.checked = this.streamingEnabled;
    this.elements.maxContextMessagesInput.value = this.maxContextMessages === null
      ? ''
      : String(this.maxContextMessages);
  }

  private syncStreamingControl() {
    this.syncSessionSettingsFromModel();
  }

  private async renderHistory() {
    this.elements.messagesContainer.innerHTML = '';
    for (const message of this.messages) {
      this.elements.messagesContainer.appendChild(await this.createMessageNode(message));
    }
  }

  private async createMessageNode(message: PersistedMessage): Promise<HTMLElement> {
    const wrapper = document.createElement('div');
    wrapper.className = `message message-${message.role}`;

    const header = document.createElement('div');
    header.className = 'message-header';
    header.innerHTML = `<span class="message-avatar">${message.role === 'user' ? '👤' : '🤖'}</span><span class="message-role">${message.role === 'user' ? escapeHtml(t('chat__roleUser')) : escapeHtml(t('chat__roleAI'))}</span>`;
    wrapper.appendChild(header);

    if (message.role === 'assistant' && message.reasoningSummary) {
      wrapper.appendChild(this.createReasoningBlock(message.reasoningSummary));
    }

    if (message.role === 'assistant') {
      const toolsWrap = document.createElement('details');
      toolsWrap.className = 'message-tools';
      toolsWrap.hidden = true;
      toolsWrap.innerHTML = `
        <summary class="message-tools-summary">
          <span class="message-tools-title"></span>
          <span class="message-tools-meta"></span>
        </summary>
        <div class="message-tools-body"></div>
      `;
      this.renderToolCalls(
        toolsWrap,
        toolsWrap.querySelector('.message-tools-body') as HTMLElement,
        message.toolCalls
      );
      wrapper.appendChild(toolsWrap);
    }

    const content = document.createElement('div');
    content.className = 'message-content';
    const rendered = message.role === 'assistant' ? await renderMarkdown(message.content) : escapeHtml(message.content).replace(/\n/g, '<br>');
    content.innerHTML = rendered;
    wrapper.appendChild(content);

    if (message.role === 'assistant') {
      const footer = document.createElement('div');
      footer.className = 'message-footer';
      this.hydrateMessageFooter(footer, () => message.content);
      this.setUsageFooter(footer, message.tokenUsage);
      wrapper.appendChild(footer);
    }

    if (message.sources.length > 0) {
      const sources = document.createElement('div');
      sources.className = 'message-sources';
      this.renderSources(sources, message.sources);
      wrapper.appendChild(sources);
    }

    return wrapper;
  }

  private renderSources(container: HTMLElement, sources: PersistedMessage['sources']) {
    container.textContent = '';
    sources.forEach((source, index) => {
      const label = `[${index + 1}] ${source.title}`;
      const href = safeLinkHref(source.url);
      if (!href) {
        const span = document.createElement('span');
        span.textContent = label;
        container.appendChild(span);
        return;
      }
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = label;
      container.appendChild(link);
    });
  }

  private async appendUserMessage(content: string) {
    const message: PersistedMessage = {
      id: uid('msg'),
      role: 'user',
      content,
      reasoningSummary: null,
      toolCalls: [],
      sources: [],
      tokenUsage: null,
      mode: this.currentMode,
      providerId: this.profileId,
      modelId: null,
      promptId: this.promptId,
      searchMeta: null,
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.removeWelcomeMessage();
    this.elements.messagesContainer.appendChild(await this.createMessageNode(message));
    this.userPinnedToBottom = true;
    this.scrollToBottom();
  }

  private createAssistantPlaceholder(): AssistantRenderState {
    const wrapper = document.createElement('div');
    wrapper.className = 'message message-assistant';
    wrapper.innerHTML = `
      <div class="message-header">
        <span class="message-avatar">🤖</span>
        <span class="message-role">${escapeHtml(t('chat__roleAI'))}</span>
      </div>
      <div class="message-reasoning">
        <div class="message-reasoning-title">${escapeHtml(t('chat__reasoningSummary'))}</div>
        <div class="message-reasoning-body"></div>
      </div>
      <details class="message-tools" hidden>
        <summary class="message-tools-summary">
          <span class="message-tools-title"></span>
          <span class="message-tools-meta"></span>
        </summary>
        <div class="message-tools-body"></div>
      </details>
      <div class="message-content"></div>
      <div class="message-footer"></div>
      <div class="message-sources"></div>
    `;
    this.removeWelcomeMessage();
    this.elements.messagesContainer.appendChild(wrapper);
    this.userPinnedToBottom = true;
    this.scrollToBottom();

    const reasoningWrap = wrapper.querySelector('.message-reasoning') as HTMLElement;
    reasoningWrap.style.display = 'none';
    const toolsWrap = wrapper.querySelector('.message-tools') as HTMLDetailsElement;
    const footer = wrapper.querySelector('.message-footer') as HTMLElement;
    this.hydrateMessageFooter(footer, () => this.currentAssistantText);

    return {
      container: wrapper,
      content: wrapper.querySelector('.message-content') as HTMLElement,
      reasoningWrap,
      reasoning: wrapper.querySelector('.message-reasoning-body') as HTMLElement,
      toolsWrap,
      toolsBody: wrapper.querySelector('.message-tools-body') as HTMLElement,
      footer
    };
  }

  private removeWelcomeMessage() {
    this.elements.messagesContainer.querySelector('.welcome-message')?.remove();
  }

  private async sendMessage() {
    const content = this.elements.messageInput.value.trim();
    if (!content || this.isLoading) {
      return;
    }

    this.clearComposerStatus();
    this.hideRetryButton();
    this.retryTemplate = null;
    this.retryAttempts = 0;

    if (!this.profileId) {
      this.setLocalizedComposerStatus('chat__statusCreateProviderFirst', 'warning');
      return;
    }

    const provider = this.providers.find((item) => item.id === this.profileId);
    if (!provider) {
      this.setLocalizedComposerStatus('chat__statusProviderNotFound', 'warning');
      return;
    }

    const prompt = this.prompts.find((item) => item.id === this.promptId) ?? null;
    if (this.promptId && !prompt) {
      this.setLocalizedComposerStatus('chat__statusPromptUnavailable', 'warning');
      return;
    }

    if (this.elements.searchToggle.checked && !this.featureSettings?.search.tavilyApiKey.trim()) {
      this.setLocalizedComposerStatus('chat__statusConfigureTavilyFirst', 'warning');
      return;
    }

    const model = this.getCurrentModel();
    if (!model?.modelId) {
      this.setLocalizedComposerStatus('chat__errorModelUnavailable', 'error');
      return;
    }

    this.currentMode = this.elements.searchToggle.checked ? 'search' : 'chat';
    await this.appendUserMessage(content);
    this.elements.messageInput.value = '';
    this.adjustTextareaHeight();
    this.isLoading = true;
    this.currentRequestId = uid('req');
    this.currentAssistantState = this.createAssistantPlaceholder();
    this.currentAssistantText = '';
    this.currentReasoningText = '';
    this.currentToolCalls = [];
    this.assistantContentVersion = 0;
    this.renderSealed = false;
    this.cancelScheduledRender();
    this.showLoading(true);
    this.setLocalizedComposerStatus('chat__statusGenerating', 'busy');

    try {
      this.syncSessionSettingsFromModel();
      this.currentModelId = model.modelId;
      const requestId = this.currentRequestId;
      if (!requestId) {
        throw new Error(t('common__unknownError'));
      }

      const requestMessages = [
        ...(prompt?.content ? [{ role: 'system' as const, content: prompt.content }] : []),
        ...sliceMessageWindow(
          this.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          this.maxContextMessages
        )
      ];

      const request: ChatRequest = {
        requestId,
        chatId: this.chatId,
        windowTitle: this.windowTitle,
        providerId: provider.id,
        modelId: model.modelId,
        promptId: prompt?.id ?? null,
        streamingOverride: this.streamingOverride,
        maxContextMessages: this.maxContextMessages,
        maxContextMessagesOverride: this.maxContextMessagesOverride,
        userMessage: content,
        mode: this.currentMode,
        messages: requestMessages,
        generationParams: provider.defaultGenerationParams,
        streamingEnabled: this.streamingEnabled
      };

      this.port.postMessage({
        type: 'start_chat',
        payload: request
      });

      this.retryTemplate = {
        chatId: request.chatId,
        windowTitle: request.windowTitle,
        providerId: request.providerId,
        modelId: request.modelId,
        promptId: request.promptId,
        streamingOverride: request.streamingOverride,
        maxContextMessages: request.maxContextMessages,
        maxContextMessagesOverride: request.maxContextMessagesOverride,
        userMessage: request.userMessage,
        mode: request.mode,
        messages: request.messages,
        generationParams: request.generationParams,
        streamingEnabled: request.streamingEnabled
      };
    } catch (error) {
      console.error(error);
      this.removeCurrentAssistantPlaceholder();
      this.resetLoadingState();
      this.setComposerStatus(this.formatChatFailure(getErrorMessage(error)), 'error');
    }
  }

  private abortCurrentRequest() {
    if (!this.currentRequestId) {
      return;
    }
    this.setLocalizedComposerStatus('chat__statusStopping', 'busy');
    this.port.postMessage({
      type: 'abort_chat',
      requestId: this.currentRequestId
    });
  }

  private async handleStreamEvent(event: StreamEvent) {
    if (event.requestId !== this.currentRequestId) {
      return;
    }

    switch (event.type) {
      case 'statusUpdate':
        this.setComposerStatus(event.message, 'busy');
        break;
      case 'contentDelta':
        if (this.currentAssistantState) {
          this.currentAssistantText += event.delta;
          this.assistantContentVersion += 1;
          this.scheduleAssistantRender();
        }
        break;
      case 'reasoningDelta':
        if (this.currentAssistantState) {
          this.currentReasoningText += event.delta;
          this.currentAssistantState.reasoning.textContent = this.currentReasoningText;
          this.updateCurrentReasoningVisibility();
        }
        break;
      case 'toolCallUpdate':
        this.currentToolCalls = event.toolCalls;
        if (this.currentAssistantState) {
          this.renderToolCalls(
            this.currentAssistantState.toolsWrap,
            this.currentAssistantState.toolsBody,
            event.toolCalls,
            true
          );
          this.scrollToBottom();
        }
        break;
      case 'sourceUpdate':
        if (this.currentAssistantState) {
          const sourceWrap = this.currentAssistantState.container.querySelector('.message-sources') as HTMLElement;
          this.renderSources(sourceWrap, event.sources);
        }
        break;
      case 'usageUpdate':
        if (this.currentAssistantState) {
          this.setUsageFooter(this.currentAssistantState.footer, event.usage);
        }
        break;
      case 'completed':
        await this.finishStream(event.response);
        this.retryAttempts = 0;
        this.hideRetryButton();
        this.setLocalizedComposerStatus('chat__statusCompleted', 'success', COMPOSER_STATUS_AUTO_HIDE_MS);
        break;
      case 'aborted':
        this.cancelScheduledRender();
        this.removeCurrentAssistantPlaceholder();
        this.resetLoadingState();
        this.hideRetryButton();
        this.setLocalizedComposerStatus('chat__statusStopped', 'success', COMPOSER_STATUS_AUTO_HIDE_MS);
        break;
      case 'failed': {
        console.error(event.error);
        this.cancelScheduledRender();
        this.removeCurrentAssistantPlaceholder();
        this.resetLoadingState();
        this.setComposerStatus(this.formatChatFailure(event.error, event.code, event.status), 'error');
        const canRetry = Boolean(event.retryable && this.retryTemplate && this.retryAttempts < MAX_RETRY_ATTEMPTS);
        this.setRetryButtonVisible(canRetry);
        break;
      }
      default:
        break;
    }
  }

  private async finishStream(response: {
    content: string;
    reasoningSummary: string | null;
    toolCalls: PersistedMessage['toolCalls'];
    usage: PersistedMessage['tokenUsage'];
    sources: PersistedMessage['sources'];
    searchMeta: PersistedMessage['searchMeta'];
  }) {
    this.cancelScheduledRender();
    this.renderSealed = true;
    if (this.currentAssistantState) {
      const rendered = await renderMarkdown(response.content);
      this.currentAssistantState.content.innerHTML = rendered;
      if (response.reasoningSummary) {
        this.currentReasoningText = response.reasoningSummary;
        this.currentAssistantState.reasoning.textContent = response.reasoningSummary;
        this.updateCurrentReasoningVisibility();
      } else {
        this.currentAssistantState.reasoningWrap.style.display = 'none';
      }
      this.currentToolCalls = response.toolCalls;
      this.renderToolCalls(
        this.currentAssistantState.toolsWrap,
        this.currentAssistantState.toolsBody,
        response.toolCalls
      );
      this.setUsageFooter(this.currentAssistantState.footer, response.usage);
    }

    const message: PersistedMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: response.content,
      reasoningSummary: response.reasoningSummary,
      toolCalls: response.toolCalls,
      sources: response.sources,
      tokenUsage: response.usage,
      mode: this.currentMode,
      providerId: this.profileId,
      modelId: this.currentModelId,
      promptId: this.promptId,
      searchMeta: response.searchMeta,
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.resetLoadingState();
  }

  private removeCurrentAssistantPlaceholder() {
    this.currentAssistantState?.container.remove();
  }

  private resetLoadingState() {
    this.cancelScheduledRender();
    this.renderSealed = false;
    this.isLoading = false;
    this.currentRequestId = null;
    this.currentAssistantState = null;
    this.currentAssistantText = '';
    this.currentReasoningText = '';
    this.currentToolCalls = [];
    this.currentModelId = null;
    this.showLoading(false);
  }

  /**
   * Schedules a trailing markdown render. Only one timer is ever pending; if a
   * render is already in flight the next flush is chained after it finishes.
   */
  private scheduleAssistantRender() {
    if (!this.currentAssistantState || this.renderTimer !== null || this.renderInFlight) {
      return;
    }
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      void this.flushAssistantRender();
    }, ASSISTANT_RENDER_INTERVAL_MS);
  }

  private async flushAssistantRender() {
    const state = this.currentAssistantState;
    if (!state || this.renderInFlight) {
      return;
    }

    this.renderInFlight = true;
    const requestId = this.currentRequestId;
    const version = this.assistantContentVersion;
    const text = this.currentAssistantText;

    try {
      const rendered = await renderMarkdown(text);
      // The request may have finished/aborted or a new one started while the
      // parse was in flight; never write a stale snapshot into the DOM.
      if (!this.renderSealed && requestId === this.currentRequestId && state === this.currentAssistantState) {
        state.content.innerHTML = rendered;
        if (this.userPinnedToBottom) {
          this.scrollToBottom();
        }
      }
    } catch (error) {
      console.error('Failed to render streamed markdown', error);
    } finally {
      this.renderInFlight = false;
    }

    if (version !== this.assistantContentVersion) {
      this.scheduleAssistantRender();
    }
  }

  private cancelScheduledRender() {
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private setRetryButtonVisible(visible: boolean) {
    this.elements.composerRetryBtn.hidden = !visible;
  }

  private hideRetryButton() {
    this.setRetryButtonVisible(false);
  }

  /** Re-sends the last request without re-appending the user message. */
  private retryLastRequest() {
    const template = this.retryTemplate;
    if (!template || this.isLoading || this.retryAttempts >= MAX_RETRY_ATTEMPTS) {
      return;
    }

    this.retryAttempts += 1;
    this.hideRetryButton();
    this.clearComposerStatus();

    this.isLoading = true;
    this.currentRequestId = uid('req');
    this.currentAssistantState = this.createAssistantPlaceholder();
    this.currentAssistantText = '';
    this.currentReasoningText = '';
    this.currentToolCalls = [];
    this.assistantContentVersion = 0;
    this.renderSealed = false;
    this.cancelScheduledRender();
    this.showLoading(true);
    this.setLocalizedComposerStatus('chat__statusGenerating', 'busy');

    this.port.postMessage({
      type: 'start_chat',
      payload: {
        ...template,
        requestId: this.currentRequestId
      }
    });
  }

  private updateCurrentReasoningVisibility() {
    if (!this.currentAssistantState) {
      return;
    }
    if (!this.currentReasoningText) {
      this.currentAssistantState.reasoningWrap.style.display = 'none';
      return;
    }
    this.currentAssistantState.reasoningWrap.style.display = '';
  }

  private adjustTextareaHeight() {
    this.elements.messageInput.style.height = 'auto';
    this.elements.messageInput.style.height = `${Math.min(this.elements.messageInput.scrollHeight, 108)}px`;
  }

  private showLoading(active: boolean) {
    this.elements.sendBtn.classList.toggle('is-loading', active);
    this.elements.sendBtn.title = active ? t('chat__btnStop') : t('chat__btnSend');
    this.elements.sendBtn.setAttribute('aria-label', active ? t('chat__btnStop') : t('chat__btnSend'));
  }

  private setLocalizedComposerStatus(
    key: string,
    variant: ComposerStatusVariant,
    autoHideMs?: number,
    substitutions?: string | number | Array<string | number>
  ) {
    this.setComposerStatus(t(key, substitutions ?? []), variant, autoHideMs, key);
  }

  private setComposerStatus(
    message: string,
    variant: ComposerStatusVariant,
    autoHideMs?: number,
    key: string | null = null
  ) {
    if (this.composerStatusTimer !== null) {
      window.clearTimeout(this.composerStatusTimer);
      this.composerStatusTimer = null;
    }

    const text = message.trim();
    if (!text) {
      this.clearComposerStatus();
      return;
    }

    this.composerStatusKey = key;
    this.elements.composerStatus.dataset.variant = variant;
    this.elements.composerStatusText.textContent = text;
    this.elements.composerStatus.hidden = false;

    if (autoHideMs) {
      this.composerStatusTimer = window.setTimeout(() => {
        this.clearComposerStatus();
      }, autoHideMs);
    }
  }

  private clearComposerStatus() {
    if (this.composerStatusTimer !== null) {
      window.clearTimeout(this.composerStatusTimer);
      this.composerStatusTimer = null;
    }
    this.composerStatusKey = null;
    this.elements.composerStatus.hidden = true;
    this.elements.composerStatusText.textContent = '';
    delete this.elements.composerStatus.dataset.variant;
    this.hideRetryButton();
  }

  private formatChatFailure(error: string, code?: FailureCode, status?: number | null) {
    if (code && code !== 'unknown') {
      switch (code) {
        case 'timeout':
          return t('chat__errorTimeout');
        case 'auth':
          return t('chat__errorAuthFailed');
        case 'model_unavailable':
          return t('chat__errorModelUnavailable');
        case 'network':
          return t('chat__errorNetwork');
        case 'parse':
          return t('chat__errorParseFailed');
        case 'provider_not_found':
          return t('chat__statusProviderNotFound');
        case 'http_error':
          return status ? this.formatServiceStatusFailure(String(status)) : t('chat__errorRequestFailed');
        default:
          break;
      }
    }

    const message = error.trim();
    if (!message) {
      return t('chat__errorRequestFailed');
    }

    if (/tavily/i.test(message)) {
      return message;
    }

    const providerStatus = message.match(/Provider returned\s+(\d{3})/i);
    if (providerStatus) {
      return this.formatServiceStatusFailure(providerStatus[1]);
    }

    if (/(api\s*key|apikey|auth|unauthorized|forbidden|invalid key|incorrect key|401|403)/i.test(message)) {
      return t('chat__errorAuthFailed');
    }
    if (/(model.*(not found|unavailable|does not exist)|does not exist.*model|404)/i.test(message)) {
      return t('chat__errorModelUnavailable');
    }
    if (/(timeout|timed out|etimedout|408|504)/i.test(message)) {
      return t('chat__errorTimeout');
    }
    if (/(failed to fetch|network|fetch failed|enotfound|econnreset|econnrefused|err_network)/i.test(message)) {
      return t('chat__errorNetwork');
    }
    if (/(json|parse|parsing|unexpected token|unexpected end)/i.test(message)) {
      return t('chat__errorParseFailed');
    }

    return t('chat__errorRequestFailed');
  }

  private formatServiceStatusFailure(statusCode: string) {
    if (statusCode === '401' || statusCode === '403') {
      return t('chat__errorAuthFailed');
    }
    if (statusCode === '404') {
      return t('chat__errorModelUnavailable');
    }
    if (statusCode === '408' || statusCode === '504') {
      return t('chat__errorTimeout');
    }
    return t('chat__errorServiceStatus', statusCode);
  }

  private scrollToBottom() {
    this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || t('common__unknownError'));
}

new ChatWindowApp();
