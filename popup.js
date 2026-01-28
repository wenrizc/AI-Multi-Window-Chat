const STORAGE_KEYS = {
  profiles: 'apiProfiles',
  activeProfileId: 'activeApiProfileId'
};

const DEFAULT_API_URL = 'https://api.openai.com/v1';
const REQUEST_TIMEOUT_MS = 8000;

const elements = {
  apiUrl: document.getElementById('apiUrl'),
  apiKey: document.getElementById('apiKey'),
  modelName: document.getElementById('modelName'),
  profileName: document.getElementById('profileName'),
  profileList: document.getElementById('profileList'),
  addProfileBtn: document.getElementById('addProfileBtn'),
  exportProfilesBtn: document.getElementById('exportProfilesBtn'),
  importProfilesBtn: document.getElementById('importProfilesBtn'),
  importProfilesInput: document.getElementById('importProfilesInput'),
  activeProfileSelect: document.getElementById('activeProfileSelect'),
  toggleApiKeyBtn: document.getElementById('toggleApiKeyBtn'),
  copyApiKeyBtn: document.getElementById('copyApiKeyBtn'),
  setActiveBtn: document.getElementById('setActiveBtn'),
  testBtn: document.getElementById('testBtn'),
  deleteBtn: document.getElementById('deleteBtn'),
  saveBtn: document.getElementById('saveBtn'),
  status: document.getElementById('status'),
  presetBtns: document.querySelectorAll('.preset-btn'),
  // Prompts
  promptList: document.getElementById('promptList'),
  addPromptBtn: document.getElementById('addPromptBtn'),
  exportPromptsBtn: document.getElementById('exportPromptsBtn'),
  importPromptsBtn: document.getElementById('importPromptsBtn'),
  importPromptsInput: document.getElementById('importPromptsInput'),
  defaultPromptSelect: document.getElementById('defaultPromptSelect'),
  promptName: document.getElementById('promptName'),
  promptContent: document.getElementById('promptContent'),
  savePromptBtn: document.getElementById('savePromptBtn'),
  deletePromptBtn: document.getElementById('deletePromptBtn'),
  promptStatus: document.getElementById('promptStatus'),
  // History
  historyList: document.getElementById('historyList'),
  historyStatus: document.getElementById('historyStatus'),
  exportAllBtn: document.getElementById('exportAllBtn'),
  clearAllBtn: document.getElementById('clearAllBtn'),
  exportModal: document.getElementById('exportModal'),
  confirmModal: document.getElementById('confirmModal'),
  confirmText: document.getElementById('confirmText'),
  confirmBtn: document.getElementById('confirmBtn'),
  tabs: document.querySelectorAll('.tab'),
  tabContents: document.querySelectorAll('.tab-content')
};

let currentChatId = null;
let profiles = [];
let selectedProfileId = null;
let activeProfileId = null;
let isApiKeyVisible = false;

// Prompts state
let prompts = [];
let selectedPromptId = null;
let defaultPromptId = null;

async function init() {
  document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';
  document.title = t('popup__pageTitle');
  const manifest = chrome.runtime.getManifest();
  const footer = document.getElementById('footer');
  if (footer) {
    footer.textContent = t('popup__footerVersion', manifest.version);
  }
  setupTabs();
  setupConfigHandlers();
  setupPromptHandlers();
  setupHistoryHandlers();
  await loadProfiles();
  loadHistory();
  updatePageTranslations();
}

function setupTabs() {
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;

      elements.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      elements.tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === `${targetTab}Tab`) {
          content.classList.add('active');
        }
      });

      if (targetTab === 'history') {
        loadHistory();
      } else if (targetTab === 'prompts') {
        loadPrompts();
      }
    });
  });
}

function setupConfigHandlers() {
  elements.saveBtn.addEventListener('click', saveProfile);
  elements.addProfileBtn.addEventListener('click', addProfile);
  elements.exportProfilesBtn.addEventListener('click', exportProfiles);
  elements.importProfilesBtn.addEventListener('click', () => {
    elements.importProfilesInput.click();
  });
  elements.importProfilesInput.addEventListener('change', importProfiles);
  elements.deleteBtn.addEventListener('click', () => {
    const profile = getProfileById(selectedProfileId);
    if (!profile) return;
    const name = profile.name || t('popup__profileNameEmpty');
    showConfirmDialog(t('popup__confirmDeleteProfile', name), async () => {
      await deleteProfile();
    });
  });
  elements.setActiveBtn.addEventListener('click', () => {
    if (!selectedProfileId) return;
    setActiveProfile(selectedProfileId);
  });
  elements.testBtn.addEventListener('click', testConnection);
  elements.toggleApiKeyBtn.addEventListener('click', () => {
    setApiKeyVisibility(!isApiKeyVisible);
  });
  elements.copyApiKeyBtn.addEventListener('click', copyApiKey);
  elements.activeProfileSelect.addEventListener('change', () => {
    const profileId = elements.activeProfileSelect.value;
    if (!profileId) return;
    selectProfile(profileId);
    setActiveProfile(profileId);
  });

  if (elements.profileList) {
    elements.profileList.addEventListener('click', (event) => {
      const item = event.target.closest('.profile-item');
      if (!item) return;
      selectProfile(item.dataset.id);
    });
  }

  elements.presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.apiUrl.value = btn.dataset.url;
      elements.apiUrl.focus();
    });
  });
}

function setupPromptHandlers() {
  elements.savePromptBtn.addEventListener('click', savePrompt);
  elements.addPromptBtn.addEventListener('click', addPrompt);
  elements.exportPromptsBtn.addEventListener('click', exportPrompts);
  elements.importPromptsBtn.addEventListener('click', () => {
    elements.importPromptsInput.click();
  });
  elements.importPromptsInput.addEventListener('change', importPrompts);
  elements.deletePromptBtn.addEventListener('click', () => {
    const prompt = getPromptById(selectedPromptId);
    if (!prompt) return;
    const name = prompt.name || t('prompt__empty');
    showConfirmDialog(t('prompt__confirmDelete', name), async () => {
      await deletePrompt();
    });
  });
  elements.defaultPromptSelect.addEventListener('change', () => {
    const promptId = elements.defaultPromptSelect.value;
    setDefaultPrompt(promptId);
  });

  if (elements.promptList) {
    elements.promptList.addEventListener('click', (event) => {
      const item = event.target.closest('.profile-item');
      if (!item) return;
      selectPrompt(item.dataset.id);
    });
  }
}

function setupHistoryHandlers() {
  elements.exportAllBtn.addEventListener('click', () => {
    currentChatId = 'all';
    openModal('exportModal');
  });

  elements.clearAllBtn.addEventListener('click', () => {
    showConfirmDialog(t('history__confirmDeleteAll'), async () => {
      await clearAllHistory();
    });
  });

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const modalId = btn.dataset.modal;
      if (modalId) {
        closeModal(modalId);
      }
    });
  });

  document.querySelectorAll('.export-option').forEach(option => {
    option.addEventListener('click', () => {
      exportChat(option.dataset.format);
    });
  });

  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  if (confirmCancelBtn) {
    confirmCancelBtn.addEventListener('click', () => {
      closeModal('confirmModal');
    });
  }

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal(modal.id);
      }
    });
  });
}

async function loadProfiles() {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.profiles,
      STORAGE_KEYS.activeProfileId
    ]);

    profiles = Array.isArray(result.apiProfiles) ? result.apiProfiles : [];
    activeProfileId = result.activeApiProfileId || null;

    if (profiles.length === 0) {
      activeProfileId = null;
      selectedProfileId = null;
      renderProfiles();
      clearForm();
      setEmptyState(true);
      return;
    }

    const activeExists = profiles.some(profile => profile.id === activeProfileId);
    if (!activeProfileId || !activeExists) {
      activeProfileId = profiles[0].id;
      await persistProfiles();
    }

    selectedProfileId = activeProfileId || (profiles[0] && profiles[0].id);
    renderProfiles();

    const selectedProfile = getProfileById(selectedProfileId);
    if (selectedProfile) {
      updateForm(selectedProfile);
    }
    setEmptyState(!selectedProfile);
  } catch (error) {
    console.error('Failed to load profiles:', error);
  }
}

async function persistProfiles() {
  await chrome.storage.local.set({
    apiProfiles: profiles,
    activeApiProfileId: activeProfileId
  });
}

function renderProfiles() {
  if (!elements.profileList) return;

  if (profiles.length === 0) {
    elements.profileList.classList.add('empty');
    elements.profileList.innerHTML = '';
  } else {
    elements.profileList.classList.remove('empty');
    elements.profileList.innerHTML = profiles.map(profile => {
      const isActive = profile.id === activeProfileId;
      const isSelected = profile.id === selectedProfileId;
      const name = profile.name || t('popup__profileNameEmpty');
      return `
        <button class="profile-item${isSelected ? ' active' : ''}${isActive ? ' current' : ''}" data-id="${profile.id}">
          <span class="profile-dot"></span>
          <span class="profile-name">${escapeHtml(name)}</span>
        </button>
      `;
    }).join('');
  }

  if (elements.activeProfileSelect) {
    if (profiles.length === 0) {
      elements.activeProfileSelect.innerHTML = '';
      elements.activeProfileSelect.value = '';
      elements.activeProfileSelect.disabled = true;
    } else {
      const options = profiles.map(profile => {
        const name = profile.name || t('popup__profileNameEmpty');
        return `<option value="${profile.id}">${escapeHtml(name)}</option>`;
      }).join('');
      elements.activeProfileSelect.innerHTML = options;
      elements.activeProfileSelect.value = activeProfileId || profiles[0].id;
      elements.activeProfileSelect.disabled = false;
    }
  }
}

function selectProfile(profileId) {
  const profile = getProfileById(profileId);
  if (!profile) return;
  selectedProfileId = profileId;
  renderProfiles();
  updateForm(profile);
  setEmptyState(false);
}

function updateForm(profile) {
  elements.profileName.value = profile.name || '';
  elements.apiUrl.value = profile.apiUrl || '';
  elements.apiKey.value = profile.apiKey || '';
  elements.modelName.value = profile.modelName || '';
  setApiKeyVisibility(false);
}

function clearForm() {
  elements.profileName.value = '';
  elements.apiUrl.value = '';
  elements.apiKey.value = '';
  elements.modelName.value = '';
  setApiKeyVisibility(false);
}

function setEmptyState(isEmpty) {
  elements.profileName.disabled = isEmpty;
  elements.apiUrl.disabled = isEmpty;
  elements.apiKey.disabled = isEmpty;
  elements.modelName.disabled = isEmpty;
  elements.toggleApiKeyBtn.disabled = isEmpty;
  elements.copyApiKeyBtn.disabled = isEmpty;
  elements.setActiveBtn.disabled = isEmpty;
  elements.testBtn.disabled = isEmpty;
  elements.saveBtn.disabled = isEmpty;
  elements.deleteBtn.disabled = isEmpty;
}

function collectFormData() {
  return {
    id: selectedProfileId,
    name: elements.profileName.value.trim(),
    apiUrl: elements.apiUrl.value.trim(),
    apiKey: elements.apiKey.value.trim(),
    modelName: elements.modelName.value.trim()
  };
}

function validateProfile(profile) {
  if (!profile.name) {
    showStatus(`${t('popup__labelProfileName')} ${t('common__error')}`, 'error');
    return false;
  }

  if (!profile.apiUrl) {
    showStatus(`${t('popup__labelApiUrl')} ${t('common__error')}`, 'error');
    return false;
  }

  if (!profile.apiKey) {
    showStatus(`${t('popup__labelApiKey')} ${t('common__error')}`, 'error');
    return false;
  }

  if (!profile.modelName) {
    showStatus(`${t('popup__labelModelName')} ${t('common__error')}`, 'error');
    return false;
  }

  return true;
}

async function saveProfile() {
  const profile = collectFormData();
  if (!validateProfile(profile)) return;

  const index = profiles.findIndex(item => item.id === profile.id);
  if (index === -1) {
    profile.id = profile.id || generateId();
    profiles.push(profile);
    selectedProfileId = profile.id;
  } else {
    profiles[index] = {
      ...profiles[index],
      ...profile
    };
  }

  try {
    await persistProfiles();
    renderProfiles();
    showStatus(t('popup__statusSaved'), 'success');
  } catch (error) {
    console.error('Failed to save profile:', error);
    showStatus(t('popup__statusError'), 'error');
  }
}

async function addProfile() {
  const newProfile = {
    id: generateId(),
    name: getDefaultProfileName(profiles.length + 1),
    apiUrl: DEFAULT_API_URL,
    apiKey: '',
    modelName: ''
  };
  profiles = [newProfile, ...profiles];
  selectedProfileId = newProfile.id;
  renderProfiles();
  updateForm(newProfile);
  setEmptyState(false);
  elements.profileName.focus();
  try {
    await persistProfiles();
  } catch (error) {
    console.error('Failed to add profile:', error);
  }
}

async function deleteProfile() {
  if (!selectedProfileId) return;
  profiles = profiles.filter(profile => profile.id !== selectedProfileId);

  if (profiles.length === 0) {
    activeProfileId = null;
    selectedProfileId = null;
  } else {
    if (selectedProfileId === activeProfileId) {
      activeProfileId = profiles[0].id;
    }
    selectedProfileId = activeProfileId || profiles[0].id;
  }

  const selectedProfile = getProfileById(selectedProfileId);
  try {
    await persistProfiles();
    renderProfiles();
    if (selectedProfile) {
      updateForm(selectedProfile);
      setEmptyState(false);
    } else {
      clearForm();
      setEmptyState(true);
    }
    showStatus(t('popup__statusDeleted'), 'success');
  } catch (error) {
    console.error('Failed to delete profile:', error);
    showStatus(t('popup__statusError'), 'error');
  }
}

async function setActiveProfile(profileId, options = {}) {
  const { showMessage = true } = options;
  if (!profileId) return;
  activeProfileId = profileId;
  try {
    await persistProfiles();
    renderProfiles();
    if (elements.activeProfileSelect) {
      elements.activeProfileSelect.value = activeProfileId;
    }
    if (showMessage) {
      showStatus(t('popup__statusSetActive'), 'success');
    }
  } catch (error) {
    console.error('Failed to set active profile:', error);
    showStatus(t('popup__statusError'), 'error');
  }
}

function setApiKeyVisibility(visible) {
  isApiKeyVisible = visible;
  elements.apiKey.type = visible ? 'text' : 'password';
  elements.toggleApiKeyBtn.textContent = visible ? t('popup__btnHideKey') : t('popup__btnShowKey');
}

async function copyApiKey() {
  const key = elements.apiKey.value.trim();
  if (!key) {
    showStatus(`${t('popup__labelApiKey')} ${t('common__error')}`, 'error');
    return;
  }

  try {
    await navigator.clipboard.writeText(key);
    showStatus(t('popup__statusCopied'), 'success');
  } catch (error) {
    const textarea = document.createElement('textarea');
    textarea.value = key;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    textarea.remove();
    if (success) {
      showStatus(t('popup__statusCopied'), 'success');
    } else {
      showStatus(t('popup__statusError'), 'error');
    }
  }
}

async function testConnection() {
  const apiUrl = elements.apiUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();

  if (!apiUrl) {
    showStatus(`${t('popup__labelApiUrl')} ${t('common__error')}`, 'error');
    return;
  }

  if (!apiKey) {
    showStatus(`${t('popup__labelApiKey')} ${t('common__error')}`, 'error');
    return;
  }

  const baseUrl = normalizeBaseUrl(apiUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const statusText = `${response.status} ${response.statusText}`.trim();
      showStatus(t('popup__statusTestFailed', statusText || response.status), 'error');
      return;
    }

    showStatus(t('popup__statusTestSuccess'), 'success');
  } catch (error) {
    const reason = error.name === 'AbortError' ? t('popup__statusTestTimeout') : error.message;
    showStatus(t('popup__statusTestFailed', reason), 'error');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(apiUrl) {
  if (!apiUrl) return '';
  return apiUrl.replace(/\/$/, '');
}

function generateId() {
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultProfileName(index) {
  return t('popup__defaultProfileName', index);
}

function getProfileById(profileId) {
  return profiles.find(profile => profile.id === profileId);
}

// ===== Profile Import/Export Functions =====

async function exportProfiles() {
  try {
    if (profiles.length === 0) {
      showStatus(t('config__errorNoProfiles'), 'error');
      return;
    }

    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      profiles: profiles,
      activeProfileId: activeProfileId
    };

    const content = JSON.stringify(exportData, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `api-profiles-${getTimestamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showStatus(t('config__statusExported', profiles.length), 'success');
  } catch (error) {
    console.error('Failed to export profiles:', error);
    showStatus(t('popup__statusError'), 'error');
  }
}

async function importProfiles(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Reset input to allow importing the same file again
  event.target.value = '';

  try {
    const content = await file.text();
    const importData = JSON.parse(content);

    // Validate import data structure
    if (!importData.profiles || !Array.isArray(importData.profiles)) {
      showStatus(t('config__errorInvalidFormat'), 'error');
      return;
    }

    // Validate each profile
    for (const profile of importData.profiles) {
      if (!profile.id || !profile.name) {
        showStatus(t('config__errorInvalidProfile'), 'error');
        return;
      }
    }

    let updatedCount = 0;
    let addedCount = 0;

    // Merge profiles: same ID updates, different ID adds
    for (const importedProfile of importData.profiles) {
      const existingIndex = profiles.findIndex(p => p.id === importedProfile.id);
      if (existingIndex !== -1) {
        // Update existing profile
        profiles[existingIndex] = importedProfile;
        updatedCount++;
      } else {
        // Add new profile
        profiles.push(importedProfile);
        addedCount++;
      }
    }

    // Update active profile ID if imported
    if (importData.activeProfileId && profiles.some(p => p.id === importData.activeProfileId)) {
      activeProfileId = importData.activeProfileId;
    } else if (profiles.length > 0 && !activeProfileId) {
      activeProfileId = profiles[0].id;
    }

    // Ensure selected profile is valid
    if (!profiles.find(p => p.id === selectedProfileId)) {
      selectedProfileId = activeProfileId || profiles[0]?.id || null;
    }

    await persistProfiles();
    renderProfiles();

    const selectedProfile = getProfileById(selectedProfileId);
    if (selectedProfile) {
      updateForm(selectedProfile);
      setEmptyState(false);
    } else {
      clearForm();
      setEmptyState(true);
    }

    const message = t('config__statusImported', [
      String(addedCount),
      String(updatedCount)
    ]);
    showStatus(message, 'success');
  } catch (error) {
    console.error('Failed to import profiles:', error);
    showStatus(t('config__errorImportFailed'), 'error');
  }
}

// ===== Prompt Functions =====

async function loadPrompts() {
  try {
    const result = await chrome.storage.local.get(['system_prompts', 'default_system_prompt_id']);

    prompts = Array.isArray(result.system_prompts) ? result.system_prompts : [];
    defaultPromptId = result.default_system_prompt_id || null;

    if (prompts.length === 0) {
      selectedPromptId = null;
      renderPrompts();
      clearPromptForm();
      setPromptEmptyState(true);
      return;
    }

    // Validate default prompt exists
    const defaultExists = prompts.some(prompt => prompt.id === defaultPromptId);
    if (!defaultExists) {
      defaultPromptId = null;
      await chrome.storage.local.set({ default_system_prompt_id: '' });
    }

    selectedPromptId = defaultPromptId || (prompts[0] && prompts[0].id);
    renderPrompts();

    const selectedPrompt = getPromptById(selectedPromptId);
    if (selectedPrompt) {
      updatePromptForm(selectedPrompt);
    }
    setPromptEmptyState(!selectedPrompt);
  } catch (error) {
    console.error('Failed to load prompts:', error);
  }
}

function renderPrompts() {
  if (!elements.promptList) return;

  if (prompts.length === 0) {
    elements.promptList.classList.add('empty');
    elements.promptList.innerHTML = '';
  } else {
    elements.promptList.classList.remove('empty');
    elements.promptList.innerHTML = prompts.map(prompt => {
      const isSelected = prompt.id === selectedPromptId;
      const isDefault = prompt.id === defaultPromptId;
      const name = prompt.name || t('prompt__empty');
      return `
        <button class="profile-item${isSelected ? ' active' : ''}${isDefault ? ' current' : ''}" data-id="${prompt.id}">
          <span class="profile-dot"></span>
          <span class="profile-name">${escapeHtml(name)}</span>
        </button>
      `;
    }).join('');
  }

  if (elements.defaultPromptSelect) {
    if (prompts.length === 0) {
      elements.defaultPromptSelect.innerHTML = `<option value="">${t('prompt__noPrompt')}</option>`;
      elements.defaultPromptSelect.value = '';
      elements.defaultPromptSelect.disabled = true;
    } else {
      const options = prompts.map(prompt => {
        const name = prompt.name || t('prompt__empty');
        return `<option value="${prompt.id}">${escapeHtml(name)}</option>`;
      }).join('');

      elements.defaultPromptSelect.innerHTML = `<option value="">${t('prompt__noPrompt')}</option>${options}`;
      elements.defaultPromptSelect.value = defaultPromptId || '';
      elements.defaultPromptSelect.disabled = false;
    }
  }
}

function selectPrompt(promptId) {
  const prompt = getPromptById(promptId);
  if (!prompt) return;
  selectedPromptId = promptId;
  renderPrompts();
  updatePromptForm(prompt);
  setPromptEmptyState(false);
}

function updatePromptForm(prompt) {
  elements.promptName.value = prompt.name || '';
  elements.promptContent.value = prompt.content || '';
}

function clearPromptForm() {
  elements.promptName.value = '';
  elements.promptContent.value = '';
}

function setPromptEmptyState(isEmpty) {
  elements.promptName.disabled = isEmpty;
  elements.promptContent.disabled = isEmpty;
  elements.savePromptBtn.disabled = isEmpty;
  elements.deletePromptBtn.disabled = isEmpty;
}

function collectPromptFormData() {
  return {
    id: selectedPromptId,
    name: elements.promptName.value.trim(),
    content: elements.promptContent.value.trim()
  };
}

function validatePrompt(prompt) {
  if (!prompt.name) {
    showPromptStatus(`${t('prompt__labelName')} ${t('common__error')}`, 'error');
    return false;
  }

  if (!prompt.content) {
    showPromptStatus(`${t('prompt__labelContent')} ${t('common__error')}`, 'error');
    return false;
  }

  return true;
}

async function savePrompt() {
  const prompt = collectPromptFormData();
  if (!validatePrompt(prompt)) return;

  const now = new Date().toISOString();

  const index = prompts.findIndex(item => item.id === prompt.id);
  if (index === -1) {
    // New prompt
    prompt.id = prompt.id || generatePromptId();
    prompt.createdAt = now;
    prompt.updatedAt = now;
    prompts.push(prompt);
    selectedPromptId = prompt.id;
  } else {
    // Update existing prompt
    prompts[index] = {
      ...prompts[index],
      name: prompt.name,
      content: prompt.content,
      updatedAt: now
    };
  }

  try {
    await persistPrompts();
    renderPrompts();
    showPromptStatus(t('prompt__statusSaved'), 'success');
  } catch (error) {
    console.error('Failed to save prompt:', error);
    showPromptStatus(t('popup__statusError'), 'error');
  }
}

async function addPrompt() {
  const now = new Date().toISOString();
  const newPrompt = {
    id: generatePromptId(),
    name: getDefaultPromptName(prompts.length + 1),
    content: '',
    createdAt: now,
    updatedAt: now
  };
  prompts = [newPrompt, ...prompts];
  selectedPromptId = newPrompt.id;
  renderPrompts();
  updatePromptForm(newPrompt);
  setPromptEmptyState(false);
  elements.promptName.focus();
  try {
    await persistPrompts();
  } catch (error) {
    console.error('Failed to add prompt:', error);
  }
}

async function deletePrompt() {
  if (!selectedPromptId) return;
  const deletedId = selectedPromptId;

  prompts = prompts.filter(prompt => prompt.id !== selectedPromptId);

  if (prompts.length === 0) {
    defaultPromptId = null;
    selectedPromptId = null;
  } else {
    if (selectedPromptId === defaultPromptId) {
      defaultPromptId = null;
    }
    selectedPromptId = prompts[0].id;
  }

  const selectedPrompt = getPromptById(selectedPromptId);
  try {
    await persistPrompts();
    renderPrompts();
    if (selectedPrompt) {
      updatePromptForm(selectedPrompt);
      setPromptEmptyState(false);
    } else {
      clearPromptForm();
      setPromptEmptyState(true);
    }
    showPromptStatus(t('prompt__statusDeleted'), 'success');
  } catch (error) {
    console.error('Failed to delete prompt:', error);
    showPromptStatus(t('popup__statusError'), 'error');
  }
}

async function setDefaultPrompt(promptId) {
  defaultPromptId = promptId || null;
  try {
    await chrome.storage.local.set({ default_system_prompt_id: defaultPromptId || '' });
    renderPrompts();
    if (defaultPromptId) {
      showPromptStatus(t('prompt__statusDefaultSet'), 'success');
    }
  } catch (error) {
    console.error('Failed to set default prompt:', error);
    showPromptStatus(t('popup__statusError'), 'error');
  }
}

async function persistPrompts() {
  await chrome.storage.local.set({
    system_prompts: prompts,
    default_system_prompt_id: defaultPromptId || ''
  });
}

function generatePromptId() {
  if (crypto?.randomUUID) {
    return `prompt-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getDefaultPromptName(index) {
  return t('prompt__defaultName', index);
}

function getPromptById(promptId) {
  return prompts.find(prompt => prompt.id === promptId);
}

// ===== Prompt Import/Export Functions =====

async function exportPrompts() {
  try {
    if (prompts.length === 0) {
      showPromptStatus(t('config__errorNoPrompts'), 'error');
      return;
    }

    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      prompts: prompts,
      defaultPromptId: defaultPromptId
    };

    const content = JSON.stringify(exportData, null, 2);
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompts-${getTimestamp()}.json`;
    a.click();
    URL.revokeObjectURL(url);

    showPromptStatus(t('config__statusExported', prompts.length), 'success');
  } catch (error) {
    console.error('Failed to export prompts:', error);
    showPromptStatus(t('popup__statusError'), 'error');
  }
}

async function importPrompts(event) {
  const file = event.target.files[0];
  if (!file) return;

  // Reset input to allow importing the same file again
  event.target.value = '';

  try {
    const content = await file.text();
    const importData = JSON.parse(content);

    // Validate import data structure
    if (!importData.prompts || !Array.isArray(importData.prompts)) {
      showPromptStatus(t('config__errorInvalidFormat'), 'error');
      return;
    }

    // Validate each prompt
    for (const prompt of importData.prompts) {
      if (!prompt.id || !prompt.name) {
        showPromptStatus(t('config__errorInvalidPrompt'), 'error');
        return;
      }
    }

    let updatedCount = 0;
    let addedCount = 0;

    // Merge prompts: same ID updates, different ID adds
    for (const importedPrompt of importData.prompts) {
      const existingIndex = prompts.findIndex(p => p.id === importedPrompt.id);
      if (existingIndex !== -1) {
        // Update existing prompt
        prompts[existingIndex] = importedPrompt;
        updatedCount++;
      } else {
        // Add new prompt
        prompts.push(importedPrompt);
        addedCount++;
      }
    }

    // Update default prompt ID if imported and valid
    if (importData.defaultPromptId && prompts.some(p => p.id === importData.defaultPromptId)) {
      defaultPromptId = importData.defaultPromptId;
      await chrome.storage.local.set({ default_system_prompt_id: defaultPromptId });
    } else if (prompts.length > 0 && !defaultPromptId) {
      // Keep existing default or set to null
      defaultPromptId = null;
    }

    // Ensure selected prompt is valid
    if (!prompts.find(p => p.id === selectedPromptId)) {
      selectedPromptId = defaultPromptId || prompts[0]?.id || null;
    }

    await persistPrompts();
    renderPrompts();

    const selectedPrompt = getPromptById(selectedPromptId);
    if (selectedPrompt) {
      updatePromptForm(selectedPrompt);
      setPromptEmptyState(false);
    } else {
      clearPromptForm();
      setPromptEmptyState(true);
    }

    const message = t('config__statusImported', [
      String(addedCount),
      String(updatedCount)
    ]);
    showPromptStatus(message, 'success');
  } catch (error) {
    console.error('Failed to import prompts:', error);
    showPromptStatus(t('config__errorImportFailed'), 'error');
  }
}

function showPromptStatus(message, type = 'success') {
  elements.promptStatus.textContent = message;
  elements.promptStatus.className = `status show ${type}`;

  setTimeout(() => {
    elements.promptStatus.classList.remove('show');
  }, 3000);
}


function showStatus(message, type = 'success') {
  elements.status.textContent = message;
  elements.status.className = `status show ${type}`;

  setTimeout(() => {
    elements.status.classList.remove('show');
  }, 3000);
}

async function loadHistory() {
  try {
    const result = await chrome.storage.local.get(['chat_history']);
    const history = result.chat_history || [];

    if (history.length === 0) {
      elements.historyList.innerHTML = `
        <div class="history-empty">
          <div class="history-empty-icon">💬</div>
          <div data-i18n="history.empty">${t('history__empty')}</div>
        </div>
      `;
      return;
    }

    elements.historyList.innerHTML = history.map(chat => createHistoryItem(chat)).join('');

    history.forEach(chat => {
      const viewBtn = document.getElementById(`view-${chat.chatId}`);
      const deleteBtn = document.getElementById(`delete-${chat.chatId}`);
      const exportBtn = document.getElementById(`export-${chat.chatId}`);

      if (viewBtn) {
        viewBtn.addEventListener('click', () => viewChat(chat));
      }

      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          showConfirmDialog(t('history__confirmDeleteItem', escapeHtml(chat.title)), async () => {
            await deleteChat(chat.chatId);
          });
        });
      }

      if (exportBtn) {
        exportBtn.addEventListener('click', () => {
          currentChatId = chat.chatId;
          openModal('exportModal');
        });
      }
    });
  } catch (error) {
    console.error('Failed to load history:', error);
    elements.historyList.innerHTML = `
      <div class="history-empty">
        <div class="history-empty-icon">⚠️</div>
        <div>${t('common__error')}: ${error.message}</div>
      </div>
    `;
  }
}

function createHistoryItem(chat) {
  const timeAgo = getRelativeTime(chat.updatedAt);

  return `
    <div class="history-item">
      <div class="history-item-header">
        <div class="history-item-icon">💬</div>
        <div class="history-item-title">${escapeHtml(chat.title)}</div>
      </div>
      <div class="history-item-meta">
        ${timeAgo} · ${t('history__messageCount', chat.messageCount)}
      </div>
      <div class="history-item-actions">
        <button class="btn btn-secondary" id="view-${chat.chatId}">${t('history__btnView')}</button>
        <button class="btn btn-secondary" id="export-${chat.chatId}">${t('history__btnExport')}</button>
        <button class="btn btn-danger" id="delete-${chat.chatId}">${t('history__btnDelete')}</button>
      </div>
    </div>
  `;
}

async function viewChat(chat) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      showHistoryStatus(t('history__errorGetTab'), 'error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, {
      type: 'OPEN_HISTORY_CHAT',
      chatId: chat.chatId,
      title: chat.title,
      promptId: chat.promptId || null,
      profileId: chat.profileId || null,
      messages: chat.messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }))
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Failed to send message:', chrome.runtime.lastError);
        showHistoryStatus(t('history__errorOpenWindow'), 'error');
      } else if (response && response.success) {
        showHistoryStatus(t('history__successWindowOpened'), 'success');
      }
    });
  } catch (error) {
    console.error('Failed to open chat:', error);
    showHistoryStatus(t('history__errorOpenFailed') + error.message, 'error');
  }
}

async function deleteChat(chatId) {
  try {
    const result = await chrome.storage.local.get(['chat_history']);
    const history = result.chat_history || [];

    const newHistory = history.filter(chat => chat.chatId !== chatId);
    await chrome.storage.local.set({ chat_history: newHistory });

    showHistoryStatus(t('history__successDeleted'), 'success');
    await loadHistory();
  } catch (error) {
    console.error('Failed to delete chat:', error);
    showHistoryStatus(t('history__errorDeleted'), 'error');
  }
}

async function clearAllHistory() {
  try {
    await chrome.storage.local.set({ chat_history: [] });
    showHistoryStatus(t('history__successCleared'), 'success');
    await loadHistory();
  } catch (error) {
    console.error('Failed to clear history:', error);
    showHistoryStatus(t('history__errorDeleted'), 'error');
  }
}

async function exportChat(format = 'markdown') {
  closeModal('exportModal');

  try {
    const result = await chrome.storage.local.get(['chat_history']);
    const history = result.chat_history || [];

    let content = '';
    let filename = '';
    const exportFormat = format === 'text' ? 'text' : 'markdown';
    const type = exportFormat === 'text' ? 'text/plain' : 'text/markdown';

    if (currentChatId === 'all') {
      content = exportAllAsMarkdown(history);
      filename = `ai-chats-all-${getTimestamp()}.${exportFormat === 'text' ? 'txt' : 'md'}`;
    } else {
      const chat = history.find(c => c.chatId === currentChatId);
      if (!chat) {
        showHistoryStatus(t('history__errorChatNotFound'), 'error');
        return;
      }

      content = exportSingleAsMarkdown(chat);
      filename = `ai-chat-${getTimestamp()}.${exportFormat === 'text' ? 'txt' : 'md'}`;
    }

    if (exportFormat === 'text') {
      content = toPlainText(content);
    }

    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showHistoryStatus(t('history__successExported'), 'success');
  } catch (error) {
    console.error('Failed to export:', error);
    showHistoryStatus(t('history__errorExported'), 'error');
  }
}

function exportSingleAsMarkdown(chat) {
  const date = new Date(chat.updatedAt).toLocaleString(chrome.i18n.getUILanguage());

  let content = `# ${chat.title}\n\n`;
  content += `${t('export__chatTime')}: ${date}\n`;
  content += `${t('export__messageCount')}: ${chat.messageCount}\n\n`;
  content += `---\n\n`;

  chat.messages.forEach(msg => {
    const role = msg.role === 'user' ? t('export__roleUser') : t('export__roleAI');
    content += `${role}\n\n${msg.content}\n\n`;
  });

  return content;
}

function exportAllAsMarkdown(history) {
  let content = `# ${t('export__title')}\n\n`;
  content += `${t('export__exportTime')}: ${new Date().toLocaleString(chrome.i18n.getUILanguage())}\n`;
  content += `${t('export__chatCount')}: ${history.length}\n\n`;
  content += `---\n\n`;

  history.forEach((chat, index) => {
    content += `## ${index + 1}. ${chat.title}\n\n`;
    content += `${t('export__time')}: ${new Date(chat.updatedAt).toLocaleString(chrome.i18n.getUILanguage())}\n`;
    content += `${t('export__messageCount')}: ${chat.messageCount}\n\n`;

    chat.messages.forEach(msg => {
      const role = msg.role === 'user' ? '👤' : '🤖';
      content += `### ${role}\n\n${msg.content}\n\n`;
    });

    content += `---\n\n`;
  });

  return content;
}

function toPlainText(markdown) {
  if (typeof removeMarkdown !== 'function') {
    return markdown;
  }
  return removeMarkdown(markdown);
}

function getRelativeTime(isoString) {
  const now = new Date();
  const date = new Date(isoString);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('time__justNow');
  if (diffMins < 60) return t('time__minutesAgo', diffMins);
  if (diffHours < 24) return t('time__hoursAgo', diffHours);
  if (diffDays < 7) return t('time__daysAgo', diffDays);

  const locale = chrome.i18n.getUILanguage();
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function getTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showHistoryStatus(message, type = 'success') {
  elements.historyStatus.textContent = message;
  elements.historyStatus.className = `status show ${type}`;

  setTimeout(() => {
    elements.historyStatus.classList.remove('show');
  }, 3000);
}

function openModal(modalId) {
  document.getElementById(modalId).classList.add('show');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('show');
  }
}

function showConfirmDialog(text, onConfirm) {
  elements.confirmText.textContent = text;
  openModal('confirmModal');

  // Clone and replace button to remove previous event listeners
  const newBtn = elements.confirmBtn.cloneNode(true);
  elements.confirmBtn.parentNode.replaceChild(newBtn, elements.confirmBtn);
  elements.confirmBtn = newBtn;

  elements.confirmBtn.addEventListener('click', async () => {
    closeModal('confirmModal');
    await onConfirm();
  });
}

document.addEventListener('DOMContentLoaded', init);
