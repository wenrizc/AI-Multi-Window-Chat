import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getChromeState } from '../helpers/chrome-mock';
import { createChatSession } from '../helpers/factories';
import { bootModule, resetDocument, waitFor } from '../helpers/dom';

const state = getChromeState();

function windowCount(): number {
  return document.querySelectorAll('.ai-multi-window').length;
}

function firstWindow(): HTMLElement {
  return document.querySelector('.ai-multi-window') as HTMLElement;
}

beforeAll(async () => {
  resetDocument();
  // `postMessage` rejects the synthetic `chrome-extension://` origin in a normal
  // web page, so keep path URLs intact but return a real origin for the base URL
  // the content script uses as a postMessage target.
  const runtime = chrome.runtime as unknown as { getURL: (path?: string) => string };
  const originalGetURL = runtime.getURL;
  runtime.getURL = (path = '') => (path ? originalGetURL(path) : `${window.location.origin}/`);

  state.resetListeners();
  await bootModule('../../src/content/index.ts');
  await waitFor(() => Boolean((window as unknown as { aiMultiWindowApp?: unknown }).aiMultiWindowApp));
});

beforeEach(() => {
  document.querySelectorAll<HTMLButtonElement>('.ai-multi-window .ai-close-btn').forEach((button) => button.click());
  document.querySelectorAll('.ai-multi-window, .ai-selection-toolbar').forEach((node) => node.remove());
  expect(windowCount()).toBe(0);
});

describe('content script chat windows', () => {
  it('opens a chat window when the extension sends OPEN_CHAT_WINDOW', async () => {
    await state.dispatchRuntimeMessage({ type: 'OPEN_CHAT_WINDOW', initialMessage: 'hi' });
    await waitFor(() => windowCount() === 1);

    const win = firstWindow();
    expect(win.querySelector('.ai-window-number')?.textContent).toMatch(/AI Chat/);
    expect(win.querySelector('iframe')?.getAttribute('src')).toContain('chat-window.html');
  });

  it('uses the provided history title', async () => {
    await state.dispatchRuntimeMessage({
      type: 'OPEN_CHAT_WINDOW',
      chat: createChatSession({ chatId: 'c9', title: 'Saved chat' })
    });
    await waitFor(() => windowCount() === 1);

    expect(firstWindow().querySelector('.ai-window-number')?.textContent).toBe('Saved chat');
  });

  it('closes a window from its close button', async () => {
    await state.dispatchRuntimeMessage({ type: 'OPEN_CHAT_WINDOW' });
    await waitFor(() => windowCount() === 1);

    firstWindow().querySelector<HTMLButtonElement>('.ai-close-btn')?.click();
    await waitFor(() => windowCount() === 0);
  });

  it('minimizes a window', async () => {
    await state.dispatchRuntimeMessage({ type: 'OPEN_CHAT_WINDOW' });
    await waitFor(() => windowCount() === 1);

    firstWindow().querySelector<HTMLButtonElement>('.ai-minimize-btn')?.click();
    expect(firstWindow().classList.contains('minimized')).toBe(true);
  });

  it('toggles fullscreen', async () => {
    await state.dispatchRuntimeMessage({ type: 'OPEN_CHAT_WINDOW' });
    await waitFor(() => windowCount() === 1);

    firstWindow().querySelector<HTMLButtonElement>('.ai-fullscreen-btn')?.click();
    expect(firstWindow().classList.contains('fullscreen')).toBe(true);

    firstWindow().querySelector<HTMLButtonElement>('.ai-fullscreen-btn')?.click();
    expect(firstWindow().classList.contains('fullscreen')).toBe(false);
  });

  it('renames a window and notifies the background', async () => {
    await state.dispatchRuntimeMessage({
      type: 'OPEN_CHAT_WINDOW',
      chat: createChatSession({ chatId: 'c-rename', title: 'Old title' })
    });
    await waitFor(() => windowCount() === 1);

    const win = firstWindow();
    win.querySelector<HTMLElement>('.ai-window-number')?.click();
    const input = win.querySelector<HTMLInputElement>('.ai-title-input') as HTMLInputElement;
    expect(input.hidden).toBe(false);

    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    await waitFor(() => win.querySelector('.ai-window-number')?.textContent === 'New title');
    await waitFor(() =>
      state.runtimeMessages.some(
        (message) => (message as { type?: string }).type === 'RENAME_CHAT' && (message as { title?: string }).title === 'New title'
      )
    );
  });

  it('creates and closes windows with the Alt+N / Alt+M shortcuts', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true }));
    await waitFor(() => windowCount() === 1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true }));
    await waitFor(() => windowCount() === 2);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', altKey: true, bubbles: true }));
    await waitFor(() => windowCount() === 1);
  });
});
