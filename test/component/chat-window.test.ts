import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import chatHtml from '../../chat-window.html?raw';
import { STORAGE_KEY } from '../../src/shared/constants';
import type { ChatRequest, PersistedMessage, RootStore, StreamEvent, UsageMetrics } from '../../src/shared/types';
import { getChromeState, type PortMock } from '../helpers/chrome-mock';
import {
  createPersistedMessage,
  createProvider,
  createRootStore
} from '../helpers/factories';
import { bootModule, mountExtensionHtml, resetDocument, waitFor } from '../helpers/dom';

const state = getChromeState();
const baseFeatureSettings = createRootStore().featureSettings;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function usage(overrides: Partial<UsageMetrics> = {}): UsageMetrics {
  return {
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 3,
    ...overrides
  };
}

async function bootChat(overrides: Partial<RootStore>, providerId = 'p1'): Promise<PortMock> {
  resetDocument();
  mountExtensionHtml(chatHtml);
  state.seedStorage({ [STORAGE_KEY]: createRootStore(overrides) });
  await bootModule('../../src/chat/index.ts');
  await waitFor(() => document.querySelector<HTMLSelectElement>('#profileSelect')?.value === providerId);
  return state.lastPort() as PortMock;
}

function lastStartChat(): ChatRequest | null {
  const port = state.lastPort();
  const event = port?.posted.find((entry) => (entry as { type?: string }).type === 'start_chat') as
    | { payload: ChatRequest }
    | undefined;
  return event?.payload ?? null;
}

function emit(event: StreamEvent): void {
  (state.lastPort() as PortMock).emit(event);
}

describe('chat window streaming', () => {
  it('sends a request over the port and renders a streamed reply', async () => {
    const port = await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );
    expect(port).toBeTruthy();

    setValue(el<HTMLTextAreaElement>('messageInput'), 'Hi');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'Hi' ? candidate : null;
    });
    expect(payload.providerId).toBe('p1');
    expect(payload.modelId).toBe('test-model');
    expect(payload.mode).toBe('chat');
    expect(payload.messages[payload.messages.length - 1]).toEqual({ role: 'user', content: 'Hi' });
    expect(document.querySelector('.message-user')).toBeTruthy();
    expect(el<HTMLButtonElement>('sendBtn').classList.contains('is-loading')).toBe(true);

    emit({ type: 'contentDelta', requestId: payload.requestId, delta: 'Hello ' });
    emit({ type: 'contentDelta', requestId: payload.requestId, delta: 'world' });
    emit({ type: 'usageUpdate', requestId: payload.requestId, usage: usage({ totalTokens: 12 }) });
    const response: PersistedMessage = createPersistedMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hello world',
      tokenUsage: usage({ totalTokens: 12 })
    });
    emit({
      type: 'completed',
      requestId: payload.requestId,
      response: {
        content: response.content,
        reasoningSummary: response.reasoningSummary,
        toolCalls: response.toolCalls,
        usage: response.tokenUsage,
        sources: response.sources,
        searchMeta: response.searchMeta
      }
    });

    await waitFor(() =>
      document.querySelector('.message-assistant .message-content')?.textContent?.includes('Hello world')
    );
    expect(el<HTMLButtonElement>('sendBtn').classList.contains('is-loading')).toBe(false);
    expect(document.querySelector('.message-footer-usage')?.textContent).toBeTruthy();
  });
});

describe('chat window search gating', () => {
  it('asks for a Tavily key before running a search request', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: {
          ...baseFeatureSettings,
          defaultProviderId: 'p1',
          search: { ...baseFeatureSettings.search, tavilyApiKey: '' }
        }
      },
      'p1'
    );

    el<HTMLInputElement>('searchToggle').checked = true;
    setValue(el<HTMLTextAreaElement>('messageInput'), 'search please');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));

    await waitFor(
      () => el('composerStatusText').textContent === 'Please configure Tavily API key first.'
    );
    expect(el('composerStatus').hidden).toBe(false);
    expect(el('composerStatus').dataset.variant).toBe('warning');
    expect(lastStartChat()).toBeNull();
  });
});

describe('chat window settings', () => {
  it('reflects the model streaming default and sends an override', async () => {
    await bootChat(
      {
        providers: [
          createProvider({
            id: 'p1',
            modelCatalog: [
              {
                modelId: 'test-model',
                displayName: 'Test Model',
                supportsStreaming: false,
                maxContextMessages: null,
                reasoningFormat: 'none'
              }
            ]
          })
        ],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    expect(el<HTMLInputElement>('streamingToggle').checked).toBe(false);

    const toggle = el<HTMLInputElement>('streamingToggle');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    setValue(el<HTMLTextAreaElement>('messageInput'), 'override streaming');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'override streaming' ? candidate : null;
    });
    expect(payload.streamingEnabled).toBe(true);
    expect(payload.streamingOverride).toBe(true);
  });

  it('toggles the settings panel from a window message', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    window.dispatchEvent(new MessageEvent('message', { data: { type: 'TOGGLE_SETTINGS_PANEL' } }));
    expect(el('settingsPanel').hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el('settingsPanel').hidden).toBe(true);
  });
});

describe('chat window failure handling', () => {
  it('shows an auth failure for a 401 provider error', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    setValue(el<HTMLTextAreaElement>('messageInput'), 'fail please');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));
    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'fail please' ? candidate : null;
    });

    emit({ type: 'failed', requestId: payload.requestId, error: 'Provider returned 401' });

    await waitFor(() => el('composerStatusText').textContent === 'API key is invalid or authentication failed.');
    expect(el('composerStatus').dataset.variant).toBe('error');
    expect(document.querySelector('.message-assistant')).toBeNull();
  });

  it('clears the placeholder when the request is aborted', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    setValue(el<HTMLTextAreaElement>('messageInput'), 'abort me');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));
    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'abort me' ? candidate : null;
    });

    emit({ type: 'aborted', requestId: payload.requestId });

    await waitFor(() => el('composerStatusText').textContent === 'Stopped.');
    expect(document.querySelector('.message-assistant')).toBeNull();
  });
});

describe('chat window history init', () => {
  it('renders history and pre-fills the composer from INIT_CHAT', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'INIT_CHAT',
          chatId: 'chat-history',
          historyMessages: [
            createPersistedMessage({ id: 'h1', role: 'user', content: 'previous question' }),
            createPersistedMessage({ id: 'h2', role: 'assistant', content: 'previous answer' })
          ],
          initialMessage: 'draft message'
        }
      })
    );

    await waitFor(() => document.querySelectorAll('.message').length === 2);
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('previous answer');
    expect(el<HTMLTextAreaElement>('messageInput').value).toBe('draft message');
  });
});
