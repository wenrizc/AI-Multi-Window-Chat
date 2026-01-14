class AIMultiWindow {
  constructor() {
    this.windows = new Map();
    this.windowCounter = 0;
    this.init();
  }

  async init() {
    this.setupTextSelection();
    this.setupKeyboardShortcuts();
    this.setupRuntimeMessageListener();
  }

  setupTextSelection() {
    let selectionTimeout;

    // Debounce text selection to avoid triggering while still selecting
    document.addEventListener('mouseup', (e) => {
      if (e.target.closest('.ai-multi-window') || e.target.closest('.ai-selection-toolbar')) return;

      clearTimeout(selectionTimeout);
      selectionTimeout = setTimeout(() => {
        this.handleTextSelection(e);
      }, 300);
    });

    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.ai-selection-toolbar')) {
        this.hideToolbar();
      }
    });
  }

  handleTextSelection(event) {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();

    if (selectedText.length < 2) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    this.showToolbar(rect, selectedText);
  }

  showToolbar(rect, selectedText) {
    let toolbar = document.querySelector('.ai-selection-toolbar');

    if (!toolbar) {
      toolbar = this.createToolbar();
      document.body.appendChild(toolbar);
    }

    toolbar.dataset.selectedText = selectedText;

    const toolbarRect = toolbar.getBoundingClientRect();
    let top = rect.top - toolbarRect.height - 8;
    let left = rect.left + (rect.width - toolbarRect.width) / 2;

    if (top < 10) top = rect.bottom + 8;
    if (left < 10) left = 10;
    if (left + toolbarRect.width > window.innerWidth - 10) {
      left = window.innerWidth - toolbarRect.width - 10;
    }

    toolbar.style.top = `${top + window.scrollY}px`;
    toolbar.style.left = `${left + window.scrollX}px`;
    toolbar.style.display = 'flex';
  }

  createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'ai-selection-toolbar';
    toolbar.innerHTML = `
      <button class="ai-toolbar-btn" data-action="chat" title="${t('content__toolbarChat')}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
        <span>${t('content__toolbarBtnChat')}</span>
      </button>
    `;

    const btn = toolbar.querySelector('.ai-toolbar-btn');
    btn.addEventListener('click', () => {
      const selectedText = toolbar.dataset.selectedText;
      this.handleAction('chat', selectedText);
      this.hideToolbar();
    });

    return toolbar;
  }

  hideToolbar() {
    const toolbar = document.querySelector('.ai-selection-toolbar');
    if (toolbar) {
      toolbar.style.display = 'none';
    }
  }

  handleAction(action, selectedText) {
    switch (action) {
      case 'chat':
        this.createChatWindow(selectedText);
        break;
    }
  }

  createChatWindow(initialMessage = '', chatId = null, title = null, historyMessages = null, promptId = null) {
    this.windowCounter++;
    const windowId = `ai-window-${this.windowCounter}`;

    const windowContainer = document.createElement('div');
    windowContainer.id = windowId;
    windowContainer.className = 'ai-multi-window';
    windowContainer.innerHTML = `
      <div class="ai-window-header">
        <div class="ai-window-title">
          <span class="ai-window-number">${title || t('chat__windowTitle', this.windowCounter)}</span>
        </div>
        <div class="ai-window-controls">
          <button class="ai-window-btn ai-minimize-btn" title="${t('content__btnMinimize')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 13H5v-2h14v2z"/>
            </svg>
          </button>
          <button class="ai-window-btn ai-close-btn" title="${t('content__btnClose')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="ai-window-content">
        <iframe class="ai-chat-iframe" src="${chrome.runtime.getURL('chat-window.html')}"></iframe>
      </div>
    `;

    document.body.appendChild(windowContainer);

    const offset = (this.windowCounter - 1) * 30;
    windowContainer.style.top = `${80 + offset}px`;
    windowContainer.style.left = `${200 + offset}px`;

    this.makeDraggable(windowContainer);

    this.makeResizable(windowContainer);

    this.bindWindowControls(windowContainer, windowId);

    this.windows.set(windowId, {
      element: windowContainer,
      initialMessage: initialMessage
    });

    setTimeout(() => {
      const iframe = windowContainer.querySelector('iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'INIT_CHAT',
          windowId: windowId,
          initialMessage: initialMessage,
          chatId: chatId,
          title: title,
          historyMessages: historyMessages,
          promptId: promptId
        }, '*');
      }
    }, 500);

    return windowId;
  }

  makeDraggable(windowElement) {
    const header = windowElement.querySelector('.ai-window-header');
    let isDragging = false;
    let startX, startY, initialX, initialY;
    let onMouseMove = null;
    let onMouseUp = null;

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ai-window-controls')) return;
      if (e.target.closest('.ai-window-number')) return;
      if (e.target.closest('.ai-title-input')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialX = windowElement.offsetLeft;
      initialY = windowElement.offsetTop;
      windowElement.style.zIndex = this.getHighestZIndex() + 1;
      windowElement.style.cursor = 'move';

      onMouseMove = (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        windowElement.style.left = `${initialX + dx}px`;
        windowElement.style.top = `${initialY + dy}px`;
      };

      onMouseUp = () => {
        isDragging = false;
        windowElement.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Track highest z-index to bring focused window to front
  getHighestZIndex() {
    let max = 100;
    document.querySelectorAll('.ai-multi-window').forEach(win => {
      const zIndex = parseInt(window.getComputedStyle(win).zIndex) || 100;
      if (zIndex > max) max = zIndex;
    });
    return max;
  }

  makeResizable(windowElement) {
    const minWidth = 350;
    const minHeight = 400;

    // Create resize handles: e=east, w=west, s=south, se=southeast, sw=southwest
    const resizeHandles = ['e', 'w', 's', 'se', 'sw'];

    resizeHandles.forEach(position => {
      const handle = document.createElement('div');
      handle.className = `ai-resize-handle ai-resize-${position}`;
      windowElement.appendChild(handle);

      let isResizing = false;
      let startX, startY, startWidth, startHeight, startLeft, startTop;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startWidth = windowElement.offsetWidth;
        startHeight = windowElement.offsetHeight;
        startLeft = windowElement.offsetLeft;
        startTop = windowElement.offsetTop;

        windowElement.style.zIndex = this.getHighestZIndex() + 1;

        const onMouseMove = (e) => {
          if (!isResizing) return;

          const dx = e.clientX - startX;
          const dy = e.clientY - startY;

          if (position.includes('e')) {
            const newWidth = Math.max(minWidth, startWidth + dx);
            windowElement.style.width = `${newWidth}px`;
          }
          if (position.includes('w')) {
            const newWidth = Math.max(minWidth, startWidth - dx);
            if (newWidth > minWidth) {
              windowElement.style.width = `${newWidth}px`;
              windowElement.style.left = `${startLeft + dx}px`;
            }
          }
          if (position.includes('s')) {
            const newHeight = Math.max(minHeight, startHeight + dy);
            windowElement.style.height = `${newHeight}px`;
          }
        };

        const onMouseUp = () => {
          isResizing = false;
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  bindWindowControls(windowElement, windowId) {
    const titleElement = windowElement.querySelector('.ai-window-number');

    titleElement.addEventListener('click', (e) => {
      e.stopPropagation();
      this.editTitle(titleElement, windowId);
    });

    const closeBtn = windowElement.querySelector('.ai-close-btn');
    closeBtn.addEventListener('click', () => {
      this.closeWindow(windowId);
    });

    const minimizeBtn = windowElement.querySelector('.ai-minimize-btn');
    minimizeBtn.addEventListener('click', () => {
      const content = windowElement.querySelector('.ai-window-content');
      const isMinimized = content.style.display === 'none';
      content.style.display = isMinimized ? 'block' : 'none';
      windowElement.classList.toggle('minimized', !isMinimized);
    });

    windowElement.addEventListener('mousedown', () => {
      windowElement.style.zIndex = this.getHighestZIndex() + 1;
    });
  }

  editTitle(titleElement, windowId) {
    const currentTitle = titleElement.textContent;
    const windowContainer = document.getElementById(windowId);

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'ai-title-input';

    titleElement.style.display = 'none';
    titleElement.parentNode.insertBefore(input, titleElement.nextSibling);
    input.focus();
    input.select();

    const saveTitle = () => {
      const newTitle = input.value.trim() || currentTitle;
      titleElement.textContent = newTitle;
      titleElement.style.display = '';
      input.remove();

      const iframe = windowContainer.querySelector('iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'UPDATE_TITLE',
          windowId: windowId,
          title: newTitle
        }, '*');
      }
    };

    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        titleElement.style.display = '';
        input.remove();
      }
    });
  }

  closeWindow(windowId) {
    const windowData = this.windows.get(windowId);
    if (windowData) {
      const iframe = windowData.element.querySelector('iframe');
      if (iframe) {
        iframe.src = 'about:blank';
        iframe.remove();
      }

      windowData.element.remove();

      this.windows.delete(windowId);
    }
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        const selection = window.getSelection();
        const selectedText = selection.toString().trim();
        this.createChatWindow(selectedText);
      }

      if (e.altKey && e.key === 'Escape') {
        e.preventDefault();
        this.windows.forEach((_, windowId) => {
          this.closeWindow(windowId);
        });
      }
    });
  }

  setupRuntimeMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'OPEN_HISTORY_CHAT') {
        const { chatId, title, messages, promptId } = request;
        this.createChatWindow('', chatId, title, messages, promptId);
        sendResponse({ success: true });
        return true;
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new AIMultiWindow();
  });
} else {
  new AIMultiWindow();
}
