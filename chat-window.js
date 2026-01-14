import { marked } from 'marked';

class ChatWindow {
  constructor() {
    this.windowId = null;
    this.chatId = null;
    this.title = null;
    this.promptId = null;
    this.messages = [];
    this.isLoading = false;

    // Prompts
    this.prompts = [];
    this.selectedPrompt = null;

    this.elements = {
      messagesContainer: document.getElementById('messagesContainer'),
      messageInput: document.getElementById('messageInput'),
      sendBtn: document.getElementById('sendBtn'),
      loadingIndicator: document.getElementById('loadingIndicator'),
      promptSelect: document.getElementById('promptSelect')
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

    this.elements.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.elements.messageInput.addEventListener('input', () => {
      this.adjustTextareaHeight();
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

        if (event.data.historyMessages && Array.isArray(event.data.historyMessages)) {
          this.loadHistoryMessages(event.data.historyMessages);
        }

        if (event.data.initialMessage) {
          this.elements.messageInput.value = event.data.initialMessage;
          this.adjustTextareaHeight();
          this.elements.messageInput.focus();
        }

        // Load prompts after receiving chat data
        this.loadPrompts();

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

    return messageEl;
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
        messages: requestMessages
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

      // Render selector
      this.renderPromptSelector();

      // Determine target prompt ID
      // Priority: history prompt > "no prompt" (null) > global default
      let targetPromptId = null;

      if (historyPromptId) {
        // If restoring from history, use history prompt
        const promptExists = this.prompts.some(p => p.id === historyPromptId);
        if (promptExists) {
          targetPromptId = historyPromptId;
        } else {
          console.warn(`Prompt "${historyPromptId}" has been deleted, using "no prompt"`);
          targetPromptId = null;
        }
      }
      // For new chats, default to "no prompt" (null), not global default

      // Set selected prompt
      if (targetPromptId) {
        this.selectedPrompt = this.getPromptById(targetPromptId);
        this.elements.promptSelect.value = targetPromptId;
      } else {
        this.selectedPrompt = null;
        this.elements.promptSelect.value = '';
      }

      // Setup change listener
      this.elements.promptSelect.addEventListener('change', () => {
        const selectedId = this.elements.promptSelect.value;
        this.selectedPrompt = selectedId ? this.getPromptById(selectedId) : null;
      });
    } catch (error) {
      console.error('Failed to load prompts:', error);
    }
  }

  renderPromptSelector() {
    const select = this.elements.promptSelect;
    select.innerHTML = `<option value="">${t('prompt__noPrompt')}</option>`;

    this.prompts.forEach(prompt => {
      const option = document.createElement('option');
      option.value = prompt.id;
      option.textContent = prompt.name || t('prompt__empty');
      select.appendChild(option);
    });
  }

  getPromptById(promptId) {
    if (!promptId) return null;
    return this.prompts.find(p => p.id === promptId) || null;
  }
}

new ChatWindow();
