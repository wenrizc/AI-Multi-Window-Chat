import { PORT_NAME } from '../shared/constants';
import { getConfig, upsertChatSession } from '../shared/storage';
import { findLatestLeafUnder, getSiblingInfo, resolveActivePath } from '../shared/conversation-tree';
import type { FailureCode } from '../shared/errors';
import type {
  ChatMode,
  ChatRequest,
  ChatSession,
  FeatureSettings,
  ModelConfig,
  PersistedMessage,
  PromptConfig,
  ProviderConfig,
  StreamEvent,
  ChatAttachment,
  ReasoningEffort
} from '../shared/types';
import {
  escapeHtml,
  formatUsageLabel,
  getModel,
  nowIso,
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
const BRANCH_ICON_SVG = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M6 3v6a4 4 0 0 0 4 4h4"></path>
    <path d="M14 3v18"></path>
    <path d="m17 16 3 3-3 3"></path>
  </svg>
`;
const EDIT_ICON_SVG = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 20h9"></path>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
  </svg>
`;
const REGENERATE_ICON_SVG = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"></path>
    <path d="M21 3v5h-5"></path>
    <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"></path>
    <path d="M3 21v-5h5"></path>
  </svg>
`;

type MessagePurpose = 'send' | 'edit' | 'regenerate';

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
  private reasoningEffort: ReasoningEffort = 'default';
  private customEfforts: string[] = [];
  private attachments: ChatAttachment[] = [];
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

  /** Conversation-tree state (see shared/conversation-tree.ts). */
  private activeLeafId: string | null = null;
  private currentUserMessageId: string | null = null;
  private currentAssistantMessageId: string | null = null;
  private currentProviderId: string | null = null;
  private currentPromptId: string | null = null;
  private currentPurpose: MessagePurpose = 'send';
  private previousActiveLeafId: string | null = null;

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
    reasoningEffortSelect: document.getElementById('reasoningEffortSelect') as HTMLSelectElement,
    customEffortsInput: document.getElementById('customEffortsInput') as HTMLTextAreaElement,
    saveCustomEffortsBtn: document.getElementById('saveCustomEffortsBtn') as HTMLButtonElement,
    customEffortsStatus: document.getElementById('customEffortsStatus') as HTMLElement,
    attachmentInput: document.getElementById('attachmentInput') as HTMLInputElement,
    attachmentBtn: document.getElementById('attachmentBtn') as HTMLButtonElement,
    attachmentTray: document.getElementById('attachmentTray') as HTMLElement,
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
    const saved = await chrome.storage.local.get('customReasoningEfforts');
    this.customEfforts = this.parseCustomEfforts(Array.isArray(saved.customReasoningEfforts)
      ? saved.customReasoningEfforts.filter((value: unknown) => typeof value === 'string').join('\n')
      : '');
    this.renderReasoningOptions();
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.customReasoningEfforts) {
        const values = changes.customReasoningEfforts.newValue;
        this.customEfforts = this.parseCustomEfforts(Array.isArray(values) ? values.filter((v: unknown) => typeof v === 'string').join('\n') : '');
        this.renderReasoningOptions();
      }
    });
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
    historyMessages?: PersistedMessage[];
    activeLeafId?: string | null;
    initialMessage?: string;
  }) {
    this.chatId = payload.chatId || this.chatId;
    this.windowTitle = payload.windowTitle || this.windowTitle;
    this.profileId = payload.profileId || this.profileId;
    this.promptId = payload.promptId || this.promptId;
    if ('streamingOverride' in payload) {
      this.streamingOverride = payload.streamingOverride ?? null;
    }

    if (Array.isArray(payload.historyMessages) && payload.historyMessages.length > 0) {
      this.messages = payload.historyMessages;
      const hasTreeData = this.messages.some((message) => message.parentId !== undefined);
      if (payload.activeLeafId && hasTreeData) {
        this.activeLeafId = payload.activeLeafId;
      } else {
        // Legacy/unstructured history: back-fill a linear chain so it renders in
        // full and can still be branched or edited.
        let previousId: string | null = null;
        for (const message of this.messages) {
          message.parentId = previousId;
          previousId = message.id;
        }
        this.activeLeafId = previousId;
      }
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
    this.elements.attachmentBtn.addEventListener('click', () => this.elements.attachmentInput.click());
    this.elements.attachmentInput.addEventListener('change', () => {
      void this.addFiles(Array.from(this.elements.attachmentInput.files ?? []));
      this.elements.attachmentInput.value = '';
    });
    this.elements.messageInput.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (files.length) {
        event.preventDefault();
        void this.addFiles(files);
      }
    });
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
    this.elements.reasoningEffortSelect.addEventListener('change', () => {
      this.reasoningEffort = (this.elements.reasoningEffortSelect.value || 'default') as ReasoningEffort;
    });
    this.elements.saveCustomEffortsBtn.addEventListener('click', () => void this.saveCustomEfforts());
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

  private parseCustomEfforts(value: string): string[] {
    const builtins = new Set(['default', 'none', 'low', 'medium', 'high', 'max']);
    return [...new Set(value.split(/[,，;；\r\n]+/).map((v) => v.trim()).filter((v) => v && !builtins.has(v)))];
  }

  private renderReasoningOptions() {
    const select = this.elements.reasoningEffortSelect;
    select.querySelectorAll('[data-custom-effort]').forEach((option) => option.remove());
    for (const value of this.customEfforts) {
      const option = new Option(value, value);
      option.dataset.customEffort = 'true';
      select.add(option);
    }
    if (!Array.from(select.options).some((option) => option.value === this.reasoningEffort)) {
      this.reasoningEffort = 'default';
    }
    select.value = this.reasoningEffort;
    this.elements.customEffortsInput.value = this.customEfforts.join(', ');
  }

  private async saveCustomEfforts() {
    const values = this.parseCustomEfforts(this.elements.customEffortsInput.value);
    this.elements.saveCustomEffortsBtn.disabled = true;
    try {
      await chrome.storage.local.set({ customReasoningEfforts: values });
      this.customEfforts = values;
      this.renderReasoningOptions();
      this.elements.customEffortsStatus.textContent = t('chat__customEffortsSaved');
    } catch {
      this.elements.customEffortsStatus.textContent = t('chat__customEffortsFailed');
    } finally {
      this.elements.saveCustomEffortsBtn.disabled = false;
    }
  }

  private async addFiles(files: File[]) {
    for (const file of files) {
      if (!(file.type.startsWith('image/') || file.type === 'text/plain' || file.name.toLowerCase().endsWith('.md'))) continue;
      const attachment: ChatAttachment = { id: uid('attachment'), name: file.name, mimeType: file.type || 'text/plain', dataUrl: '', status: 'parsing' };
      this.attachments.push(attachment);
      this.renderAttachments();
      try {
        attachment.dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        attachment.status = 'ready';
      } catch {
        attachment.status = 'error';
      }
      this.renderAttachments();
    }
  }

  private renderAttachments() {
    const tray = this.elements.attachmentTray;
    tray.hidden = this.attachments.length === 0;
    tray.innerHTML = this.attachments.map((attachment) => `<div class="attachment-chip ${attachment.status}">${attachment.mimeType.startsWith('image/') && attachment.dataUrl ? `<img src="${attachment.dataUrl}" alt="">` : '<span class="attachment-file">TXT</span>'}<span class="attachment-name">${escapeHtml(attachment.name)}</span><span class="attachment-status">${escapeHtml(t(attachment.status === 'ready' ? 'chat__attachmentReady' : attachment.status === 'error' ? 'chat__attachmentError' : 'chat__attachmentParsing'))}</span><button type="button" data-remove-attachment="${attachment.id}" aria-label="Remove">×</button></div>`).join('');
    tray.querySelectorAll<HTMLButtonElement>('[data-remove-attachment]').forEach((button) => button.addEventListener('click', () => {
      this.attachments = this.attachments.filter((item) => item.id !== button.dataset.removeAttachment);
      this.renderAttachments();
    }));
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

    if (this.streamingOverride !== null && this.streamingOverride === modelStreaming) {
      this.streamingOverride = null;
    }
    this.streamingEnabled = this.streamingOverride ?? modelStreaming;
    this.elements.streamingToggle.checked = this.streamingEnabled;
  }

  private syncStreamingControl() {
    this.syncSessionSettingsFromModel();
  }

  private getActivePath(): PersistedMessage[] {
    return resolveActivePath(this.messages, this.activeLeafId);
  }

  private async renderHistory() {
    this.elements.messagesContainer.innerHTML = '';
    for (const message of this.getActivePath()) {
      this.elements.messagesContainer.appendChild(await this.createMessageNode(message));
    }
  }

  private async createMessageNode(message: PersistedMessage): Promise<HTMLElement> {
    const wrapper = document.createElement('div');
    wrapper.className = `message message-${message.role}`;
    wrapper.dataset.messageId = message.id;

    const header = document.createElement('div');
    header.className = 'message-header';
    header.innerHTML = `<span class="message-avatar">${message.role === 'user' ? '👤' : '🤖'}</span><span class="message-role">${message.role === 'user' ? escapeHtml(t('chat__roleUser')) : escapeHtml(t('chat__roleAI'))}</span>`;
    wrapper.appendChild(header);

    const siblingInfo = getSiblingInfo(message, this.messages);
    if (siblingInfo.total > 1) {
      wrapper.appendChild(this.createVersionNavigator(message, siblingInfo.index + 1, siblingInfo.total));
    }

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

    wrapper.appendChild(this.createMessageActions(message));

    return wrapper;
  }

  private createVersionNavigator(message: PersistedMessage, position: number, total: number): HTMLElement {
    const navigator = document.createElement('div');
    navigator.className = 'message-versions';
    const label = `${position}/${total}`;
    navigator.innerHTML = `
      <button type="button" class="message-version-btn" data-version-dir="-1" title="${escapeHtml(t('chat__versionPrev'))}" aria-label="${escapeHtml(t('chat__versionPrev'))}">‹</button>
      <span class="message-version-label" aria-live="polite">${escapeHtml(label)}</span>
      <button type="button" class="message-version-btn" data-version-dir="1" title="${escapeHtml(t('chat__versionNext'))}" aria-label="${escapeHtml(t('chat__versionNext'))}">›</button>
    `;
    navigator.querySelectorAll<HTMLButtonElement>('[data-version-dir]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const direction = Number(button.dataset.versionDir) || 0;
        void this.switchVersion(message, direction);
      });
    });
    return navigator;
  }

  private createMessageActions(message: PersistedMessage): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'message-actions';

    if (message.role === 'user') {
      const editBtn = this.createActionButton('edit', t('chat__btnEdit'), EDIT_ICON_SVG);
      editBtn.addEventListener('click', () => this.startEditMessage(message));
      actions.appendChild(editBtn);
    } else {
      const regenerateBtn = this.createActionButton('regenerate', t('chat__btnRegenerate'), REGENERATE_ICON_SVG);
      regenerateBtn.addEventListener('click', () => void this.regenerateMessage(message));
      actions.appendChild(regenerateBtn);

      if (this.providers.length > 0) {
        const modelSelect = document.createElement('select');
        modelSelect.className = 'message-model-select';
        modelSelect.title = t('chat__btnRegenerateWithModel');
        modelSelect.setAttribute('aria-label', t('chat__btnRegenerateWithModel'));
        modelSelect.innerHTML = `<option value="">${escapeHtml(t('chat__btnRegenerateWithModel'))}</option>`
          + this.providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
        modelSelect.addEventListener('change', () => {
          const providerId = modelSelect.value || this.profileId;
          modelSelect.value = '';
          if (providerId) {
            void this.regenerateMessage(message, providerId);
          }
        });
        actions.appendChild(modelSelect);
      }
    }

    const branchBtn = this.createActionButton('branch', t('chat__btnBranch'), BRANCH_ICON_SVG);
    branchBtn.addEventListener('click', () => void this.branchFromMessage(message));
    actions.appendChild(branchBtn);

    return actions;
  }

  private createActionButton(action: string, label: string, icon: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `message-action-btn message-action-${action}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `${icon}<span>${escapeHtml(label)}</span>`;
    return button;
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

  private async appendUserMessage(
    content: string,
    parentId: string | null,
    mode: ChatMode = this.currentMode
  ): Promise<PersistedMessage> {
    const message: PersistedMessage = {
      id: uid('msg'),
      role: 'user',
      content,
      parentId,
      reasoningSummary: null,
      toolCalls: [],
      sources: [],
      tokenUsage: null,
      mode,
      providerId: this.profileId,
      modelId: null,
      promptId: this.promptId,
      searchMeta: null,
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.activeLeafId = message.id;
    this.removeWelcomeMessage();
    return message;
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
    if ((!content && this.attachments.length === 0) || this.isLoading) {
      return;
    }
    if (this.attachments.some((attachment) => attachment.status === 'parsing')) {
      this.setLocalizedComposerStatus('chat__attachmentParsing', 'busy');
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

    const mode: ChatMode = this.elements.searchToggle.checked ? 'search' : 'chat';
    this.currentMode = mode;
    const readyTextFiles = this.attachments.filter((a) => a.status === 'ready' && !a.mimeType.startsWith('image/'));
    const effectiveContent = [content, ...readyTextFiles.map((a) => {
      try {
        const bytes = Uint8Array.from(atob(a.dataUrl.split(',')[1] || ''), (char) => char.charCodeAt(0));
        return `\n[${a.name}]\n${new TextDecoder().decode(bytes)}`;
      } catch {
        return `\n[${a.name}]`;
      }
    })].filter(Boolean).join('\n').trim();
    const parentId = this.activeLeafId;
    const userMessage = await this.appendUserMessage(effectiveContent || t('chat__attachmentOnly'), parentId, mode);
    this.elements.messageInput.value = '';
    const requestAttachments = this.attachments.filter((a) => a.status === 'ready' && a.mimeType.startsWith('image/'));
    this.attachments = [];
    this.renderAttachments();
    this.adjustTextareaHeight();
    await this.renderHistory();

    this.postChatRequest({
      provider,
      prompt,
      model,
      mode,
      userMessage: userMessage.content,
      userMessageId: userMessage.id,
      parentMessageId: parentId,
      appendUserMessage: true,
      purpose: 'send',
      attachments: requestAttachments
    });
  }

  /**
   * Shared request dispatch for send/edit/regenerate. The active path (including
   * the freshly appended user turn) becomes the request history, and the local
   * ids are sent along so background persistence mirrors this in-memory tree.
   */
  private postChatRequest(params: {
    provider: ProviderConfig;
    prompt: PromptConfig | null;
    model: ModelConfig;
    mode: ChatMode;
    userMessage: string;
    userMessageId: string;
    parentMessageId: string | null;
    appendUserMessage: boolean;
    purpose: MessagePurpose;
    attachments: ChatAttachment[];
  }) {
    this.isLoading = true;
    this.currentRequestId = uid('req');
    this.currentUserMessageId = params.userMessageId;
    this.currentAssistantMessageId = uid('msg');
    this.currentProviderId = params.provider.id;
    this.currentPromptId = params.prompt?.id ?? null;
    this.currentPurpose = params.purpose;
    this.currentMode = params.mode;
    this.currentModelId = params.model.modelId;
    this.streamingEnabled = this.streamingOverride ?? params.model.supportsStreaming;

    this.currentAssistantState = this.createAssistantPlaceholder();
    this.currentAssistantText = '';
    this.currentReasoningText = '';
    this.currentToolCalls = [];
    this.assistantContentVersion = 0;
    this.renderSealed = false;
    this.cancelScheduledRender();
    this.showLoading(true);
    this.setLocalizedComposerStatus('chat__statusGenerating', 'busy');

    const requestId = this.currentRequestId;
    if (!requestId) {
      throw new Error(t('common__unknownError'));
    }

    const path = this.getActivePath();
    const request: ChatRequest = {
      requestId,
      chatId: this.chatId,
      windowTitle: this.windowTitle,
      providerId: params.provider.id,
      modelId: params.model.modelId,
      promptId: params.prompt?.id ?? null,
      streamingOverride: this.streamingOverride,
      userMessage: params.userMessage,
      mode: params.mode,
      messages: [
        ...(params.prompt?.content ? [{ role: 'system' as const, content: params.prompt.content }] : []),
        ...path.map((message) => ({ role: message.role, content: message.content }))
      ],
      generationParams: params.provider.defaultGenerationParams,
      streamingEnabled: this.streamingEnabled,
      reasoningEffort: this.reasoningEffort,
      attachments: params.attachments,
      userMessageId: params.userMessageId,
      assistantMessageId: this.currentAssistantMessageId,
      parentMessageId: params.parentMessageId,
      appendUserMessage: params.appendUserMessage,
      purpose: params.purpose
    };

    try {
      this.port.postMessage({
        type: 'start_chat',
        payload: request
      });
    } catch (error) {
      // The runtime port can be gone (e.g. service worker restarted); recover the
      // composer instead of leaving the placeholder stuck in a loading state.
      console.error(error);
      this.resetLoadingState();
      this.renderHistory().catch((renderError) => console.error(renderError));
      this.setComposerStatus(this.formatChatFailure(getErrorMessage(error)), 'error');
      return;
    }

    this.retryTemplate = {
      chatId: request.chatId,
      windowTitle: request.windowTitle,
      providerId: request.providerId,
      modelId: request.modelId,
      promptId: request.promptId,
      streamingOverride: request.streamingOverride,
      userMessage: request.userMessage,
      mode: request.mode,
      messages: request.messages,
      generationParams: request.generationParams,
      streamingEnabled: request.streamingEnabled,
      reasoningEffort: request.reasoningEffort,
      attachments: request.attachments,
      userMessageId: request.userMessageId,
      assistantMessageId: request.assistantMessageId,
      parentMessageId: request.parentMessageId,
      appendUserMessage: request.appendUserMessage,
      purpose: request.purpose
    };
  }

  /** Copies the active path up to `message` into a brand new branched session. */
  private async branchFromMessage(message: PersistedMessage) {
    if (this.isLoading) {
      return;
    }
    const path = this.getActivePath();
    const index = path.findIndex((item) => item.id === message.id);
    if (index < 0) {
      return;
    }

    const prefix = path.slice(0, index + 1);
    const branchMessages: PersistedMessage[] = prefix.map((item) => ({
      ...item,
      id: uid('msg'),
      parentId: null
    }));
    branchMessages.forEach((item, position) => {
      item.parentId = position === 0 ? null : branchMessages[position - 1].id;
    });

    const titleBase = this.windowTitle || t('content__aiChat');
    const session: ChatSession = {
      chatId: uid('chat'),
      title: `${titleBase} · ${t('chat__branchSuffix')}`,
      providerId: this.profileId,
      promptId: this.promptId,
      streamingOverride: this.streamingOverride,
      mode: prefix[prefix.length - 1]?.mode ?? 'chat',
      messages: branchMessages,
      activeLeafId: branchMessages[branchMessages.length - 1]?.id ?? null,
      branchOf: { chatId: this.chatId, messageId: message.id },
      totalUsage: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    try {
      await upsertChatSession(session);
    } catch (error) {
      console.error(error);
      this.setLocalizedComposerStatus('chat__statusBranchFailed', 'error');
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: 'BRANCH_CHAT_WINDOW', chat: session });
      if (response && typeof response === 'object' && (response as { success?: boolean }).success === false) {
        this.setLocalizedComposerStatus('chat__statusBranchFailed', 'error');
        return;
      }
      this.setLocalizedComposerStatus('chat__statusBranchOpened', 'success', COMPOSER_STATUS_AUTO_HIDE_MS);
    } catch (error) {
      console.error(error);
      this.setLocalizedComposerStatus('chat__statusBranchFailed', 'error');
    }
  }

  /** Opens an inline editor for a user message. */
  private startEditMessage(message: PersistedMessage) {
    if (this.isLoading) {
      return;
    }
    const wrapper = this.elements.messagesContainer.querySelector<HTMLElement>(
      `.message[data-message-id="${message.id}"]`
    );
    const content = wrapper?.querySelector<HTMLElement>('.message-content');
    if (!wrapper || !content || wrapper.querySelector('.message-edit-editor')) {
      return;
    }

    const editor = document.createElement('div');
    editor.className = 'message-edit-editor';
    editor.innerHTML = `
      <textarea class="message-edit-input" rows="2"></textarea>
      <div class="message-edit-actions">
        <button type="button" class="message-edit-save">${escapeHtml(t('chat__btnSaveEdit'))}</button>
        <button type="button" class="message-edit-cancel">${escapeHtml(t('chat__btnCancelEdit'))}</button>
      </div>
    `;
    const textarea = editor.querySelector<HTMLTextAreaElement>('.message-edit-input');
    if (!textarea) {
      return;
    }
    textarea.value = message.content;
    content.hidden = true;
    content.after(editor);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    const close = () => {
      editor.remove();
      content.hidden = false;
    };
    editor.querySelector('.message-edit-cancel')?.addEventListener('click', close);
    editor.querySelector('.message-edit-save')?.addEventListener('click', () => {
      const next = textarea.value.trim();
      if (!next) {
        textarea.focus();
        return;
      }
      close();
      void this.applyEdit(message, next);
    });
  }

  /** Forks the conversation by replacing `target` with an edited sibling turn. */
  private async applyEdit(target: PersistedMessage, newContent: string) {
    const provider = this.providers.find((item) => item.id === this.profileId);
    if (!provider) {
      this.setLocalizedComposerStatus('chat__statusProviderNotFound', 'warning');
      return;
    }
    const model = getModel(provider, provider.defaultModel);
    if (!model?.modelId) {
      this.setLocalizedComposerStatus('chat__errorModelUnavailable', 'error');
      return;
    }

    this.hideRetryButton();
    this.retryTemplate = null;
    this.retryAttempts = 0;
    this.clearComposerStatus();

    const parentId = target.parentId ?? null;
    this.currentMode = target.mode;
    const userMessage = await this.appendUserMessage(newContent, parentId, target.mode);
    await this.renderHistory();

    this.postChatRequest({
      provider,
      prompt: this.resolvePrompt(target.promptId ?? this.promptId),
      model,
      mode: target.mode,
      userMessage: newContent,
      userMessageId: userMessage.id,
      parentMessageId: parentId,
      appendUserMessage: true,
      purpose: 'edit',
      attachments: []
    });
  }

  /** Regenerates an assistant message, optionally using a different provider. */
  private async regenerateMessage(target: PersistedMessage, providerId?: string | null) {
    if (this.isLoading || target.role !== 'assistant') {
      return;
    }
    const provider = this.providers.find((item) => item.id === (providerId || this.profileId));
    if (!provider) {
      this.setLocalizedComposerStatus('chat__statusProviderNotFound', 'warning');
      return;
    }
    const model = getModel(provider, provider.defaultModel);
    if (!model?.modelId) {
      this.setLocalizedComposerStatus('chat__errorModelUnavailable', 'error');
      return;
    }

    const parentId = target.parentId ?? null;
    const userMessage = parentId ? this.messages.find((item) => item.id === parentId) : undefined;
    if (!userMessage) {
      this.setLocalizedComposerStatus('chat__statusRegenerateUnavailable', 'warning');
      return;
    }
    if (target.mode === 'search' && !this.featureSettings?.search.tavilyApiKey.trim()) {
      this.setLocalizedComposerStatus('chat__statusConfigureTavilyFirst', 'warning');
      return;
    }

    this.hideRetryButton();
    this.retryTemplate = null;
    this.retryAttempts = 0;
    this.clearComposerStatus();

    this.previousActiveLeafId = this.activeLeafId;
    this.activeLeafId = parentId;
    await this.renderHistory();

    this.postChatRequest({
      provider,
      prompt: this.resolvePrompt(target.promptId ?? this.promptId),
      model,
      mode: target.mode,
      userMessage: userMessage.content,
      userMessageId: userMessage.id,
      parentMessageId: parentId,
      appendUserMessage: false,
      purpose: 'regenerate',
      attachments: []
    });
  }

  private resolvePrompt(promptId: string | null): PromptConfig | null {
    return promptId ? this.prompts.find((item) => item.id === promptId) ?? null : null;
  }

  /** Switches between sibling versions and shows the newest leaf under it. */
  private async switchVersion(message: PersistedMessage, direction: number) {
    if (this.isLoading) {
      return;
    }
    const info = getSiblingInfo(message, this.messages);
    if (info.total <= 1) {
      return;
    }
    const nextIndex = (info.index + direction + info.total) % info.total;
    const target = info.siblings[nextIndex];
    const leafId = findLatestLeafUnder(target.id, this.messages) ?? target.id;
    this.activeLeafId = leafId;
    await this.renderHistory();
    this.userPinnedToBottom = true;
    this.scrollToBottom();
    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_LEAF', chatId: this.chatId, leafId }).catch((error) => {
      console.error(error);
    });
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
      case 'aborted': {
        const purpose = this.currentPurpose;
        this.cancelScheduledRender();
        this.resetLoadingState();
        if (purpose === 'regenerate' && this.previousActiveLeafId !== null) {
          this.activeLeafId = this.previousActiveLeafId;
        }
        this.hideRetryButton();
        await this.renderHistory();
        this.setLocalizedComposerStatus('chat__statusStopped', 'success', COMPOSER_STATUS_AUTO_HIDE_MS);
        break;
      }
      case 'failed': {
        console.error(event.error);
        const purpose = this.currentPurpose;
        this.cancelScheduledRender();
        this.resetLoadingState();
        if (purpose === 'regenerate' && this.previousActiveLeafId !== null) {
          this.activeLeafId = this.previousActiveLeafId;
        }
        await this.renderHistory();
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

    const assistantMessageId = this.currentAssistantMessageId ?? uid('msg');
    const userMessageId = this.currentUserMessageId;
    const message: PersistedMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: response.content,
      parentId: userMessageId ?? null,
      reasoningSummary: response.reasoningSummary,
      toolCalls: response.toolCalls,
      sources: response.sources,
      tokenUsage: response.usage,
      mode: this.currentMode,
      providerId: this.currentProviderId ?? this.profileId,
      modelId: this.currentModelId,
      promptId: this.currentPromptId,
      searchMeta: response.searchMeta,
      createdAt: nowIso()
    };
    if (!this.messages.some((item) => item.id === message.id)) {
      this.messages.push(message);
    }
    this.activeLeafId = message.id;

    this.resetLoadingState();
    await this.renderHistory();
    this.userPinnedToBottom = true;
    this.scrollToBottom();
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
    this.currentUserMessageId = null;
    this.currentAssistantMessageId = null;
    this.currentProviderId = null;
    this.currentPromptId = null;
    this.currentPurpose = 'send';
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
    this.currentUserMessageId = template.userMessageId ?? null;
    this.currentAssistantMessageId = template.assistantMessageId ?? uid('msg');
    this.currentProviderId = template.providerId;
    this.currentPromptId = template.promptId ?? null;
    this.currentPurpose = template.purpose ?? 'send';
    this.currentModelId = template.modelId;
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
        requestId: this.currentRequestId,
        assistantMessageId: this.currentAssistantMessageId
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
