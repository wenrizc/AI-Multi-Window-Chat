import type { ChatSession } from '../shared/types';
import { escapeHtml, uid } from '../shared/utils';

declare global {
  interface Window {
    aiMultiWindowApp?: AIMultiWindow;
  }
}

class AIMultiWindow {
  private static readonly DEFAULT_WINDOW_WIDTH = 460;
  private static readonly DEFAULT_WINDOW_HEIGHT = 620;
  private static readonly MIN_WINDOW_WIDTH = 350;
  private static readonly MIN_WINDOW_HEIGHT = 400;
  private static readonly SETTINGS_PANEL_WINDOW_WIDTH = 390;
  private static readonly WINDOW_Z_INDEX_BASE = 2147483000;
  private windows = new Map<string, {
    chatId: string;
    element: HTMLElement;
    iframe: HTMLIFrameElement;
    titleDisplay: HTMLElement;
    titleInput: HTMLInputElement;
    cleanup: () => void;
  }>();
  private windowStack: string[] = [];
  private windowTitles = new Map<string, string>();
  private nextFreshWindowNumber = 1;
  private counter = 0;

  constructor() {
    this.init();
  }

  private init() {
    this.setupSelectionToolbar();
    this.setupKeyboardShortcuts();
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (request?.type === 'OPEN_CHAT_WINDOW') {
        this.createChatWindow('', request.chat as ChatSession);
        sendResponse?.({ success: true });
      }
    });
  }

  private setupSelectionToolbar() {
    let selectionTimeout: number | undefined;

    document.addEventListener('mouseup', (event) => {
      if ((event.target as HTMLElement)?.closest('.ai-multi-window') || (event.target as HTMLElement)?.closest('.ai-selection-toolbar')) {
        return;
      }
      window.clearTimeout(selectionTimeout);
      selectionTimeout = window.setTimeout(() => this.handleSelection(), 250);
    });

    document.addEventListener('mousedown', (event) => {
      if (!(event.target as HTMLElement)?.closest('.ai-selection-toolbar')) {
        this.hideToolbar();
      }
    });
  }

  private handleSelection() {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    if (selectedText.length < 2 || !selection?.rangeCount) {
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    this.showToolbar(rect, selectedText);
  }

  private createToolbar(): HTMLElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'ai-selection-toolbar';
    toolbar.innerHTML = `
      <button class="ai-toolbar-btn" type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
        <span>${t('content__aiChat')}</span>
      </button>
    `;

    toolbar.querySelector('button')?.addEventListener('click', () => {
      const text = toolbar.dataset.selectedText || '';
      this.createChatWindow(text);
      this.hideToolbar();
    });
    return toolbar;
  }

  private showToolbar(rect: DOMRect, selectedText: string) {
    let toolbar = document.querySelector('.ai-selection-toolbar') as HTMLElement | null;
    if (!toolbar) {
      toolbar = this.createToolbar();
      document.body.appendChild(toolbar);
    }
    toolbar.dataset.selectedText = selectedText;
    toolbar.style.display = 'flex';
    const toolbarRect = toolbar.getBoundingClientRect();
    let top = rect.top - toolbarRect.height - 8;
    let left = rect.left + (rect.width - toolbarRect.width) / 2;
    if (top < 10) {
      top = rect.bottom + 8;
    }
    if (left < 10) {
      left = 10;
    }
    if (left + toolbarRect.width > window.innerWidth - 10) {
      left = window.innerWidth - toolbarRect.width - 10;
    }
    toolbar.style.top = `${top + window.scrollY}px`;
    toolbar.style.left = `${left + window.scrollX}px`;
  }

  private hideToolbar() {
    const toolbar = document.querySelector('.ai-selection-toolbar') as HTMLElement | null;
    if (toolbar) {
      toolbar.style.display = 'none';
    }
  }

  private setupKeyboardShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        const selectedText = window.getSelection()?.toString().trim() || '';
        this.createChatWindow(selectedText);
      }
      if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        this.closeLastWindow();
      }
    });
  }

  private closeLastWindow() {
    const lastWindowId = this.windowStack.pop();
    if (!lastWindowId) {
      return;
    }
    this.closeWindow(lastWindowId);
  }

  private closeWindow(windowId: string) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      this.syncWindowStack();
      return;
    }

    this.windows.delete(windowId);
    this.windowStack = this.windowStack.filter((id) => id !== windowId);
    this.windowTitles.delete(windowId);
    entry.cleanup();
    entry.element.remove();
    this.syncWindowStack();
  }

  private activateWindow(windowId: string) {
    if (!this.windows.has(windowId)) {
      return;
    }

    this.windowStack = this.windowStack.filter((id) => id !== windowId);
    this.windowStack.push(windowId);
    this.syncWindowStack();
  }

  private syncWindowStack() {
    this.windowStack = this.windowStack.filter((id) => this.windows.has(id));
    this.windowStack.forEach((id, index) => {
      const entry = this.windows.get(id);
      if (!entry) {
        return;
      }
      entry.element.style.zIndex = String(AIMultiWindow.WINDOW_Z_INDEX_BASE + index);
    });
  }

  private createDefaultWindowTitle() {
    const title = t('content__aiChatTitle', { number: String(this.nextFreshWindowNumber) });
    this.nextFreshWindowNumber += 1;
    return title;
  }

  private beginTitleEdit(windowId: string) {
    const entry = this.windows.get(windowId);
    if (!entry || !entry.titleInput.hidden) {
      return;
    }

    this.activateWindow(windowId);
    entry.titleInput.value = this.windowTitles.get(windowId) || entry.titleDisplay.textContent || '';
    entry.titleDisplay.hidden = true;
    entry.titleInput.hidden = false;
    entry.titleInput.focus();
    entry.titleInput.select();
  }

  private cancelTitleEdit(windowId: string) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      return;
    }

    entry.titleInput.value = this.windowTitles.get(windowId) || entry.titleDisplay.textContent || '';
    entry.titleInput.hidden = true;
    entry.titleDisplay.hidden = false;
  }

  private commitWindowTitle(windowId: string, nextTitle: string) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      return;
    }

    const currentTitle = this.windowTitles.get(windowId) || entry.titleDisplay.textContent || '';
    const title = nextTitle.trim() || currentTitle;
    this.windowTitles.set(windowId, title);
    entry.titleDisplay.textContent = title;
    entry.titleInput.value = title;
    entry.titleInput.hidden = true;
    entry.titleDisplay.hidden = false;
    this.broadcastWindowTitle(windowId);
    void chrome.runtime.sendMessage({
      type: 'RENAME_CHAT',
      chatId: entry.chatId,
      title
    });
  }

  private broadcastWindowTitle(windowId: string) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      return;
    }

    const title = this.windowTitles.get(windowId) || entry.titleDisplay.textContent || '';
    entry.iframe.contentWindow?.postMessage(
      {
        type: 'WINDOW_TITLE_CHANGED',
        title
      },
      chrome.runtime.getURL('')
    );
  }

  private bindTitleEditor(windowId: string) {
    const entry = this.windows.get(windowId);
    if (!entry) {
      return;
    }

    entry.titleDisplay.addEventListener('click', (event) => {
      event.stopPropagation();
      this.beginTitleEdit(windowId);
    });
    entry.titleInput.addEventListener('click', (event) => {
      event.stopPropagation();
    });
    entry.titleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitWindowTitle(windowId, entry.titleInput.value);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.cancelTitleEdit(windowId);
      }
    });
    entry.titleInput.addEventListener('blur', () => {
      this.commitWindowTitle(windowId, entry.titleInput.value);
    });
  }

  createChatWindow(initialMessage = '', chat?: ChatSession) {
    this.counter += 1;
    const windowIndex = this.windows.size;
    const windowId = `ai-window-${Date.now()}-${this.counter}`;
    const chatId = chat?.chatId || uid('chat');
    const title = chat?.title || this.createDefaultWindowTitle();
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-multi-window';
    wrapper.id = windowId;
    wrapper.style.width = `${AIMultiWindow.DEFAULT_WINDOW_WIDTH}px`;
    wrapper.style.height = `${AIMultiWindow.DEFAULT_WINDOW_HEIGHT}px`;
    wrapper.style.minWidth = `${AIMultiWindow.MIN_WINDOW_WIDTH}px`;
    wrapper.style.minHeight = `${AIMultiWindow.MIN_WINDOW_HEIGHT}px`;
    wrapper.innerHTML = `
      <div class="ai-window-header">
        <div class="ai-window-title">
          <span class="ai-window-number">${escapeHtml(title)}</span>
          <input class="ai-title-input" type="text" value="${escapeHtmlAttr(title)}" hidden>
        </div>
        <div class="ai-window-controls">
          <button class="ai-window-btn ai-settings-btn" type="button" title="${escapeHtmlAttr(t('content__btnSettings'))}" aria-label="${escapeHtmlAttr(t('content__btnSettings'))}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button class="ai-window-btn ai-minimize-btn" type="button" title="${escapeHtmlAttr(t('content__btnMinimize'))}" aria-label="${escapeHtmlAttr(t('content__btnMinimize'))}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M5 12h14"></path>
            </svg>
          </button>
          <button class="ai-window-btn ai-close-btn" type="button" title="${escapeHtmlAttr(t('content__btnClose'))}" aria-label="${escapeHtmlAttr(t('content__btnClose'))}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18"></path>
              <path d="m6 6 12 12"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="ai-window-content">
        <iframe class="ai-chat-iframe" src="${chrome.runtime.getURL('chat-window.html')}"></iframe>
      </div>
      <div class="ai-resize-handle ai-resize-e" data-direction="e"></div>
      <div class="ai-resize-handle ai-resize-w" data-direction="w"></div>
      <div class="ai-resize-handle ai-resize-s" data-direction="s"></div>
      <div class="ai-resize-handle ai-resize-se" data-direction="se"></div>
      <div class="ai-resize-handle ai-resize-sw" data-direction="sw"></div>
    `;
    document.body.appendChild(wrapper);
    wrapper.style.top = `${80 + windowIndex * 28}px`;
    wrapper.style.left = `${200 + windowIndex * 28}px`;

    const cleanupDrag = this.makeDraggable(wrapper);
    const cleanupResize = this.makeResizable(wrapper);
    const cleanupViewport = this.bindViewportClamp(wrapper);
    const iframe = wrapper.querySelector('iframe') as HTMLIFrameElement;
    const titleDisplay = wrapper.querySelector('.ai-window-number') as HTMLElement;
    const titleInput = wrapper.querySelector('.ai-title-input') as HTMLInputElement;
    const cleanup = () => {
      cleanupDrag();
      cleanupResize();
      cleanupViewport();
    };

    this.windowTitles.set(windowId, title);
    this.windows.set(windowId, {
      chatId,
      element: wrapper,
      iframe,
      titleDisplay,
      titleInput,
      cleanup
    });
    this.bindTitleEditor(windowId);
    this.bindControls(wrapper, windowId, cleanup);
    wrapper.addEventListener('pointerdown', () => {
      this.activateWindow(windowId);
    });
    this.activateWindow(windowId);
    this.clampWindowToViewport(wrapper);

    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage(
        {
          type: 'INIT_CHAT',
          chatId,
          windowTitle: this.windowTitles.get(windowId),
          profileId: chat?.providerId ?? null,
          promptId: chat?.promptId ?? null,
          streamingOverride: chat?.streamingOverride ?? null,
          maxContextMessagesOverride: chat?.maxContextMessagesOverride ?? null,
          historyMessages: chat?.messages ?? null,
          initialMessage
        },
        chrome.runtime.getURL('')
      );
    }, { once: true });
  }

  private bindControls(wrapper: HTMLElement, windowId: string, cleanup: () => void) {
    wrapper.querySelector('.ai-settings-btn')?.addEventListener('click', () => {
      this.ensureSettingsPanelSpace(wrapper);
      const iframe = wrapper.querySelector('iframe') as HTMLIFrameElement | null;
      iframe?.contentWindow?.postMessage(
        { type: 'TOGGLE_SETTINGS_PANEL' },
        chrome.runtime.getURL('')
      );
    });
    wrapper.querySelector('.ai-close-btn')?.addEventListener('click', () => {
      this.closeWindow(windowId);
    });
    wrapper.querySelector('.ai-minimize-btn')?.addEventListener('click', () => {
      wrapper.classList.toggle('minimized');
      this.clampWindowToViewport(wrapper);
    });
  }

  private ensureSettingsPanelSpace(wrapper: HTMLElement) {
    if (wrapper.classList.contains('minimized')) {
      wrapper.classList.remove('minimized');
    }

    const viewportWidth = Math.max(0, window.innerWidth - 20);
    const targetWidth = Math.min(AIMultiWindow.SETTINGS_PANEL_WINDOW_WIDTH, viewportWidth || AIMultiWindow.SETTINGS_PANEL_WINDOW_WIDTH);
    const currentWidth = wrapper.offsetWidth || parseFloat(wrapper.style.width) || AIMultiWindow.DEFAULT_WINDOW_WIDTH;

    if (currentWidth < targetWidth) {
      wrapper.style.width = `${targetWidth}px`;
    }

    this.clampWindowToViewport(wrapper);
  }

  private clamp(value: number, min: number, max: number): number {
    if (max < min) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }

  private clampWindowToViewport(wrapper: HTMLElement) {
    const isMinimized = wrapper.classList.contains('minimized');
    const minVisibleWidth = Math.min(
      AIMultiWindow.MIN_WINDOW_WIDTH,
      Math.max(240, window.innerWidth - 20)
    );
    const minVisibleHeight = Math.min(
      AIMultiWindow.MIN_WINDOW_HEIGHT,
      Math.max(220, window.innerHeight - 20)
    );

    wrapper.style.minWidth = `${minVisibleWidth}px`;
    wrapper.style.minHeight = `${minVisibleHeight}px`;

    const nextWidth = this.clamp(wrapper.offsetWidth, minVisibleWidth, window.innerWidth);
    wrapper.style.width = `${nextWidth}px`;
    if (!isMinimized) {
      const nextHeight = this.clamp(wrapper.offsetHeight, minVisibleHeight, window.innerHeight);
      wrapper.style.height = `${nextHeight}px`;
    }

    const width = wrapper.offsetWidth;
    const height = wrapper.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    const nextLeft = this.clamp(wrapper.offsetLeft, 0, maxLeft);
    const nextTop = this.clamp(wrapper.offsetTop, 0, maxTop);
    wrapper.style.left = `${nextLeft}px`;
    wrapper.style.top = `${nextTop}px`;
  }

  private bindViewportClamp(wrapper: HTMLElement): () => void {
    const onResize = () => {
      this.clampWindowToViewport(wrapper);
    };

    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }

  private makeDraggable(wrapper: HTMLElement): () => void {
    const header = wrapper.querySelector('.ai-window-header') as HTMLElement;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let initialX = 0;
    let initialY = 0;

    const onMouseDown = (event: MouseEvent) => {
      if (
        (event.target as HTMLElement).closest('.ai-window-controls') ||
        (event.target as HTMLElement).closest('.ai-resize-handle')
      ) {
        return;
      }
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      initialX = wrapper.offsetLeft;
      initialY = wrapper.offsetTop;
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) {
        return;
      }
      const nextLeft = initialX + event.clientX - startX;
      const nextTop = initialY + event.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - wrapper.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - wrapper.offsetHeight);
      wrapper.style.left = `${this.clamp(nextLeft, 0, maxLeft)}px`;
      wrapper.style.top = `${this.clamp(nextTop, 0, maxTop)}px`;
    };

    const onMouseUp = () => {
      dragging = false;
    };

    header.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      header.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }

  private makeResizable(wrapper: HTMLElement): () => void {
    const handles = [...wrapper.querySelectorAll<HTMLElement>('.ai-resize-handle')];
    let resizing = false;
    let direction = '';
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let startLeft = 0;
    let startTop = 0;

    const minWidth = () => {
      return Math.max(
        AIMultiWindow.MIN_WINDOW_WIDTH,
        parseFloat(window.getComputedStyle(wrapper).minWidth) || 0
      );
    };

    const minHeight = () => {
      return Math.max(
        AIMultiWindow.MIN_WINDOW_HEIGHT,
        parseFloat(window.getComputedStyle(wrapper).minHeight) || 0
      );
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!resizing) {
        return;
      }

      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      let nextLeft = startLeft;
      let nextTop = startTop;
      let nextWidth = startWidth;
      let nextHeight = startHeight;

      if (direction.includes('e')) {
        nextWidth = this.clamp(startWidth + dx, minWidth(), window.innerWidth - startLeft);
      }

      if (direction.includes('w')) {
        const maxLeft = startLeft + startWidth - minWidth();
        nextLeft = this.clamp(startLeft + dx, 0, maxLeft);
        nextWidth = startWidth - (nextLeft - startLeft);
      }

      if (direction.includes('s')) {
        nextHeight = this.clamp(startHeight + dy, minHeight(), window.innerHeight - startTop);
      }

      wrapper.style.left = `${nextLeft}px`;
      wrapper.style.top = `${nextTop}px`;
      wrapper.style.width = `${nextWidth}px`;
      wrapper.style.height = `${nextHeight}px`;
      this.clampWindowToViewport(wrapper);
    };

    const onMouseUp = () => {
      resizing = false;
      direction = '';
    };

    const onHandleMouseDown = (event: MouseEvent) => {
      if (wrapper.classList.contains('minimized')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      resizing = true;
      direction = (event.currentTarget as HTMLElement).dataset.direction || '';
      startX = event.clientX;
      startY = event.clientY;
      startWidth = wrapper.offsetWidth;
      startHeight = wrapper.offsetHeight;
      startLeft = wrapper.offsetLeft;
      startTop = wrapper.offsetTop;
    };

    handles.forEach((handle) => {
      handle.addEventListener('mousedown', onHandleMouseDown);
    });
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      handles.forEach((handle) => {
        handle.removeEventListener('mousedown', onHandleMouseDown);
      });
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

window.aiMultiWindowApp = new AIMultiWindow();
