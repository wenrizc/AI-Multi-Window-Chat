import { getStore, saveStore } from '../shared/storage';
import type {
  FeatureSettings,
  PromptConfig,
  ProviderConfig,
  RootStore
} from '../shared/types';
import {
  clampSearchRounds,
  compactText,
  escapeHtml,
  normalizeMaxContextMessages,
  nowIso,
  resolveReasoningFormat,
  toNullableInt,
  toNullableNumber,
  uid,
  writeTextToClipboard
} from '../shared/utils';

type TabName = 'config' | 'search' | 'prompts' | 'history';
type OnboardingPresetId = 'openai' | 'deepseek' | 'qwen';

const ONBOARDING_PRESETS: Record<OnboardingPresetId, {
  name: string;
  baseUrl: string;
  model: string;
  transport: ProviderConfig['transport'];
  reasoningFormat: ProviderConfig['modelCatalog'][number]['reasoningFormat'];
}> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    transport: 'responses',
    reasoningFormat: 'openai_summary'
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    transport: 'chat_completions',
    reasoningFormat: 'none'
  },
  qwen: {
    name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    transport: 'chat_completions',
    reasoningFormat: 'none'
  }
};

const elements = {
  tabs: [...document.querySelectorAll('.tab')] as HTMLButtonElement[],
  tabContents: [...document.querySelectorAll('.tab-content')] as HTMLElement[],
  footer: document.getElementById('footer') as HTMLElement,
  status: document.getElementById('status') as HTMLElement,
  searchStatus: document.getElementById('searchStatus') as HTMLElement,
  promptStatus: document.getElementById('promptStatus') as HTMLElement,
  historyStatus: document.getElementById('historyStatus') as HTMLElement,
  profileList: document.getElementById('profileList') as HTMLElement,
  activeProfileSelect: document.getElementById('activeProfileSelect') as HTMLSelectElement,
  addProfileBtn: document.getElementById('addProfileBtn') as HTMLButtonElement,
  exportProfilesBtn: document.getElementById('exportProfilesBtn') as HTMLButtonElement,
  importProfilesBtn: document.getElementById('importProfilesBtn') as HTMLButtonElement,
  importProfilesInput: document.getElementById('importProfilesInput') as HTMLInputElement,
  saveBtn: document.getElementById('saveBtn') as HTMLButtonElement,
  deleteBtn: document.getElementById('deleteBtn') as HTMLButtonElement,
  setActiveBtn: document.getElementById('setActiveBtn') as HTMLButtonElement,
  testBtn: document.getElementById('testBtn') as HTMLButtonElement,
  toggleApiKeyBtn: document.getElementById('toggleApiKeyBtn') as HTMLButtonElement,
  copyApiKeyBtn: document.getElementById('copyApiKeyBtn') as HTMLButtonElement,
  profileName: document.getElementById('profileName') as HTMLInputElement,
  apiUrl: document.getElementById('apiUrl') as HTMLInputElement,
  apiKey: document.getElementById('apiKey') as HTMLInputElement,
  modelName: document.getElementById('modelName') as HTMLInputElement,
  transportSelect: document.getElementById('transportSelect') as HTMLSelectElement,
  reasoningFormatSelect: document.getElementById('reasoningFormatSelect') as HTMLSelectElement,
  supportsStreamingCheckbox: document.getElementById('supportsStreamingCheckbox') as HTMLInputElement,
  maxContextMessagesInput: document.getElementById('maxContextMessagesInput') as HTMLInputElement,
  temperatureInput: document.getElementById('temperatureInput') as HTMLInputElement,
  tavilyApiKey: document.getElementById('tavilyApiKey') as HTMLInputElement,
  searchDepthSelect: document.getElementById('searchDepthSelect') as HTMLSelectElement,
  timeRangeSelect: document.getElementById('timeRangeSelect') as HTMLSelectElement,
  maxResultsInput: document.getElementById('maxResultsInput') as HTMLInputElement,
  maxRoundsInput: document.getElementById('maxRoundsInput') as HTMLInputElement,
  promptList: document.getElementById('promptList') as HTMLElement,
  addPromptBtn: document.getElementById('addPromptBtn') as HTMLButtonElement,
  exportPromptsBtn: document.getElementById('exportPromptsBtn') as HTMLButtonElement,
  importPromptsBtn: document.getElementById('importPromptsBtn') as HTMLButtonElement,
  importPromptsInput: document.getElementById('importPromptsInput') as HTMLInputElement,
  defaultPromptSelect: document.getElementById('defaultPromptSelect') as HTMLSelectElement,
  promptName: document.getElementById('promptName') as HTMLInputElement,
  promptContent: document.getElementById('promptContent') as HTMLTextAreaElement,
  savePromptBtn: document.getElementById('savePromptBtn') as HTMLButtonElement,
  deletePromptBtn: document.getElementById('deletePromptBtn') as HTMLButtonElement,
  historyList: document.getElementById('historyList') as HTMLElement,
  historySearchInput: document.getElementById('historySearchInput') as HTMLInputElement,
  exportAllBtn: document.getElementById('exportAllBtn') as HTMLButtonElement,
  clearAllBtn: document.getElementById('clearAllBtn') as HTMLButtonElement,
  onboardingModal: document.getElementById('onboardingModal') as HTMLElement,
  onboardingStatus: document.getElementById('onboardingStatus') as HTMLElement,
  onboardingPresetButtons: [...document.querySelectorAll('[data-onboarding-preset]')] as HTMLButtonElement[],
  onboardingApiKey: document.getElementById('onboardingApiKey') as HTMLInputElement,
  onboardingModelName: document.getElementById('onboardingModelName') as HTMLInputElement,
  onboardingSkipBtn: document.getElementById('onboardingSkipBtn') as HTMLButtonElement,
  onboardingSaveTestBtn: document.getElementById('onboardingSaveTestBtn') as HTMLButtonElement,
  exportModal: document.getElementById('exportModal') as HTMLElement,
  confirmModal: document.getElementById('confirmModal') as HTMLElement,
  confirmText: document.getElementById('confirmText') as HTMLElement,
  confirmBtn: document.getElementById('confirmBtn') as HTMLButtonElement,
  confirmCancelBtn: document.getElementById('confirmCancelBtn') as HTMLButtonElement
};

class PopupApp {
  private store!: RootStore;
  private selectedProviderId: string | null = null;
  private selectedPromptId: string | null = null;
  private confirmAction: (() => void | Promise<void>) | null = null;
  private currentExportTarget: 'providers' | 'prompts' | 'history' = 'history';
  private currentExportChatId: string | 'all' = 'all';
  private apiKeyVisible = false;
  private onboardingPresetId: OnboardingPresetId = 'openai';
  private historySearchTerm = '';

  async init() {
    document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
    if (typeof updatePageTranslations === 'function') {
      updatePageTranslations();
    }
    const manifest = chrome.runtime.getManifest();
    elements.footer.textContent = t('popup__footerVersion', manifest.version);

    this.bindEvents();
    this.store = await getStore();
    this.enforceFixedDefaults();
    this.selectedProviderId = this.store.featureSettings.defaultProviderId ?? this.store.providers[0]?.id ?? null;
    this.selectedPromptId = this.store.featureSettings.defaultPromptId ?? this.store.prompts[0]?.id ?? null;
    this.renderAll();
    this.maybeShowOnboarding();
  }

  private bindEvents() {
    elements.tabs.forEach((tab) => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab as TabName));
    });
    elements.addProfileBtn.addEventListener('click', () => this.createProvider());
    elements.saveBtn.addEventListener('click', () => this.saveProvider());
    elements.deleteBtn.addEventListener('click', () => this.confirmDeleteProvider());
    elements.setActiveBtn.addEventListener('click', () => this.setDefaultProvider());
    elements.testBtn.addEventListener('click', () => this.testProvider());
    elements.exportProfilesBtn.addEventListener('click', () => {
      this.currentExportTarget = 'providers';
      this.openModal(elements.exportModal);
    });
    elements.importProfilesBtn.addEventListener('click', () => elements.importProfilesInput.click());
    elements.importProfilesInput.addEventListener('change', () => this.importProviders());
    elements.activeProfileSelect.addEventListener('change', () => {
      this.store.featureSettings.defaultProviderId = elements.activeProfileSelect.value || null;
      this.persist();
    });
    document.querySelectorAll<HTMLElement>('.preset-btn').forEach((button) => {
      button.addEventListener('click', () => {
        elements.apiUrl.value = button.dataset.url || '';
      });
    });
    elements.profileList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!target) return;
      this.selectedProviderId = target.dataset.id || null;
      this.renderProviders();
      this.fillProviderForm();
    });

    elements.toggleApiKeyBtn.addEventListener('click', () => {
      this.apiKeyVisible = !this.apiKeyVisible;
      elements.apiKey.type = this.apiKeyVisible ? 'text' : 'password';
      elements.toggleApiKeyBtn.textContent = this.apiKeyVisible ? t('popup__btnHideKey') : t('popup__btnShowKey');
    });
    elements.copyApiKeyBtn.addEventListener('click', async () => {
      const copied = await writeTextToClipboard(elements.apiKey.value);
      if (copied) {
        this.showStatus(elements.status, t('popup__statusCopied'), 'success');
      }
    });

    [
      elements.tavilyApiKey,
      elements.searchDepthSelect,
      elements.timeRangeSelect,
      elements.maxResultsInput,
      elements.maxRoundsInput
    ].forEach((element) => {
      element.addEventListener('change', () => {
        this.saveSearchSettings().catch((error) => console.error(error));
      });
    });

    elements.addPromptBtn.addEventListener('click', () => this.createPrompt());
    elements.savePromptBtn.addEventListener('click', () => this.savePrompt());
    elements.deletePromptBtn.addEventListener('click', () => this.confirmDeletePrompt());
    elements.exportPromptsBtn.addEventListener('click', () => {
      this.currentExportTarget = 'prompts';
      this.openModal(elements.exportModal);
    });
    elements.importPromptsBtn.addEventListener('click', () => elements.importPromptsInput.click());
    elements.importPromptsInput.addEventListener('change', () => this.importPrompts());
    elements.defaultPromptSelect.addEventListener('change', () => {
      this.store.featureSettings.defaultPromptId = elements.defaultPromptSelect.value || null;
      this.persist();
    });
    elements.promptList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!target) return;
      this.selectedPromptId = target.dataset.id || null;
      this.renderPrompts();
      this.fillPromptForm();
    });

    elements.exportAllBtn.addEventListener('click', () => {
      this.currentExportTarget = 'history';
      this.currentExportChatId = 'all';
      this.openModal(elements.exportModal);
    });
    elements.clearAllBtn.addEventListener('click', () => this.confirm(t('history__confirmDeleteAll'), async () => {
      this.store.chatHistory = [];
      await this.persist();
      this.renderHistory();
      this.showStatus(elements.historyStatus, t('history__successCleared'), 'success');
    }));
    elements.historyList.addEventListener('click', (event) => this.handleHistoryAction(event));
    elements.historySearchInput.addEventListener('input', () => {
      this.historySearchTerm = elements.historySearchInput.value.trim();
      this.renderHistory();
    });
    elements.onboardingPresetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        this.selectOnboardingPreset((button.dataset.onboardingPreset || 'openai') as OnboardingPresetId);
      });
    });
    elements.onboardingSkipBtn.addEventListener('click', () => {
      this.closeModal('onboardingModal');
      elements.profileName.focus();
    });
    elements.onboardingSaveTestBtn.addEventListener('click', () => {
      this.completeOnboarding().catch((error) => {
        this.showStatus(elements.onboardingStatus, getErrorText(error), 'error');
      });
    });
    document.querySelectorAll('.modal-close').forEach((button) => {
      button.addEventListener('click', () => this.closeModal((button as HTMLElement).dataset.modal || ''));
    });
    document.querySelectorAll('.export-option').forEach((option) => {
      option.addEventListener('click', () => this.exportCurrent((option as HTMLElement).dataset.format || 'markdown'));
    });
    elements.confirmBtn.addEventListener('click', async () => {
      if (this.confirmAction) {
        await this.confirmAction();
      }
      this.closeModal('confirmModal');
    });
    elements.confirmCancelBtn.addEventListener('click', () => this.closeModal('confirmModal'));
  }

  private maybeShowOnboarding() {
    if (this.store.providers.length > 0) {
      return;
    }
    this.selectOnboardingPreset(this.onboardingPresetId);
    this.openModal(elements.onboardingModal);
  }

  private selectOnboardingPreset(presetId: OnboardingPresetId) {
    const preset = ONBOARDING_PRESETS[presetId] ?? ONBOARDING_PRESETS.openai;
    this.onboardingPresetId = presetId in ONBOARDING_PRESETS ? presetId : 'openai';
    elements.onboardingPresetButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.onboardingPreset === this.onboardingPresetId);
    });
    elements.onboardingModelName.value = preset.model;
    this.showOnboardingPreview(preset);
  }

  private showOnboardingPreview(preset: (typeof ONBOARDING_PRESETS)[OnboardingPresetId]) {
    elements.profileName.value = preset.name;
    elements.apiUrl.value = preset.baseUrl;
    elements.modelName.value = preset.model;
    elements.transportSelect.value = preset.transport;
    elements.reasoningFormatSelect.value = preset.reasoningFormat;
    elements.supportsStreamingCheckbox.checked = true;
    elements.maxContextMessagesInput.value = '';
    elements.temperatureInput.value = '';
  }

  private async completeOnboarding() {
    const provider = this.buildOnboardingProvider();
    if (!provider.apiKey || !provider.defaultModel) {
      this.showStatus(elements.onboardingStatus, t('onboarding__statusMissingFields'), 'error');
      return;
    }

    elements.onboardingSaveTestBtn.disabled = true;
    this.showStatus(elements.onboardingStatus, t('onboarding__statusTesting'), 'success');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_PROVIDER',
        provider
      });
      if (!response?.success) {
        throw new Error(response?.error || t('common__unknownError'));
      }

      this.store.providers.unshift(provider);
      this.store.featureSettings.defaultProviderId = provider.id;
      this.selectedProviderId = provider.id;
      await this.persist();
      this.closeModal('onboardingModal');
      try {
        await this.openOnboardingSampleChat();
        this.showStatus(elements.status, t('onboarding__statusReady'), 'success');
      } catch {
        this.showStatus(elements.status, t('onboarding__statusSavedOpenFailed'), 'error');
      }
    } catch (error) {
      this.showStatus(elements.onboardingStatus, t('popup__statusTestFailed', getErrorText(error)), 'error');
    } finally {
      elements.onboardingSaveTestBtn.disabled = false;
    }
  }

  private buildOnboardingProvider(): ProviderConfig {
    const preset = ONBOARDING_PRESETS[this.onboardingPresetId] ?? ONBOARDING_PRESETS.openai;
    const now = nowIso();
    const modelId = elements.onboardingModelName.value.trim() || preset.model;
    return {
      id: uid('provider'),
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: elements.onboardingApiKey.value.trim(),
      transport: preset.transport,
      defaultModel: modelId,
      defaultGenerationParams: {
        temperature: null
      },
      headers: {},
      modelCatalog: [
        {
          modelId,
          displayName: modelId,
          supportsStreaming: true,
          maxContextMessages: null,
          reasoningFormat: preset.reasoningFormat
        }
      ],
      createdAt: now,
      updatedAt: now
    };
  }

  private async openOnboardingSampleChat() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error(t('history__errorOpenFailed') + t('common__unknownError'));
    }
    await chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_CHAT_WINDOW',
      initialMessage: t('onboarding__samplePrompt')
    });
  }

  private switchTab(name: TabName) {
    elements.tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
    elements.tabContents.forEach((content) => content.classList.toggle('active', content.id === `${name}Tab`));
  }

  private async persist() {
    this.enforceFixedDefaults();
    await saveStore(this.store);
    this.renderAll();
  }

  private enforceFixedDefaults() {
    this.store.featureSettings.search.enabledByDefault = false;
    this.store.featureSettings.defaultStreaming = false;
    this.store.providers.forEach((provider) => {
      provider.modelCatalog.forEach((model) => {
        if (typeof model.supportsStreaming !== 'boolean') {
          model.supportsStreaming = true;
        }
        if (model.maxContextMessages === undefined) {
          model.maxContextMessages = null;
        }
      });
    });
  }

  private renderAll() {
    this.renderProviders();
    this.fillProviderForm();
    this.fillSearchForm();
    this.renderPrompts();
    this.fillPromptForm();
    this.renderHistory();
  }

  private renderProviders() {
    if (this.store.providers.length === 0) {
      elements.profileList.innerHTML = `<div class="history-empty">${escapeHtml(t('popup__emptyProviders'))}</div>`;
      elements.activeProfileSelect.innerHTML = `<option value="">${escapeHtml(t('common__none'))}</option>`;
      return;
    }

    elements.profileList.innerHTML = this.store.providers.map((provider) => `
      <button class="profile-item ${provider.id === this.selectedProviderId ? 'active' : ''} ${provider.id === this.store.featureSettings.defaultProviderId ? 'current' : ''}" data-id="${provider.id}">
        <span class="profile-dot"></span>
        <span class="profile-name">${escapeHtml(provider.name)}</span>
      </button>
    `).join('');

    elements.activeProfileSelect.innerHTML = this.store.providers
      .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`)
      .join('');
    elements.activeProfileSelect.value = this.store.featureSettings.defaultProviderId ?? this.store.providers[0]?.id ?? '';
  }

  private fillProviderForm() {
    const provider = this.store.providers.find((item) => item.id === this.selectedProviderId);
    if (!provider) {
      this.clearProviderForm();
      return;
    }
    const model = provider.modelCatalog[0];
    elements.profileName.value = provider.name;
    elements.apiUrl.value = provider.baseUrl;
    elements.apiKey.value = provider.apiKey;
    elements.modelName.value = model?.modelId ?? provider.defaultModel;
    elements.transportSelect.value = provider.transport;
    elements.reasoningFormatSelect.value = model?.reasoningFormat ?? 'none';
    elements.supportsStreamingCheckbox.checked = model?.supportsStreaming ?? true;
    elements.maxContextMessagesInput.value = model?.maxContextMessages === null || model?.maxContextMessages === undefined
      ? ''
      : String(model.maxContextMessages);
    elements.temperatureInput.value = provider.defaultGenerationParams.temperature?.toString() ?? '';
  }

  private clearProviderForm() {
    [
      elements.profileName,
      elements.apiUrl,
      elements.apiKey,
      elements.modelName,
      elements.maxContextMessagesInput,
      elements.temperatureInput
    ].forEach((input) => { input.value = ''; });
    elements.transportSelect.value = 'chat_completions';
    elements.reasoningFormatSelect.value = 'none';
    elements.supportsStreamingCheckbox.checked = true;
  }

  private fillSearchForm() {
    const search = this.store.featureSettings.search;
    elements.tavilyApiKey.value = search.tavilyApiKey;
    elements.searchDepthSelect.value = search.searchDepth;
    elements.timeRangeSelect.value = search.timeRange ?? '';
    elements.maxResultsInput.value = String(search.maxResults);
    elements.maxRoundsInput.value = String(search.maxRounds);
  }

  private async saveSearchSettings() {
    this.store.featureSettings.search = {
      tavilyApiKey: elements.tavilyApiKey.value.trim(),
      enabledByDefault: false,
      searchDepth: elements.searchDepthSelect.value as 'basic' | 'advanced',
      timeRange: (elements.timeRangeSelect.value || null) as 'day' | 'week' | 'month' | 'year' | null,
      maxResults: Math.max(1, toNullableInt(elements.maxResultsInput.value) ?? 5),
      maxRounds: clampSearchRounds(toNullableInt(elements.maxRoundsInput.value))
    };
    this.store.featureSettings.defaultStreaming = false;
    await saveStore(this.store);
    this.showStatus(elements.searchStatus, t('popup__statusSaved'), 'success');
  }

  private createProvider() {
    const id = uid('provider');
    const now = nowIso();
    const provider: ProviderConfig = {
      id,
      name: t('popup__defaultProfileName', this.store.providers.length + 1),
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      transport: 'chat_completions',
      defaultModel: '',
      defaultGenerationParams: {
        temperature: null
      },
      headers: {},
      modelCatalog: [
        {
          modelId: '',
          displayName: '',
          supportsStreaming: true,
          maxContextMessages: null,
          reasoningFormat: 'none'
        }
      ],
      createdAt: now,
      updatedAt: now
    };
    this.store.providers.unshift(provider);
    this.selectedProviderId = id;
    if (!this.store.featureSettings.defaultProviderId) {
      this.store.featureSettings.defaultProviderId = id;
    }
    this.persist();
  }

  private async saveProvider() {
    const now = nowIso();
    const providerId = this.selectedProviderId ?? uid('provider');
    const current = this.store.providers.find((item) => item.id === providerId);
    const provider: ProviderConfig = {
      id: providerId,
      name: elements.profileName.value.trim() || t('popup__untitledProvider'),
      baseUrl: elements.apiUrl.value.trim(),
      apiKey: elements.apiKey.value.trim(),
      transport: elements.transportSelect.value as ProviderConfig['transport'],
      defaultModel: elements.modelName.value.trim(),
      defaultGenerationParams: {
        temperature: toNullableNumber(elements.temperatureInput.value)
      },
      headers: {},
      modelCatalog: [
        {
          modelId: elements.modelName.value.trim(),
          displayName: elements.modelName.value.trim(),
          supportsStreaming: elements.supportsStreamingCheckbox.checked,
          maxContextMessages: normalizeMaxContextMessages(elements.maxContextMessagesInput.value),
          reasoningFormat: resolveReasoningFormat(elements.reasoningFormatSelect.value)
        }
      ],
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };
    const index = this.store.providers.findIndex((item) => item.id === providerId);
    if (index >= 0) {
      this.store.providers[index] = provider;
    } else {
      this.store.providers.unshift(provider);
    }
    this.selectedProviderId = providerId;
    if (!this.store.featureSettings.defaultProviderId) {
      this.store.featureSettings.defaultProviderId = providerId;
    }
    await this.persist();
      this.showStatus(elements.status, t('popup__statusSaved'), 'success');
  }

  private confirmDeleteProvider() {
    const provider = this.store.providers.find((item) => item.id === this.selectedProviderId);
    if (!provider) return;
    this.confirm(t('popup__confirmDeleteProfile', provider.name), async () => {
      this.store.providers = this.store.providers.filter((item) => item.id !== provider.id);
      this.selectedProviderId = this.store.providers[0]?.id ?? null;
      if (this.store.featureSettings.defaultProviderId === provider.id) {
        this.store.featureSettings.defaultProviderId = this.selectedProviderId;
      }
      await this.persist();
      this.showStatus(elements.status, t('popup__statusDeleted'), 'success');
    });
  }

  private async setDefaultProvider() {
    this.store.featureSettings.defaultProviderId = this.selectedProviderId;
    await this.persist();
    this.showStatus(elements.status, t('popup__statusSetActive'), 'success');
  }

  private async testProvider() {
    const provider = this.store.providers.find((item) => item.id === this.selectedProviderId);
    if (!provider) return;
    const response = await chrome.runtime.sendMessage({
      type: 'TEST_PROVIDER',
      provider
    });
    if (response?.success) {
      this.showStatus(elements.status, t('popup__statusTestSuccess'), 'success');
    } else {
      this.showStatus(elements.status, t('popup__statusTestFailed', response?.error || t('common__unknownError')), 'error');
    }
  }

  private async importProviders() {
    const file = elements.importProfilesInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    elements.importProfilesInput.value = '';
    const parsed = parseImportPayload(text) as { providers?: ProviderConfig[]; featureSettings?: FeatureSettings };
    if (Array.isArray(parsed.providers)) {
      this.confirm(t('popup__confirmImportReplace'), async () => {
        this.store.providers = parsed.providers ? [...parsed.providers] : [];
        if (parsed.featureSettings) {
          this.store.featureSettings = parsed.featureSettings;
        }
        this.enforceFixedDefaults();
        this.selectedProviderId = this.store.providers[0]?.id ?? null;
        await this.persist();
        this.showStatus(
          elements.status,
          t('config__statusImported', {
            addedCount: String(this.store.providers.length),
            updatedCount: '0'
          }),
          'success'
        );
      });
    }
  }

  private renderPrompts() {
    if (this.store.prompts.length === 0) {
      elements.promptList.innerHTML = `<div class="history-empty">${escapeHtml(t('prompt__emptyState'))}</div>`;
      elements.defaultPromptSelect.innerHTML = `<option value="">${escapeHtml(t('prompt__noPrompt'))}</option>`;
      return;
    }
    elements.promptList.innerHTML = this.store.prompts.map((prompt) => `
      <button class="profile-item ${prompt.id === this.selectedPromptId ? 'active' : ''} ${prompt.id === this.store.featureSettings.defaultPromptId ? 'current' : ''}" data-id="${prompt.id}">
        <span class="profile-dot"></span>
        <span class="profile-name">${escapeHtml(prompt.name)}</span>
      </button>
    `).join('');
    elements.defaultPromptSelect.innerHTML = `<option value="">${escapeHtml(t('prompt__noPrompt'))}</option>` + this.store.prompts
      .map((prompt) => `<option value="${prompt.id}">${escapeHtml(prompt.name)}</option>`)
      .join('');
    elements.defaultPromptSelect.value = this.store.featureSettings.defaultPromptId ?? '';
  }

  private fillPromptForm() {
    const prompt = this.store.prompts.find((item) => item.id === this.selectedPromptId);
    elements.promptName.value = prompt?.name ?? '';
    elements.promptContent.value = prompt?.content ?? '';
  }

  private createPrompt() {
    const now = nowIso();
    const prompt: PromptConfig = {
      id: uid('prompt'),
      name: t('prompt__defaultName', this.store.prompts.length + 1),
      content: '',
      createdAt: now,
      updatedAt: now
    };
    this.store.prompts.unshift(prompt);
    this.selectedPromptId = prompt.id;
    this.persist();
  }

  private async savePrompt() {
    const now = nowIso();
    const promptId = this.selectedPromptId ?? uid('prompt');
    const existing = this.store.prompts.find((item) => item.id === promptId);
    const prompt: PromptConfig = {
      id: promptId,
      name: elements.promptName.value.trim() || t('prompt__untitled'),
      content: elements.promptContent.value.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const index = this.store.prompts.findIndex((item) => item.id === promptId);
    if (index >= 0) {
      this.store.prompts[index] = prompt;
    } else {
      this.store.prompts.unshift(prompt);
    }
    this.selectedPromptId = promptId;
    await this.persist();
      this.showStatus(elements.promptStatus, t('prompt__statusSaved'), 'success');
  }

  private confirmDeletePrompt() {
    const prompt = this.store.prompts.find((item) => item.id === this.selectedPromptId);
    if (!prompt) return;
    this.confirm(t('prompt__confirmDelete', prompt.name), async () => {
      this.store.prompts = this.store.prompts.filter((item) => item.id !== prompt.id);
      this.selectedPromptId = this.store.prompts[0]?.id ?? null;
      if (this.store.featureSettings.defaultPromptId === prompt.id) {
        this.store.featureSettings.defaultPromptId = null;
      }
      await this.persist();
      this.showStatus(elements.promptStatus, t('prompt__statusDeleted'), 'success');
    });
  }

  private async importPrompts() {
    const file = elements.importPromptsInput.files?.[0];
    if (!file) return;
    const parsed = parseImportPayload(await file.text()) as { prompts?: PromptConfig[]; defaultPromptId?: string | null };
    elements.importPromptsInput.value = '';
    if (Array.isArray(parsed.prompts)) {
      this.confirm(t('popup__confirmImportReplace'), async () => {
        this.store.prompts = parsed.prompts ? [...parsed.prompts] : [];
        this.store.featureSettings.defaultPromptId = parsed.defaultPromptId ?? this.store.prompts[0]?.id ?? null;
        this.selectedPromptId = this.store.prompts[0]?.id ?? null;
        await this.persist();
        this.showStatus(
          elements.promptStatus,
          t('config__statusImported', {
            addedCount: String(this.store.prompts.length),
            updatedCount: '0'
          }),
          'success'
        );
      });
    }
  }

  private renderHistory() {
    if (this.store.chatHistory.length === 0) {
      elements.historyList.innerHTML = `<div class="history-empty"><div class="history-empty-icon">💬</div><div>${escapeHtml(t('history__empty'))}</div></div>`;
      return;
    }
    const filteredHistory = this.getFilteredHistory();
    if (filteredHistory.length === 0) {
      elements.historyList.innerHTML = `<div class="history-empty"><div class="history-empty-icon">🔎</div><div>${escapeHtml(t('history__searchNoResults'))}</div></div>`;
      return;
    }
    elements.historyList.innerHTML = filteredHistory.map((chat) => `
      <div class="history-item" data-id="${chat.chatId}">
        <div class="history-item-header">
          <div class="history-item-icon">💬</div>
          <div class="history-item-title">${escapeHtml(chat.title)}</div>
        </div>
        <div class="history-item-meta">${new Date(chat.updatedAt).toLocaleString()} · ${escapeHtml(t('history__messageCount', chat.messages.length))}</div>
        <div class="history-item-summary">${escapeHtml(this.getHistorySummary(chat))}</div>
        <div class="history-item-actions">
          <button class="btn btn-secondary btn-small" data-action="resume" data-id="${chat.chatId}">${escapeHtml(t('history__btnResume'))}</button>
          <button class="btn btn-secondary btn-small" data-action="export" data-id="${chat.chatId}">${escapeHtml(t('history__btnExport'))}</button>
          <button class="btn btn-danger btn-small" data-action="delete" data-id="${chat.chatId}">${escapeHtml(t('history__btnDelete'))}</button>
        </div>
      </div>
    `).join('');
  }

  private getFilteredHistory() {
    const query = compactText(this.historySearchTerm)?.toLowerCase();
    if (!query) {
      return this.store.chatHistory;
    }

    return this.store.chatHistory.filter((chat) => {
      const haystack = [
        chat.title,
        chat.providerId ?? '',
        chat.promptId ?? '',
        this.getHistorySummary(chat),
        ...chat.messages.flatMap((message) => [
          message.content,
          message.modelId ?? ''
        ])
      ].join('\n').toLowerCase();
      return haystack.includes(query);
    });
  }

  private getHistorySummary(chat: RootStore['chatHistory'][number]) {
    const candidate = [...chat.messages].reverse().find((message) => compactText(message.content));
    return compactText(candidate?.content)?.replace(/\s+/g, ' ').slice(0, 120) || chat.title;
  }

  private async handleHistoryAction(event: Event) {
    const button = (event.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!button) return;
    const action = button.dataset.action;
    const chatId = button.dataset.id || '';
    if (action === 'resume') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const chat = this.store.chatHistory.find((item) => item.chatId === chatId);
      if (!tab?.id || !chat) {
        this.showStatus(elements.historyStatus, t('history__errorOpenFailed') + t('common__unknownError'), 'error');
        return;
      }
      await chrome.tabs.sendMessage(tab.id, {
        type: 'OPEN_CHAT_WINDOW',
        chat
      });
      this.showStatus(elements.historyStatus, t('history__successWindowOpened'), 'success');
      return;
    }
    if (action === 'export') {
      this.currentExportTarget = 'history';
      this.currentExportChatId = chatId;
      this.openModal(elements.exportModal);
      return;
    }
    if (action === 'delete') {
      const chat = this.store.chatHistory.find((item) => item.chatId === chatId);
      this.confirm(t('history__confirmDeleteItem', chat?.title || chatId), async () => {
        this.store.chatHistory = this.store.chatHistory.filter((item) => item.chatId !== chatId);
        await this.persist();
        this.showStatus(elements.historyStatus, t('history__successDeleted'), 'success');
      });
    }
  }

  private exportCurrent(format: string) {
    if (this.currentExportTarget === 'providers') {
      this.exportPayload(format, 'providers-v2', {
        providers: this.store.providers,
        featureSettings: this.store.featureSettings
      });
      this.closeModal('exportModal');
      this.showStatus(elements.status, t('history__successExported'), 'success');
      return;
    }

    if (this.currentExportTarget === 'prompts') {
      this.exportPayload(format, 'prompts-v2', {
        prompts: this.store.prompts,
        defaultPromptId: this.store.featureSettings.defaultPromptId
      });
      this.closeModal('exportModal');
      this.showStatus(elements.promptStatus, t('history__successExported'), 'success');
      return;
    }

    this.exportHistory(format);
  }

  private exportHistory(format: string) {
    const chats = this.currentExportChatId === 'all'
      ? this.store.chatHistory
      : this.store.chatHistory.filter((item) => item.chatId === this.currentExportChatId);
    if (format === 'json') {
      this.downloadFile('chat-history.json', JSON.stringify({ chatHistory: chats }, null, 2), 'application/json;charset=utf-8');
    } else {
      this.downloadFile('chat-history.md', this.exportAsMarkdown(chats), 'text/markdown;charset=utf-8');
    }
    this.closeModal('exportModal');
    this.showStatus(elements.historyStatus, t('history__successExported'), 'success');
  }

  private exportAsMarkdown(chats: RootStore['chatHistory']) {
    return chats.map((chat) => {
      const lines = [`# ${chat.title}`, '', `${t('export__updatedAt')}: ${chat.updatedAt}`, ''];
      for (const message of chat.messages) {
        lines.push(`## ${message.role === 'user' ? t('chat__roleUser') : t('chat__roleAI')}`);
        lines.push('');
        lines.push(message.content);
        lines.push('');
        if (message.sources.length > 0) {
          lines.push(`${t('export__sources')}:`);
          message.sources.forEach((source, index) => lines.push(`${index + 1}. ${source.title} - ${source.url}`));
          lines.push('');
        }
      }
      return lines.join('\n');
    }).join('\n\n---\n\n');
  }

  private confirm(text: string, action: () => void | Promise<void>) {
    elements.confirmText.textContent = text;
    this.confirmAction = action;
    this.openModal(elements.confirmModal);
  }

  private openModal(modal: HTMLElement) {
    modal.classList.add('show');
  }

  private closeModal(id: string) {
    document.getElementById(id)?.classList.remove('show');
  }

  private showStatus(target: HTMLElement, text: string, type: 'success' | 'error') {
    target.textContent = text;
    target.className = `status show ${type}`;
    window.setTimeout(() => target.classList.remove('show'), 2200);
  }

  private exportPayload(format: string, basename: string, payload: unknown) {
    if (format === 'json') {
      this.downloadFile(`${basename}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
      return;
    }
    this.downloadFile(`${basename}.md`, formatPayloadMarkdown(basename, payload), 'text/markdown;charset=utf-8');
  }

  private downloadFile(name: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  }
}

function parseImportPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  const fencedJson = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) {
    return JSON.parse(fencedJson[1].trim());
  }

  throw new Error('Unsupported import format.');
}

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || t('common__unknownError'));
}

function formatPayloadMarkdown(title: string, payload: unknown): string {
  return [
    `# ${title}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    ''
  ].join('\n');
}

new PopupApp().init().catch((error) => {
  console.error(error);
});
