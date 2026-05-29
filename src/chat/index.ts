import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { PORT_NAME } from '../shared/constants';
import { getStore } from '../shared/storage';
import type {
  ChatRequest,
  ChatSession,
  FeatureSettings,
  PersistedMessage,
  PromptConfig,
  ProviderConfig,
  StreamEvent
} from '../shared/types';
import { escapeHtml, formatUsageLabel, getModel, nowIso, uid } from '../shared/utils';

marked.use(markedKatex({ throwOnError: false }));

type AssistantRenderState = {
  container: HTMLElement;
  content: HTMLElement;
  reasoningWrap: HTMLElement;
  reasoning: HTMLElement;
  toolsWrap: HTMLDetailsElement;
  toolsBody: HTMLElement;
  footer: HTMLElement;
};

class ChatWindowApp {
  private chatId = uid('chat');
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
  private currentMode: PersistedMessage['mode'] = 'chat';

  private elements = {
    messagesContainer: document.getElementById('messagesContainer') as HTMLElement,
    messageInput: document.getElementById('messageInput') as HTMLTextAreaElement,
    sendBtn: document.getElementById('sendBtn') as HTMLButtonElement,
    stopBtn: document.getElementById('stopBtn') as HTMLButtonElement,
    loadingIndicator: document.getElementById('loadingIndicator') as HTMLElement,
    promptSelect: document.getElementById('promptSelect') as HTMLSelectElement,
    profileSelect: document.getElementById('profileSelect') as HTMLSelectElement,
    searchToggle: document.getElementById('searchToggle') as HTMLInputElement,
    streamingToggle: document.getElementById('streamingToggle') as HTMLInputElement,
    statusText: document.getElementById('statusText') as HTMLElement,
    settingsPanel: document.getElementById('settingsPanel') as HTMLElement
  };

  constructor() {
    this.init().catch((error) => {
      this.setStatus(t('chat__statusInitFailed', error instanceof Error ? error.message : String(error)));
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
      if (event.data?.type === 'INIT_CHAT') {
        this.applyInitPayload(event.data);
        return;
      }
      if (event.data?.type === 'TOGGLE_SETTINGS_PANEL') {
        this.toggleSettingsPanel();
      }
    });

    await this.reloadStore();
    this.renderSelectors();
    this.setStatus(t('chat__statusIdle'));
  }

  private async reloadStore() {
    const store = await getStore();
    this.providers = store.providers;
    this.prompts = store.prompts;
    this.featureSettings = store.featureSettings;

    if (!this.profileId) {
      this.profileId = store.featureSettings.defaultProviderId;
    }
    if (!this.promptId) {
      this.promptId = store.featureSettings.defaultPromptId;
    }

    this.elements.searchToggle.checked = store.featureSettings.search.enabledByDefault;
    this.streamingEnabled = store.featureSettings.defaultStreaming;
    this.elements.streamingToggle.checked = this.streamingEnabled;
  }

  private applyInitPayload(payload: {
    chatId?: string;
    profileId?: string | null;
    promptId?: string | null;
    historyMessages?: PersistedMessage[];
    initialMessage?: string;
  }) {
    this.chatId = payload.chatId || this.chatId;
    this.profileId = payload.profileId || this.profileId;
    this.promptId = payload.promptId || this.promptId;

    if (Array.isArray(payload.historyMessages) && payload.historyMessages.length > 0) {
      this.messages = payload.historyMessages;
      this.renderHistory().catch((error) => {
        this.setStatus(t('chat__statusInitFailed', error instanceof Error ? error.message : String(error)));
      });
    }

    if (payload.initialMessage) {
      this.elements.messageInput.value = payload.initialMessage;
      this.adjustTextareaHeight();
    }

    this.renderSelectors();
  }

  private bindEvents() {
    this.elements.sendBtn.addEventListener('click', () => this.sendMessage());
    this.elements.stopBtn.addEventListener('click', () => this.abortCurrentRequest());
    this.elements.messageInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendMessage();
      }
    });
    this.elements.messageInput.addEventListener('input', () => this.adjustTextareaHeight());
    this.elements.profileSelect.addEventListener('change', () => {
      this.profileId = this.elements.profileSelect.value || null;
      this.syncStreamingControl();
    });
    this.elements.promptSelect.addEventListener('change', () => {
      this.promptId = this.elements.promptSelect.value || null;
    });
    this.elements.streamingToggle.addEventListener('change', () => {
      this.streamingEnabled = this.elements.streamingToggle.checked;
    });
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
  }

  private toggleSettingsPanel() {
    this.setSettingsPanelOpen(!this.settingsOpen);
  }

  private setUsageFooter(footer: HTMLElement, usage: PersistedMessage['tokenUsage']) {
    if (!usage) {
      footer.textContent = '';
      footer.style.display = 'none';
      return;
    }
    footer.textContent = formatUsageLabel(usage);
    footer.style.display = '';
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

  private syncStreamingControl() {
    const provider = this.providers.find((item) => item.id === this.profileId);
    const model = provider ? getModel(provider, provider.defaultModel) : null;
    const supported = model?.supportsStreaming ?? true;
    this.elements.streamingToggle.disabled = !supported;
    if (!supported) {
      this.elements.streamingToggle.checked = false;
      return;
    }
    this.elements.streamingToggle.checked = this.streamingEnabled;
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
    const rendered = message.role === 'assistant' ? await marked.parse(message.content) : escapeHtml(message.content).replace(/\n/g, '<br>');
    content.innerHTML = rendered;
    wrapper.appendChild(content);

    if (message.role === 'assistant' && message.tokenUsage) {
      const footer = document.createElement('div');
      footer.className = 'message-footer';
      this.setUsageFooter(footer, message.tokenUsage);
      wrapper.appendChild(footer);
    }

    if (message.sources.length > 0) {
      const sources = document.createElement('div');
      sources.className = 'message-sources';
      sources.innerHTML = message.sources
        .map((source, index) => `<a href="${source.url}" target="_blank" rel="noreferrer">[${index + 1}] ${escapeHtml(source.title)}</a>`)
        .join('');
      wrapper.appendChild(sources);
    }

    return wrapper;
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
    this.scrollToBottom();

    const reasoningWrap = wrapper.querySelector('.message-reasoning') as HTMLElement;
    reasoningWrap.style.display = 'none';
    const toolsWrap = wrapper.querySelector('.message-tools') as HTMLDetailsElement;
    const footer = wrapper.querySelector('.message-footer') as HTMLElement;
    footer.style.display = 'none';

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

    if (!this.profileId) {
      this.setStatus(t('chat__statusCreateProviderFirst'));
      return;
    }

    if (this.elements.searchToggle.checked && !this.featureSettings?.search.tavilyApiKey.trim()) {
      this.setStatus(t('chat__statusConfigureTavilyFirst'));
      return;
    }

    const provider = this.providers.find((item) => item.id === this.profileId);
    const prompt = this.prompts.find((item) => item.id === this.promptId) ?? null;
    if (!provider) {
      this.setStatus(t('chat__statusProviderNotFound'));
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
    this.showLoading(true);
    const model = getModel(provider, provider.defaultModel);
    this.currentModelId = model.modelId;
    const requestMessages = [
      ...(prompt?.content ? [{ role: 'system' as const, content: prompt.content }] : []),
      ...this.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ];

    const request: ChatRequest = {
      requestId: this.currentRequestId,
      chatId: this.chatId,
      providerId: provider.id,
      modelId: model.modelId,
      promptId: prompt?.id ?? null,
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
  }

  private abortCurrentRequest() {
    if (!this.currentRequestId) {
      return;
    }
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
        this.setStatus(event.message);
        break;
      case 'contentDelta':
        if (this.currentAssistantState) {
          this.currentAssistantText += event.delta;
          const rendered = await marked.parse(this.currentAssistantText);
          this.currentAssistantState.content.innerHTML = rendered;
          this.scrollToBottom();
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
          sourceWrap.innerHTML = event.sources
            .map((source, index) => `<a href="${source.url}" target="_blank" rel="noreferrer">[${index + 1}] ${escapeHtml(source.title)}</a>`)
            .join('');
        }
        break;
      case 'usageUpdate':
        if (this.currentAssistantState) {
          this.setUsageFooter(this.currentAssistantState.footer, event.usage);
        }
        break;
      case 'completed':
        await this.finishStream(event.response);
        break;
      case 'aborted':
        this.resetLoadingState();
        break;
      case 'failed':
        this.setStatus(event.error);
        this.resetLoadingState();
        break;
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
    if (this.currentAssistantState) {
      const rendered = await marked.parse(response.content);
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
    this.setStatus(t('chat__statusCompleted'));
    this.resetLoadingState();
  }

  private resetLoadingState() {
    this.isLoading = false;
    this.currentRequestId = null;
    this.currentAssistantState = null;
    this.currentAssistantText = '';
    this.currentReasoningText = '';
    this.currentToolCalls = [];
    this.currentModelId = null;
    this.showLoading(false);
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
    this.elements.messageInput.style.height = `${Math.min(this.elements.messageInput.scrollHeight, 140)}px`;
  }

  private showLoading(active: boolean) {
    this.elements.loadingIndicator.style.display = active ? 'flex' : 'none';
    this.elements.stopBtn.disabled = !active;
    this.elements.sendBtn.disabled = active;
  }

  private setStatus(text: string) {
    this.elements.statusText.textContent = text;
  }

  private scrollToBottom() {
    this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
  }
}

new ChatWindowApp();
