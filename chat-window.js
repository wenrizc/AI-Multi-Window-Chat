import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';

marked.use(markedKatex({
  throwOnError: false
}));

class ChatWindow {
  constructor() {
    this.windowId = null;
    this.chatId = null;
    this.title = null;
    this.promptId = null;
    this.profileId = null;
    this.messages = [];
    this.isLoading = false;

    // Prompts
    this.prompts = [];
    this.selectedPrompt = null;

    // API Profiles (Configs)
    this.apiProfiles = [];
    this.selectedProfile = null;

    this.elements = {
      messagesContainer: document.getElementById('messagesContainer'),
      messageInput: document.getElementById('messageInput'),
      sendBtn: document.getElementById('sendBtn'),
      loadingIndicator: document.getElementById('loadingIndicator'),
      promptSelect: document.getElementById('promptSelect'),
      profileSelect: document.getElementById('profileSelect')
    };

    this.init();
  }

  async init() {
    document.documentElement.lang = chrome.i18n.getUILanguage() || 'en';

    updatePageTranslations();

    this.setupEventListeners();
    this.setupPostMessageListener();
  }

  setupEventListeners() {
    this.elements.sendBtn.addEventListener('click', () => {
      this.sendMessage();
    });

    document.addEventListener('keydown', (e) => {
      // Alt + C: copy latest assistant message (fallback to latest message)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key?.toLowerCase() === 'c') {
        e.preventDefault();
        this.copyLatestMessage();
      }
    });

    this.elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.elements.messageInput.addEventListener('input', () => {
      this.adjustTextareaHeight();
    });

    this.elements.profileSelect?.addEventListener('change', () => {
      const selectedId = this.elements.profileSelect.value;
      this.selectedProfile = selectedId ? this.getProfileById(selectedId) : null;

      if (this.messages.length > 0) {
        this.saveChatHistory();
      }
    });
  }

  setupPostMessageListener() {
    window.addEventListener('message', (event) => {
      if (event.data.type === 'INIT_CHAT') {
        this.windowId = event.data.windowId;

        // Use existing chatId or generate new one in format: chat-YYYYMMDD-HHMMSS
        if (event.data.chatId) {
          this.chatId = event.data.chatId;
        } else {
          const now = new Date();
          this.chatId = `chat-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
        }

        this.title = event.data.title || t('chat__windowTitle', '1');
        this.promptId = event.data.promptId || null;
        this.profileId = event.data.profileId || null;

        if (event.data.historyMessages && Array.isArray(event.data.historyMessages)) {
          this.loadHistoryMessages(event.data.historyMessages);
        }

        if (event.data.initialMessage) {
          this.elements.messageInput.value = event.data.initialMessage;
          this.adjustTextareaHeight();
          this.elements.messageInput.focus();
        }

        // Load prompts and configs after receiving chat data
        this.loadPrompts(this.promptId);
        this.loadApiProfiles(this.profileId);

        window.addEventListener('message', (e) => {
          if (e.data.type === 'UPDATE_TITLE' && e.data.windowId === this.windowId) {
            this.title = e.data.title;
            this.saveChatHistory();
          }
        });
      }
    });
  }

  loadHistoryMessages(historyMessages) {
    historyMessages.forEach(msg => {
      this.removeWelcomeMessage();
      const messageEl = this.createMessageElement(msg);
      this.elements.messagesContainer.appendChild(messageEl);

      this.messages.push({
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp || null
      });
    });

    this.scrollToBottom();
  }

  createMessageElement(msg) {
    const messageEl = document.createElement('div');
    messageEl.className = `message message-${msg.role}`;

    const messageHeader = document.createElement('div');
    messageHeader.className = 'message-header';

    const avatar = document.createElement('span');
    avatar.className = 'message-avatar';
    avatar.textContent = msg.role === 'user' ? '👤' : '🤖';

    const roleText = document.createElement('span');
    roleText.className = 'message-role';
    roleText.textContent = msg.role === 'user' ? t('chat__roleUser') : t('chat__roleAI');

    messageHeader.appendChild(avatar);
    messageHeader.appendChild(roleText);

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    if (msg.role === 'assistant') {
      messageContent.innerHTML = this.formatMessage(msg.content);
    } else {
      messageContent.textContent = msg.content;
    }

    messageEl.appendChild(messageHeader);
    messageEl.appendChild(messageContent);

    const messageFooter = document.createElement('div');
    messageFooter.className = 'message-footer';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'message-copy-btn';
    copyBtn.setAttribute('aria-label', t('chat__btnCopyMessage'));
    copyBtn.innerHTML = `
      <svg class="message-copy-icon message-copy-icon-copy" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
      </svg>
      <svg class="message-copy-icon message-copy-icon-check" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>
      </svg>
    `;

    copyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.copyTextWithFeedback(msg.content, copyBtn);
    });

    messageFooter.appendChild(copyBtn);
    messageEl.appendChild(messageFooter);

    return messageEl;
  }

  getLatestCopyText() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (!msg || typeof msg.content !== 'string') continue;
      if (msg.role === 'assistant') return msg.content;
    }

    const last = this.messages[this.messages.length - 1];
    return last?.content || '';
  }

  async copyLatestMessage() {
    const text = this.getLatestCopyText();
    if (!text) return;
    await this.copyTextWithFeedback(text, null);
  }

  async copyTextWithFeedback(text, btn = null) {
    const ok = await this.copyToClipboard(text);
    if (!ok) return;

    if (btn) {
      btn.dataset.copied = 'true';
      clearTimeout(btn._copiedTimer);
      btn._copiedTimer = setTimeout(() => {
        btn.dataset.copied = 'false';
      }, 1200);
    }
  }

  async copyToClipboard(text) {
    if (typeof text !== 'string') return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for older browsers / blocked clipboard API
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-9999px';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        const ok = document.execCommand('copy');
        textarea.remove();
        return ok;
      } catch (e) {
        return false;
      }
    }
  }

  adjustTextareaHeight() {
    const textarea = this.elements.messageInput;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  removeWelcomeMessage() {
    const welcomeMessage = this.elements.messagesContainer.querySelector('.welcome-message');
    if (welcomeMessage) {
      welcomeMessage.remove();
    }
  }

  async sendMessage() {
    const content = this.elements.messageInput.value.trim();

    if (!content || this.isLoading) return;

    this.addMessage('user', content);

    this.elements.messageInput.value = '';
    this.adjustTextareaHeight();

    this.isLoading = true;
    this.showLoadingIndicator();

    try {
      // Build request messages
      let requestMessages = [];

      // Add system message if prompt is selected
      if (this.selectedPrompt && this.selectedPrompt.content) {
        requestMessages.push({
          role: 'system',
          content: this.selectedPrompt.content
        });
      }

      // Add conversation history
      requestMessages = requestMessages.concat(this.messages);

      const response = await chrome.runtime.sendMessage({
        type: 'CHAT_REQUEST',
        messages: requestMessages,
        profileId: this.selectedProfile?.id || null
      });

      if (response.success) {
        this.addMessage('assistant', response.data);
        await this.saveChatHistory();
      } else {
        this.addMessage('assistant', `❌ ${response.error}`);
      }
    } catch (error) {
      this.addMessage('assistant', `❌: ${error.message}`);
    } finally {
      this.isLoading = false;
      this.hideLoadingIndicator();
    }
  }

  addMessage(role, content) {
    const message = {
      role,
      content,
      timestamp: new Date().toISOString()
    };
    this.messages.push(message);

    this.removeWelcomeMessage();

    const messageEl = this.createMessageElement(message);
    this.elements.messagesContainer.appendChild(messageEl);
    this.scrollToBottom();

    return messageEl.querySelector('.message-content');
  }

  showLoadingIndicator() {
    this.elements.loadingIndicator.style.display = 'flex';
    this.scrollToBottom();
  }

  hideLoadingIndicator() {
    this.elements.loadingIndicator.style.display = 'none';
  }

  scrollToBottom() {
    const container = this.elements.messagesContainer;
    container.scrollTop = container.scrollHeight;
  }

  // Parse markdown content for assistant messages
  formatMessage(content) {
    return marked.parse(content);
  }

  async saveChatHistory() {
    try {
      if (!this.chatId) return;
      const result = await chrome.storage.local.get(['chat_history']);
      const history = result.chat_history || [];

      const messagesWithTimestamp = this.messages.map(msg => ({
        ...msg,
        timestamp: msg.timestamp || new Date().toISOString()
      }));

      const existingIndex = history.findIndex(chat => chat.chatId === this.chatId);

      const chatData = {
        chatId: this.chatId,
        title: this.title,
        promptId: this.selectedPrompt?.id || '',
        profileId: this.selectedProfile?.id || '',
        createdAt: this.chatId ? this.chatId.replace('chat-', '').replace(/-/g, ':') : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messageCount: this.messages.length,
        messages: messagesWithTimestamp
      };

      if (existingIndex >= 0) {
        history[existingIndex] = chatData;
      } else {
        history.unshift(chatData);
      }

      await chrome.storage.local.set({ chat_history: history });
    } catch (error) {
      console.error('Failed to save chat history:', error);
    }
  }

  // ===== Prompt Functions =====

  async loadPrompts(historyPromptId = null) {
    try {
      const result = await chrome.storage.local.get(['system_prompts', 'default_system_prompt_id']);
      this.prompts = Array.isArray(result.system_prompts) ? result.system_prompts : [];
      const defaultPromptId = result.default_system_prompt_id || '';

      // Determine target prompt ID FIRST
      // Priority: history prompt > global default > "no prompt" (null)
      let targetPromptId = null;

      if (historyPromptId) {
        // If restoring from history, use history prompt
        const promptExists = this.prompts.some(p => p.id === historyPromptId);
        if (promptExists) {
          targetPromptId = historyPromptId;
        } else {
          console.warn(`Prompt "${historyPromptId}" has been deleted, using global default or no prompt`);
          // Fall through to use global default
        }
      }

      // For new chats (or when history prompt was deleted), use global default if set
      if (!targetPromptId && defaultPromptId) {
        const defaultExists = this.prompts.some(p => p.id === defaultPromptId);
        if (defaultExists) {
          targetPromptId = defaultPromptId;
        }
      }

      // Set selected prompt BEFORE rendering
      if (targetPromptId) {
        this.selectedPrompt = this.getPromptById(targetPromptId);
      } else {
        this.selectedPrompt = null;
      }

      // Render selector with the correct value already determined
      this.renderPromptSelector(targetPromptId);

      // Setup change listener
      this.elements.promptSelect.addEventListener('change', () => {
        const selectedId = this.elements.promptSelect.value;
        this.selectedPrompt = selectedId ? this.getPromptById(selectedId) : null;
      });
    } catch (error) {
      console.error('Failed to load prompts:', error);
    }
  }

  renderPromptSelector(selectedId = null) {
    const select = this.elements.promptSelect;
    select.innerHTML = `<option value="">${t('prompt__noPrompt')}</option>`;

    this.prompts.forEach(prompt => {
      const option = document.createElement('option');
      option.value = prompt.id;
      option.textContent = prompt.name || t('prompt__empty');
      if (prompt.id === selectedId) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  getPromptById(promptId) {
    if (!promptId) return null;
    return this.prompts.find(p => p.id === promptId) || null;
  }

  // ===== Config (API Profile) Functions =====

  async loadApiProfiles(historyProfileId = null) {
    try {
      const result = await chrome.storage.local.get(['apiProfiles', 'activeApiProfileId']);
      this.apiProfiles = Array.isArray(result.apiProfiles) ? result.apiProfiles : [];
      const activeProfileId = result.activeApiProfileId || '';

      let targetProfileId = null;

      if (historyProfileId) {
        const exists = this.apiProfiles.some(p => p.id === historyProfileId);
        if (exists) {
          targetProfileId = historyProfileId;
        }
      }

      // For new chats (or when history profile was deleted), use global default if set
      if (!targetProfileId && activeProfileId) {
        const exists = this.apiProfiles.some(p => p.id === activeProfileId);
        if (exists) {
          targetProfileId = activeProfileId;
        }
      }

      if (!targetProfileId && this.apiProfiles.length > 0) {
        targetProfileId = this.apiProfiles[0].id;
      }

      this.selectedProfile = targetProfileId ? this.getProfileById(targetProfileId) : null;
      this.renderProfileSelect(targetProfileId);
    } catch (error) {
      console.error('Failed to load api profiles:', error);
      this.apiProfiles = [];
      this.selectedProfile = null;
      this.renderProfileSelect(null);
    }
  }

  renderProfileSelect(selectedId = null) {
    const select = this.elements.profileSelect;
    if (!select) return;

    if (!Array.isArray(this.apiProfiles) || this.apiProfiles.length === 0) {
      select.innerHTML = '<option value=""></option>';
      select.value = '';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML = '';

    this.apiProfiles.forEach((profile) => {
      const option = document.createElement('option');
      option.value = profile.id;
      option.textContent = profile.name || t('popup__profileNameEmpty');
      if (profile.id === selectedId) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    select.value = selectedId || '';
  }

  getProfileById(profileId) {
    if (!profileId) return null;
    return this.apiProfiles.find(p => p.id === profileId) || null;
  }
}

new ChatWindow();
