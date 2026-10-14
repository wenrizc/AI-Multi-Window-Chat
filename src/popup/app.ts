import { createPopupElements } from './dom';
import { ProviderForm, type ProviderDraft } from './features/provider-form';
import { SearchSettingsForm } from './features/search-settings';
import { HistoryView } from './features/history-view';
import { renderProfileList } from './components/profile-list';
import { StatusMessages } from './components/status';
import { Tabs } from './components/tabs';
import { parseImportPayload, resolveImportedDefaultProviderId, resolveImportedPromptId,
  normalizeImportedSearchSettings, getErrorText, formatBytes, exportAsMarkdown,
  exportPayload, downloadFile, type ProviderImportPayload } from './features/transfers';
import {
  clearChatSessions,
  deleteChatSession,
  getStorageUsage,
  getStore,
  saveConfig
} from '../shared/storage';
import { isStorageQuotaError } from '../shared/errors';
import { normalizeCustomReasoningEfforts } from '../shared/reasoning';
import type {
  FeatureSettings,
  PromptConfig,
  ProviderConfig,
  RootStore,
  SearchSettings,
  StorageConfig
} from '../shared/types';
import { mergePromptsForImport, mergeProvidersForImport } from '../shared/imports';
import {
  clampSearchRounds,
  normalizeCustomHeaders,
  nowIso,
  resolveReasoningFormat,
  toNullableNumber,
  uid,
  writeTextToClipboard
} from '../shared/utils';

type OnboardingPresetId = 'openai' | 'deepseek';

const PROVIDER_DRAFTS_KEY = 'ui_provider_drafts_v1';
const PROMPT_DRAFTS_KEY = 'ui_prompt_drafts_v1';

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
  }
};

export class PopupApp {
  private readonly elements = createPopupElements();
  private readonly providerForm = new ProviderForm(this.elements);
  private readonly searchForm = new SearchSettingsForm(this.elements);
  private readonly historyView = new HistoryView(this.elements.historyList);
  private readonly feedback = new StatusMessages();
  private readonly tabs = new Tabs(this.elements.tabs, this.elements.tabContents);
  private store!: RootStore;
  private selectedProviderId: string | null = null;
  private selectedPromptId: string | null = null;
  private confirmAction: (() => void | Promise<void>) | null = null;
  private currentExportTarget: 'providers' | 'prompts' | 'history' = 'history';
  private currentExportChatId: string | 'all' = 'all';
  private apiKeyVisible = false;
  private onboardingPresetId: OnboardingPresetId = 'openai';
  private historySearchTerm = '';
  private confirmActionInFlight = false;
  private providerDrafts: Record<string, ProviderDraft> = {};
  private promptDrafts: Record<string, { name: string; content: string; updatedAt: string }> = {};
  private draftSaveTimer: number | null = null;
  private testingProvider = false;
  private readonly handlePageHide = () => {
    if (this.draftSaveTimer !== null) {
      void chrome.storage.local.set({ [PROVIDER_DRAFTS_KEY]: this.providerDrafts });
    }
    this.dispose();
  };

  dispose() {
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = null;
    this.feedback.dispose();
    window.removeEventListener('pagehide', this.handlePageHide);
  }

  async init() {
    window.addEventListener('pagehide', this.handlePageHide, { once: true });
    const fullSettings = new URLSearchParams(window.location.search).get('view') === 'settings';
    document.body.dataset.view = fullSettings ? 'settings' : 'popup';
    document.body.classList.toggle('settings-page', fullSettings);
    if (typeof updatePageTranslations === 'function') {
      updatePageTranslations();
    }
    const manifest = chrome.runtime.getManifest();
    this.elements.footer.textContent = t('popup__footerVersion', manifest.version);

    this.bindEvents();
    this.store = await getStore();
    await this.loadProviderDrafts();
    this.enforceFixedDefaults();
    this.selectedProviderId = this.store.featureSettings.defaultProviderId ?? this.store.providers[0]?.id ?? null;
    this.selectedPromptId = this.store.featureSettings.defaultPromptId ?? this.store.prompts[0]?.id ?? null;
    this.renderAll();
    await this.refreshStorageUsage();
    this.maybeShowOnboarding();
  }

  private async loadProviderDrafts() {
    const result = await chrome.storage.local.get([PROVIDER_DRAFTS_KEY, PROMPT_DRAFTS_KEY]);
    const drafts = result[PROVIDER_DRAFTS_KEY];
    if (drafts && typeof drafts === 'object') {
      this.providerDrafts = drafts as Record<string, ProviderDraft>;
    }
    const promptDrafts = result[PROMPT_DRAFTS_KEY];
    if (promptDrafts && typeof promptDrafts === 'object') {
      this.promptDrafts = promptDrafts as Record<string, { name: string; content: string; updatedAt: string }>;
    }
  }

  private bindEvents() {
    this.tabs.bind();
    this.elements.addProfileBtn.addEventListener('click', () => {
      void this.createProvider().catch((error) => this.feedback.show(this.elements.status, getErrorText(error), 'error'));
    });
    this.elements.saveBtn.addEventListener('click', () => {
      void this.saveProvider().catch((error) => this.feedback.show(this.elements.status, getErrorText(error), 'error'));
    });
    this.elements.deleteBtn.addEventListener('click', () => this.confirmDeleteProvider());
    this.elements.setActiveBtn.addEventListener('click', () => {
      void this.setDefaultProvider().catch((error) => this.feedback.show(this.elements.status, getErrorText(error), 'error'));
    });
    this.elements.testBtn.addEventListener('click', () => this.testProvider());
    this.elements.exportProfilesBtn.addEventListener('click', () => {
      this.currentExportTarget = 'providers';
      this.openModal(this.elements.exportModal);
    });
    this.elements.importProfilesBtn.addEventListener('click', () => this.elements.importProfilesInput.click());
    this.elements.openSettingsBtn.addEventListener('click', () => {
      if (chrome.runtime.openOptionsPage) {
        void chrome.runtime.openOptionsPage();
      }
    });
    this.elements.importProfilesInput.addEventListener('change', () => {
      void this.importProviders().catch((error) => this.feedback.show(this.elements.status, getErrorText(error), 'error'));
    });
    this.elements.activeProfileSelect.addEventListener('change', () => {
      this.store.featureSettings.defaultProviderId = this.elements.activeProfileSelect.value || null;
      void this.persist().catch((error) => this.feedback.show(this.elements.status, getErrorText(error), 'error'));
    });
    document.querySelectorAll<HTMLElement>('.preset-btn').forEach((button) => {
      button.addEventListener('click', () => {
        this.elements.apiUrl.value = button.dataset.url || '';
      });
    });
    this.elements.profileList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!target) return;
      this.selectedProviderId = target.dataset.id || null;
      this.renderProviders();
      this.providerForm.fill(this.store.providers.find(item => item.id === this.selectedProviderId), this.selectedProviderId ? this.providerDrafts[this.selectedProviderId] : undefined);
    });

    const draftFields = [
      this.elements.profileName, this.elements.apiUrl, this.elements.apiKey, this.elements.modelName,
      this.elements.authModeSelect, this.elements.transportSelect, this.elements.reasoningFormatSelect,
      this.elements.customEffortsInput, this.elements.supportsStreamingCheckbox, this.elements.temperatureInput
    ];
    draftFields.forEach((field) => {
      field.addEventListener('input', () => this.scheduleProviderDraftSave());
      field.addEventListener('change', () => this.scheduleProviderDraftSave());
    });
    this.elements.headerRows.addEventListener('input', () => this.scheduleProviderDraftSave());

    this.elements.toggleApiKeyBtn.addEventListener('click', () => {
      this.apiKeyVisible = !this.apiKeyVisible;
      this.elements.apiKey.type = this.apiKeyVisible ? 'text' : 'password';
      this.elements.toggleApiKeyBtn.textContent = this.apiKeyVisible ? t('popup__btnHideKey') : t('popup__btnShowKey');
    });
    this.elements.copyApiKeyBtn.addEventListener('click', async () => {
      const copied = await writeTextToClipboard(this.elements.apiKey.value);
      if (copied) {
        this.feedback.show(this.elements.status, t('popup__statusCopied'), 'success');
      }
    });

    this.elements.addHeaderBtn.addEventListener('click', () => this.providerForm.appendHeaderRow('', ''));
    this.elements.headerRows.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button[data-header-action]') as HTMLButtonElement | null;
      if (!button) return;
      const row = button.closest('.header-row');
      if (!row) return;
      if (button.dataset.headerAction === 'remove') {
        row.remove();
        if (this.elements.headerRows.children.length === 0) {
          this.providerForm.appendHeaderRow('', '');
        }
        this.scheduleProviderDraftSave();
        return;
      }
      if (button.dataset.headerAction === 'toggle') {
        const input = row.querySelector('.header-value') as HTMLInputElement | null;
        if (!input) return;
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        button.textContent = reveal ? t('popup__btnHideKey') : t('popup__btnShowKey');
      }
    });

    [
      this.elements.tavilyApiKey,
      this.elements.searchDepthSelect,
      this.elements.timeRangeSelect,
      this.elements.maxResultsInput,
      this.elements.maxRoundsInput
    ].forEach((element) => {
      element.addEventListener('change', () => {
        this.saveSearchSettings().catch((error) => console.error(error));
      });
    });

    this.elements.addPromptBtn.addEventListener('click', () => {
      void this.createPrompt().catch((error) => this.feedback.show(this.elements.promptStatus, getErrorText(error), 'error'));
    });
    this.elements.savePromptBtn.addEventListener('click', () => {
      void this.savePrompt().catch((error) => this.feedback.show(this.elements.promptStatus, getErrorText(error), 'error'));
    });
    this.elements.deletePromptBtn.addEventListener('click', () => this.confirmDeletePrompt());
    this.elements.exportPromptsBtn.addEventListener('click', () => {
      this.currentExportTarget = 'prompts';
      this.openModal(this.elements.exportModal);
    });
    this.elements.importPromptsBtn.addEventListener('click', () => this.elements.importPromptsInput.click());
    this.elements.importPromptsInput.addEventListener('change', () => {
      void this.importPrompts().catch((error) => this.feedback.show(this.elements.promptStatus, getErrorText(error), 'error'));
    });
    this.elements.defaultPromptSelect.addEventListener('change', () => {
      this.store.featureSettings.defaultPromptId = this.elements.defaultPromptSelect.value || null;
      void this.persist().catch((error) => this.feedback.show(this.elements.promptStatus, getErrorText(error), 'error'));
    });
    this.elements.promptList.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!target) return;
      this.selectedPromptId = target.dataset.id || null;
      this.renderPrompts();
      this.fillPromptForm();
    });
    [this.elements.promptName, this.elements.promptContent].forEach((field) => {
      field.addEventListener('input', () => this.schedulePromptDraftSave());
    });

    this.elements.exportAllBtn.addEventListener('click', () => {
      this.currentExportTarget = 'history';
      this.currentExportChatId = 'all';
      this.openModal(this.elements.exportModal);
    });
    this.elements.clearAllBtn.addEventListener('click', () => this.confirm(t('history__confirmDeleteAll'), async () => {
      await clearChatSessions();
      this.store.chatHistory = [];
      await this.refreshStorageUsage();
      this.historyView.render(this.store.chatHistory, this.historySearchTerm);
      this.feedback.show(this.elements.historyStatus, t('history__successCleared'), 'success');
    }));
    this.elements.historyList.addEventListener('click', (event) => this.handleHistoryAction(event));
    this.elements.historySearchInput.addEventListener('input', () => {
      this.historySearchTerm = this.elements.historySearchInput.value.trim();
      this.historyView.render(this.store.chatHistory, this.historySearchTerm);
    });
    this.elements.onboardingPresetButtons.forEach((button) => {
      button.addEventListener('click', () => {
        this.selectOnboardingPreset((button.dataset.onboardingPreset || 'openai') as OnboardingPresetId);
      });
    });
    this.elements.onboardingSkipBtn.addEventListener('click', () => {
      this.closeModal('onboardingModal');
      this.elements.profileName.focus();
    });
    this.elements.onboardingSaveTestBtn.addEventListener('click', () => {
      this.completeOnboarding().catch((error) => {
        this.feedback.show(this.elements.onboardingStatus, getErrorText(error), 'error');
      });
    });
    document.querySelectorAll('.modal-close').forEach((button) => {
      button.addEventListener('click', () => this.closeModal((button as HTMLElement).dataset.modal || ''));
    });
    document.querySelectorAll('.export-option').forEach((option) => {
      option.addEventListener('click', () => this.exportCurrent((option as HTMLElement).dataset.format || 'markdown'));
    });
    this.elements.confirmBtn.addEventListener('click', () => {
      if (!this.confirmAction || this.confirmActionInFlight) {
        return;
      }
      const action = this.confirmAction;
      this.confirmActionInFlight = true;
      this.elements.confirmBtn.disabled = true;
      this.elements.confirmCancelBtn.disabled = true;
      void Promise.resolve()
        .then(() => action())
        .catch((error) => {
          this.feedback.show(this.elements.status, getErrorText(error), 'error');
        })
        .finally(() => {
          this.confirmActionInFlight = false;
          this.elements.confirmBtn.disabled = false;
          this.elements.confirmCancelBtn.disabled = false;
          this.confirmAction = null;
          this.closeModal('confirmModal');
        });
    });
    this.elements.confirmCancelBtn.addEventListener('click', () => this.closeModal('confirmModal'));
  }

  private maybeShowOnboarding() {
    if (this.store.providers.length > 0) {
      return;
    }
    this.selectOnboardingPreset(this.onboardingPresetId);
    this.openModal(this.elements.onboardingModal);
  }

  private selectOnboardingPreset(presetId: OnboardingPresetId) {
    const preset = ONBOARDING_PRESETS[presetId] ?? ONBOARDING_PRESETS.openai;
    this.onboardingPresetId = presetId in ONBOARDING_PRESETS ? presetId : 'openai';
    this.elements.onboardingPresetButtons.forEach((button) => {
      button.classList.toggle('active', button.dataset.onboardingPreset === this.onboardingPresetId);
    });
    this.elements.onboardingModelName.value = preset.model;
    this.showOnboardingPreview(preset);
  }

  private showOnboardingPreview(preset: (typeof ONBOARDING_PRESETS)[OnboardingPresetId]) {
    this.elements.profileName.value = preset.name;
    this.elements.apiUrl.value = preset.baseUrl;
    this.elements.modelName.value = preset.model;
    this.elements.transportSelect.value = preset.transport;
    this.elements.reasoningFormatSelect.value = preset.reasoningFormat;
    this.elements.supportsStreamingCheckbox.checked = true;
    this.elements.temperatureInput.value = '';
  }

  private async completeOnboarding() {
    const provider = this.buildOnboardingProvider();
    if (!provider.apiKey || !provider.defaultModel) {
      this.feedback.show(this.elements.onboardingStatus, t('onboarding__statusMissingFields'), 'error');
      return;
    }

    this.elements.onboardingSaveTestBtn.disabled = true;
    this.feedback.show(this.elements.onboardingStatus, t('onboarding__statusTesting'), 'success');

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
      if (!await this.persist()) {
        return;
      }
      this.closeModal('onboardingModal');
      try {
        await this.openOnboardingSampleChat();
        this.feedback.show(this.elements.status, t('onboarding__statusReady'), 'success');
      } catch {
        this.feedback.show(this.elements.status, t('onboarding__statusSavedOpenFailed'), 'error');
      }
    } catch (error) {
      this.feedback.show(this.elements.onboardingStatus, t('popup__statusTestFailed', getErrorText(error)), 'error');
    } finally {
      this.elements.onboardingSaveTestBtn.disabled = false;
    }
  }

  private buildOnboardingProvider(): ProviderConfig {
    const preset = ONBOARDING_PRESETS[this.onboardingPresetId] ?? ONBOARDING_PRESETS.openai;
    const now = nowIso();
    const modelId = this.elements.onboardingModelName.value.trim() || preset.model;
    return {
      id: uid('provider'),
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey: this.elements.onboardingApiKey.value.trim(),
      transport: preset.transport,
      defaultModel: modelId,
      defaultGenerationParams: {
        temperature: null
      },
      headers: {},
      authMode: 'bearer',
      modelCatalog: [
        {
          modelId,
          displayName: modelId,
          supportsStreaming: true,
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

  private async persist(): Promise<boolean> {
    this.enforceFixedDefaults();
    if (!await this.saveMeta()) {
      return false;
    }
    await this.refreshStorageUsage();
    this.renderAll();
    return true;
  }

  /** Persists only the small metadata object; chats live under their own keys. */
  private async saveMeta(): Promise<boolean> {
    const { chatHistory: _chatHistory, ...meta } = this.store;
    try {
      await saveConfig(meta as StorageConfig);
      return true;
    } catch (error) {
      this.feedback.show(
        this.elements.status,
        isStorageQuotaError(error) ? t('popup__statusQuotaExceeded') : getErrorText(error),
        'error'
      );
      return false;
    }
  }

  private async refreshStorageUsage() {
    const usage = await getStorageUsage();
    const ratio = usage.ratio;
    const level = ratio !== null && ratio >= 0.9 ? 'critical' : ratio !== null && ratio >= 0.8 ? 'warning' : 'normal';
    const visible = usage.bytes > 0;
    this.elements.storageUsage.hidden = !visible;
    if (visible) {
      this.elements.storageUsage.dataset.level = level;
      this.elements.storageUsage.textContent = t('popup__storageUsage', [formatBytes(usage.bytes)]);
    } else {
      delete this.elements.storageUsage.dataset.level;
      this.elements.storageUsage.textContent = '';
    }
  }

  private enforceFixedDefaults() {
    this.store.featureSettings.search.enabledByDefault = false;
    this.store.featureSettings.defaultStreaming = false;
    this.store.providers.forEach((provider) => {
      provider.headers = normalizeCustomHeaders(provider.headers);
      if (provider.authMode !== 'bearer' && provider.authMode !== 'custom' && provider.authMode !== 'none') {
        provider.authMode = 'bearer';
      }
      (provider.modelCatalog ?? []).forEach((model) => {
        if (typeof model.supportsStreaming !== 'boolean') {
          model.supportsStreaming = true;
        }
      });
    });
  }

  private renderAll() {
    this.renderProviders();
    this.providerForm.fill(this.store.providers.find(item => item.id === this.selectedProviderId), this.selectedProviderId ? this.providerDrafts[this.selectedProviderId] : undefined);
    this.searchForm.fill(this.store.featureSettings.search);
    this.renderPrompts();
    this.fillPromptForm();
    this.historyView.render(this.store.chatHistory, this.historySearchTerm);
  }

  private renderProviders() {
    renderProfileList(this.elements.profileList, this.elements.activeProfileSelect, this.store.providers,
      this.selectedProviderId, this.store.featureSettings.defaultProviderId,
      t('popup__emptyProviders'), t('common__none'), false);
  }

  private scheduleProviderDraftSave() {
    if (!this.selectedProviderId) return;
    const draft = this.providerForm.captureDraft();
    if (!draft) return;
    this.providerDrafts[this.selectedProviderId] = draft;
    if (this.draftSaveTimer !== null) window.clearTimeout(this.draftSaveTimer);
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void chrome.storage.local.set({ [PROVIDER_DRAFTS_KEY]: this.providerDrafts });
    }, 180);
    this.feedback.clearTimer(this.elements.status);
    this.elements.status.textContent = t('popup__statusUnsaved');
    this.elements.status.className = 'status show draft';
    this.elements.status.setAttribute('role', 'status');
  }

  private clearProviderDraft(providerId: string) {
    delete this.providerDrafts[providerId];
    void chrome.storage.local.set({ [PROVIDER_DRAFTS_KEY]: this.providerDrafts });
  }

  /** Rebuilds the custom-header editor, always leaving one blank row. */

  private async saveSearchSettings() {
    this.store.featureSettings.search = this.searchForm.read();
    this.store.featureSettings.defaultStreaming = false;
    if (!await this.saveMeta()) {
      return;
    }
    this.feedback.show(this.elements.searchStatus, t('popup__statusSaved'), 'success');
  }

  private async createProvider() {
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
      authMode: 'bearer',
      modelCatalog: [
        {
          modelId: '',
          displayName: '',
          supportsStreaming: true,
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
    await this.persist();
  }

  private async saveProvider() {
    const now = nowIso();
    const providerId = this.selectedProviderId ?? uid('provider');
    const current = this.store.providers.find((item) => item.id === providerId);
    const { headers, error: headerError } = this.providerForm.collectHeaders();
    if (headerError) {
      this.feedback.show(this.elements.status, headerError, 'error');
      return;
    }
    const provider: ProviderConfig = {
      id: providerId,
      name: this.elements.profileName.value.trim() || t('popup__untitledProvider'),
      baseUrl: this.elements.apiUrl.value.trim(),
      apiKey: this.elements.apiKey.value.trim(),
      transport: this.elements.transportSelect.value as ProviderConfig['transport'],
      defaultModel: this.elements.modelName.value.trim(),
      defaultGenerationParams: {
        temperature: toNullableNumber(this.elements.temperatureInput.value)
      },
      headers,
      authMode: this.elements.authModeSelect.value as ProviderConfig['authMode'],
      modelCatalog: [
        {
          modelId: this.elements.modelName.value.trim(),
          displayName: this.elements.modelName.value.trim(),
          supportsStreaming: this.elements.supportsStreamingCheckbox.checked,
          reasoningFormat: resolveReasoningFormat(this.elements.reasoningFormatSelect.value),
          customReasoningEfforts: normalizeCustomReasoningEfforts(this.elements.customEffortsInput.value)
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
    if (!await this.persist()) {
      return;
    }

    this.clearProviderDraft(providerId);
    this.feedback.show(this.elements.status, t('popup__statusSaved'), 'success');
  }

  private confirmDeleteProvider() {
    const provider = this.store.providers.find((item) => item.id === this.selectedProviderId);
    if (!provider) return;
    this.confirm(t('popup__confirmDeleteProfile', provider.name), async () => {
      this.store.providers = this.store.providers.filter((item) => item.id !== provider.id);
      this.clearProviderDraft(provider.id);
      this.selectedProviderId = this.store.providers[0]?.id ?? null;
      if (this.store.featureSettings.defaultProviderId === provider.id) {
        this.store.featureSettings.defaultProviderId = this.selectedProviderId;
      }
      if (!await this.persist()) {
        return;
      }
      this.feedback.show(this.elements.status, t('popup__statusDeleted'), 'success');
    });
  }

  private async setDefaultProvider() {
    this.store.featureSettings.defaultProviderId = this.selectedProviderId;
    if (!await this.persist()) {
      return;
    }
    this.feedback.show(this.elements.status, t('popup__statusSetActive'), 'success');
  }

  private async testProvider() {
    const providerId = this.selectedProviderId;
    const current = this.store.providers.find((item) => item.id === providerId);
    const { headers, error: headerError } = this.providerForm.collectHeaders();
    if (headerError) {
      this.feedback.show(this.elements.status, headerError, 'error');
      return;
    }
    if (!current || !providerId) return;
    const now = nowIso();
    const provider: ProviderConfig = {
      id: providerId,
      name: this.elements.profileName.value.trim() || current.name,
      baseUrl: this.elements.apiUrl.value.trim(),
      apiKey: this.elements.apiKey.value.trim(),
      transport: this.elements.transportSelect.value as ProviderConfig['transport'],
      defaultModel: this.elements.modelName.value.trim(),
      defaultGenerationParams: { temperature: toNullableNumber(this.elements.temperatureInput.value) },
      headers,
      authMode: this.elements.authModeSelect.value as ProviderConfig['authMode'],
      modelCatalog: [{
        modelId: this.elements.modelName.value.trim(),
        displayName: this.elements.modelName.value.trim(),
        supportsStreaming: this.elements.supportsStreamingCheckbox.checked,
        reasoningFormat: resolveReasoningFormat(this.elements.reasoningFormatSelect.value),
        customReasoningEfforts: normalizeCustomReasoningEfforts(this.elements.customEffortsInput.value)
      }],
      createdAt: current.createdAt ?? now,
      updatedAt: now
    };
    if (this.testingProvider) return;
    this.testingProvider = true;
    this.elements.testBtn.disabled = true;
    this.feedback.show(this.elements.status, t('popup__statusTestRunning'), 'success');
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'TEST_PROVIDER',
        provider
      });
      if (response?.success) {
        this.feedback.show(this.elements.status, t('popup__statusTestSuccess'), 'success');
      } else {
        this.feedback.show(this.elements.status, t('popup__statusTestFailed', response?.error || t('common__unknownError')), 'error');
      }
    } catch (error) {
      this.feedback.show(this.elements.status, t('popup__statusTestFailed', getErrorText(error)), 'error');
    } finally {
      this.testingProvider = false;
      this.elements.testBtn.disabled = false;
    }
  }

  private async importProviders() {
    const file = this.elements.importProfilesInput.files?.[0];
    if (!file) return;
    let parsed: ProviderImportPayload;
    try {
      parsed = parseImportPayload(await file.text()) as ProviderImportPayload;
    } catch (error) {
      this.elements.importProfilesInput.value = '';
      this.feedback.show(this.elements.status, t('popup__statusImportFailed', getErrorText(error)), 'error');
      return;
    }
    this.elements.importProfilesInput.value = '';
    if (Array.isArray(parsed.providers)) {
      this.confirm(t('popup__confirmImportReplace'), async () => {
        const result = mergeProvidersForImport(this.store.providers, parsed.providers ?? []);
        this.store.providers = result.providers;
        this.store.featureSettings.defaultProviderId = resolveImportedDefaultProviderId(
          parsed,
          this.store.providers,
          this.store.featureSettings.defaultProviderId
        );
        this.store.featureSettings.search = normalizeImportedSearchSettings(
          parsed.search ?? parsed.featureSettings?.search,
          this.store.featureSettings.search
        );
        this.enforceFixedDefaults();
        this.selectedProviderId = this.store.featureSettings.defaultProviderId ?? this.store.providers[0]?.id ?? null;
        if (!await this.persist()) {
          return;
        }
        this.feedback.show(
          this.elements.status,
          t('config__statusImported', [result.addedCount, result.updatedCount]),
          'success'
        );
      });
    }
  }

  private renderPrompts() {
    renderProfileList(this.elements.promptList, this.elements.defaultPromptSelect, this.store.prompts,
      this.selectedPromptId, this.store.featureSettings.defaultPromptId,
      t('prompt__emptyState'), t('prompt__noPrompt'), true);
  }

  private fillPromptForm() {
    const prompt = this.store.prompts.find((item) => item.id === this.selectedPromptId);
    const draft = this.selectedPromptId ? this.promptDrafts[this.selectedPromptId] : null;
    this.elements.promptName.value = draft?.name ?? prompt?.name ?? '';
    this.elements.promptContent.value = draft?.content ?? prompt?.content ?? '';
  }

  private schedulePromptDraftSave() {
    if (!this.selectedPromptId) return;
    this.promptDrafts[this.selectedPromptId] = {
      name: this.elements.promptName.value,
      content: this.elements.promptContent.value,
      updatedAt: nowIso()
    };
    void chrome.storage.local.set({ [PROMPT_DRAFTS_KEY]: this.promptDrafts });
    this.feedback.clearTimer(this.elements.promptStatus);
    this.elements.promptStatus.textContent = t('popup__statusUnsaved');
    this.elements.promptStatus.className = 'status show draft';
    this.elements.promptStatus.setAttribute('role', 'status');
  }

  private async createPrompt() {
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
    await this.persist();
  }

  private async savePrompt() {
    const now = nowIso();
    const promptId = this.selectedPromptId ?? uid('prompt');
    const existing = this.store.prompts.find((item) => item.id === promptId);
    const prompt: PromptConfig = {
      id: promptId,
      name: this.elements.promptName.value.trim() || t('prompt__untitled'),
      content: this.elements.promptContent.value.trim(),
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
    if (!await this.persist()) {
      return;
    }
    delete this.promptDrafts[promptId];
    await chrome.storage.local.set({ [PROMPT_DRAFTS_KEY]: this.promptDrafts });
    this.feedback.show(this.elements.promptStatus, t('prompt__statusSaved'), 'success');
  }

  private confirmDeletePrompt() {
    const prompt = this.store.prompts.find((item) => item.id === this.selectedPromptId);
    if (!prompt) return;
    this.confirm(t('prompt__confirmDelete', prompt.name), async () => {
      this.store.prompts = this.store.prompts.filter((item) => item.id !== prompt.id);
      delete this.promptDrafts[prompt.id];
      await chrome.storage.local.set({ [PROMPT_DRAFTS_KEY]: this.promptDrafts });
      this.selectedPromptId = this.store.prompts[0]?.id ?? null;
      if (this.store.featureSettings.defaultPromptId === prompt.id) {
        this.store.featureSettings.defaultPromptId = null;
      }
      if (!await this.persist()) {
        return;
      }
      this.feedback.show(this.elements.promptStatus, t('prompt__statusDeleted'), 'success');
    });
  }

  private async importPrompts() {
    const file = this.elements.importPromptsInput.files?.[0];
    if (!file) return;
    let parsed: { prompts?: PromptConfig[]; defaultPromptId?: string | null };
    try {
      parsed = parseImportPayload(await file.text()) as { prompts?: PromptConfig[]; defaultPromptId?: string | null };
    } catch (error) {
      this.elements.importPromptsInput.value = '';
      this.feedback.show(this.elements.promptStatus, t('popup__statusImportFailed', getErrorText(error)), 'error');
      return;
    }
    this.elements.importPromptsInput.value = '';
    if (Array.isArray(parsed.prompts)) {
      this.confirm(t('popup__confirmImportReplace'), async () => {
        const result = mergePromptsForImport(this.store.prompts, parsed.prompts ?? []);
        this.store.prompts = result.prompts;
        this.store.featureSettings.defaultPromptId = resolveImportedPromptId(
          parsed.defaultPromptId ?? null,
          this.store.prompts,
          this.store.featureSettings.defaultPromptId
        );
        this.selectedPromptId = this.store.featureSettings.defaultPromptId ?? this.store.prompts[0]?.id ?? null;
        if (!await this.persist()) {
          return;
        }
        this.feedback.show(
          this.elements.promptStatus,
          t('config__statusImported', [result.addedCount, result.updatedCount]),
          'success'
        );
      });
    }
  }

  private async handleHistoryAction(event: Event) {
    const button = (event.target as HTMLElement).closest('button[data-action]') as HTMLButtonElement | null;
    if (!button) return;
    const action = button.dataset.action;
    const chatId = button.dataset.id || '';
    if (action === 'resume') {
      const chat = this.store.chatHistory.find((item) => item.chatId === chatId);
      if (!chat) {
        this.feedback.show(this.elements.historyStatus, t('history__errorOpenFailed') + t('common__unknownError'), 'error');
        return;
      }
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          this.feedback.show(this.elements.historyStatus, t('history__errorOpenFailed') + t('common__unknownError'), 'error');
          return;
        }
        await chrome.tabs.sendMessage(tab.id, {
          type: 'OPEN_CHAT_WINDOW',
          chat
        });
      } catch (error) {
        this.feedback.show(this.elements.historyStatus, t('history__errorOpenFailed') + getErrorText(error), 'error');
        return;
      }
      this.feedback.show(this.elements.historyStatus, t('history__successWindowOpened'), 'success');
      return;
    }
    if (action === 'export') {
      this.currentExportTarget = 'history';
      this.currentExportChatId = chatId;
      this.openModal(this.elements.exportModal);
      return;
    }
    if (action === 'delete') {
      const chat = this.store.chatHistory.find((item) => item.chatId === chatId);
      this.confirm(t('history__confirmDeleteItem', chat?.title || chatId), async () => {
        await deleteChatSession(chatId);
        this.store.chatHistory = this.store.chatHistory.filter((item) => item.chatId !== chatId);
        await this.refreshStorageUsage();
        this.historyView.render(this.store.chatHistory, this.historySearchTerm);
        this.feedback.show(this.elements.historyStatus, t('history__successDeleted'), 'success');
      });
    }
  }

  private exportCurrent(format: string) {
    if (this.currentExportTarget === 'providers') {
      exportPayload(format, 'providers-v2', {
        providers: this.store.providers,
        defaultProviderId: this.store.featureSettings.defaultProviderId,
        search: this.store.featureSettings.search
      });
      this.closeModal('exportModal');
      this.feedback.show(this.elements.status, t('history__successExported'), 'success');
      return;
    }

    if (this.currentExportTarget === 'prompts') {
      exportPayload(format, 'prompts-v2', {
        prompts: this.store.prompts,
        defaultPromptId: this.store.featureSettings.defaultPromptId
      });
      this.closeModal('exportModal');
      this.feedback.show(this.elements.promptStatus, t('history__successExported'), 'success');
      return;
    }

    this.exportHistory(format);
  }

  private exportHistory(format: string) {
    const chats = this.currentExportChatId === 'all'
      ? this.store.chatHistory
      : this.store.chatHistory.filter((item) => item.chatId === this.currentExportChatId);
    if (format === 'json') {
      downloadFile('chat-history.json', JSON.stringify({ chatHistory: chats }, null, 2), 'application/json;charset=utf-8');
    } else {
      downloadFile('chat-history.md', exportAsMarkdown(chats), 'text/markdown;charset=utf-8');
    }
    this.closeModal('exportModal');
    this.feedback.show(this.elements.historyStatus, t('history__successExported'), 'success');
  }

  private confirm(text: string, action: () => void | Promise<void>) {
    this.elements.confirmText.textContent = text;
    this.confirmAction = action;
    this.openModal(this.elements.confirmModal);
  }

  private openModal(modal: HTMLElement) {
    modal.classList.add('show');
  }

  private closeModal(id: string) {
    document.getElementById(id)?.classList.remove('show');
  }
}
