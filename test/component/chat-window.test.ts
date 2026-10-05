import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import chatHtml from '../../chat-window.html?raw';
import { STORAGE_KEY } from '../../src/shared/constants';
import { chatSessionKey } from '../../src/shared/storage';
import type { ChatRequest, ChatSession, PersistedMessage, RootStore, StreamEvent, UsageMetrics } from '../../src/shared/types';
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

function startChatPayloads(): ChatRequest[] {
  const port = state.lastPort();
  return (port?.posted ?? [])
    .filter((entry) => (entry as { type?: string }).type === 'start_chat')
    .map((entry) => (entry as { payload: ChatRequest }).payload);
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

  it('renders the full reply after a burst of throttled deltas', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    setValue(el<HTMLTextAreaElement>('messageInput'), 'stream fast');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));
    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'stream fast' ? candidate : null;
    });

    const chunks = Array.from({ length: 40 }, (_value, index) => `chunk-${index} `);
    for (const chunk of chunks) {
      emit({ type: 'contentDelta', requestId: payload.requestId, delta: chunk });
    }

    emit({
      type: 'completed',
      requestId: payload.requestId,
      response: {
        content: chunks.join(''),
        reasoningSummary: null,
        toolCalls: [],
        usage: null,
        sources: [],
        searchMeta: null
      }
    });

    await waitFor(() =>
      document.querySelector('.message-assistant .message-content')?.textContent?.includes('chunk-39')
    );
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('chunk-0');
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

    const extensionOrigin = window.location.origin;
    window.postMessage({ type: 'TOGGLE_SETTINGS_PANEL' }, extensionOrigin);
    await waitFor(() => el('settingsPanel').hidden === false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el('settingsPanel').hidden).toBe(true);
  });
});

describe('chat window failure handling', () => {
  it('reconnects the runtime port after it disconnects before sending', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    const disconnectedPort = state.lastPort() as PortMock;
    disconnectedPort.disconnect();
    setValue(el<HTMLTextAreaElement>('messageInput'), 'reconnect me');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'reconnect me' ? candidate : null;
    });
    expect(state.lastPort()).not.toBe(disconnectedPort);
    expect(payload.userMessage).toBe('reconnect me');
  });

  it('retries immediately when a stale port rejects the first dispatch', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    const stalePort = state.lastPort() as PortMock;
    stalePort.postMessage = () => {
      throw new Error('The message port closed before a response was received.');
    };
    setValue(el<HTMLTextAreaElement>('messageInput'), 'retry dispatch');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'retry dispatch' ? candidate : null;
    });
    expect(state.lastPort()).not.toBe(stalePort);
    expect(payload.userMessage).toBe('retry dispatch');
    expect(el('composerStatus').hidden).toBe(false);
    expect(el('composerStatus').dataset.variant).toBe('busy');
  });

  it('does not append duplicate messages while a send is being prepared', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    setValue(el<HTMLTextAreaElement>('messageInput'), 'send once');
    el<HTMLButtonElement>('sendBtn').click();
    el<HTMLButtonElement>('sendBtn').click();

    await waitFor(() => lastStartChat()?.userMessage === 'send once');
    expect(startChatPayloads()).toHaveLength(1);
    expect(document.querySelectorAll('.message-user')).toHaveLength(1);
  });

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

    emit({ type: 'failed', requestId: payload.requestId, error: 'Provider returned 401', code: 'auth', retryable: false, status: 401 });

    await waitFor(() => el('composerStatusText').textContent === 'API key is invalid or authentication failed.');
    expect(el('composerStatus').dataset.variant).toBe('error');
    expect(el<HTMLButtonElement>('composerRetryBtn').hidden).toBe(true);
    expect(document.querySelector('.message-assistant')).toBeNull();
  });

  it('offers a retry for retryable failures and resends with a fresh request id', async () => {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );

    setValue(el<HTMLTextAreaElement>('messageInput'), 'retry me');
    await userEvent.click(el<HTMLButtonElement>('sendBtn'));
    const first = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.userMessage === 'retry me' ? candidate : null;
    });

    emit({
      type: 'failed',
      requestId: first.requestId,
      error: 'Provider returned 500',
      code: 'http_error',
      retryable: true,
      status: 500
    });

    await waitFor(() => el('composerStatusText').textContent === 'Service returned status 500.');
    const retryButton = el<HTMLButtonElement>('composerRetryBtn');
    expect(retryButton.hidden).toBe(false);
    expect(document.querySelectorAll('.message-user').length).toBe(1);

    await userEvent.click(retryButton);

    const second = await waitFor(() => {
      const payloads = startChatPayloads();
      return payloads.length === 2 ? payloads[1] : null;
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.userMessage).toBe('retry me');
    expect(retryButton.hidden).toBe(true);
    // Retrying must not duplicate the user bubble.
    expect(document.querySelectorAll('.message-user').length).toBe(1);
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

    const extensionOrigin = window.location.origin;
    window.postMessage({
      type: 'INIT_CHAT',
      chatId: 'chat-history',
      historyMessages: [
        createPersistedMessage({ id: 'h1', role: 'user', content: 'previous question' }),
        createPersistedMessage({ id: 'h2', role: 'assistant', content: 'previous answer' })
      ],
      initialMessage: 'draft message'
    }, extensionOrigin);

    await waitFor(() => document.querySelectorAll('.message').length === 2);
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('previous answer');
    expect(el<HTMLTextAreaElement>('messageInput').value).toBe('draft message');
  });
});

it('saves multiple custom levels, snapshots selection, and resets a deleted selection', async () => {
  await bootChat({ providers: [createProvider({ id: 'p1' })], featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' } });
  const input = el<HTMLTextAreaElement>('customEffortsInput');
  setValue(input, 'xhigh, minimal，xhigh\nultra, high');
  el<HTMLButtonElement>('saveCustomEffortsBtn').click();
  const select = el<HTMLSelectElement>('reasoningEffortSelect');
  await waitFor(() => select.options.length === 9);
  expect(Array.from(select.options).map(o => o.value)).toEqual(['default', 'none', 'low', 'medium', 'high', 'max', 'xhigh', 'minimal', 'ultra']);
  expect((await chrome.storage.local.get('customReasoningEfforts')).customReasoningEfforts).toEqual(['xhigh', 'minimal', 'ultra']);
  setValue(select, 'ultra');
  setValue(el<HTMLTextAreaElement>('messageInput'), 'hello');
  el<HTMLButtonElement>('sendBtn').click();
  const payload = await waitFor(() => lastStartChat());
  expect(payload.reasoningEffort).toBe('ultra');
  setValue(input, 'xhigh, minimal');
  el<HTMLButtonElement>('saveCustomEffortsBtn').click();
  await waitFor(() => select.value === 'default');
  expect(payload.reasoningEffort).toBe('ultra');
});

describe('chat window branching', () => {
  async function bootWithHistory(messages: PersistedMessage[], activeLeafId?: string): Promise<void> {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );
    const extensionOrigin = window.location.origin;
    window.postMessage(
      { type: 'INIT_CHAT', chatId: 'chat-source', windowTitle: 'Source', historyMessages: messages, activeLeafId },
      extensionOrigin
    );
  }

  it('copies the active path up to the chosen message into a new window', async () => {
    await bootWithHistory([
      createPersistedMessage({ id: 'h1', role: 'user', content: 'q1' }),
      createPersistedMessage({ id: 'h2', content: 'a1' }),
      createPersistedMessage({ id: 'h3', role: 'user', content: 'q2' }),
      createPersistedMessage({ id: 'h4', content: 'a2' })
    ]);
    await waitFor(() => document.querySelectorAll('.message').length === 4);

    const branchButtons = document.querySelectorAll<HTMLButtonElement>('.message-action-branch');
    branchButtons[1].click();

    const request = await waitFor(() => {
      const found = state.runtimeMessages.find(
        (message) => (message as { type?: string }).type === 'BRANCH_CHAT_WINDOW'
      );
      return (found as { chat?: ChatSession } | undefined)?.chat ?? null;
    });

    expect(request.branchOf).toEqual({ chatId: 'chat-source', messageId: 'h2' });
    expect(request.messages.map((message) => message.content)).toEqual(['q1', 'a1']);
    expect(request.activeLeafId).toBe(request.messages[request.messages.length - 1].id);
    expect(state.storage[chatSessionKey(request.chatId)]).toBeTruthy();
  });

  it('releases the branch guard when the new window cannot be opened', async () => {
    await bootWithHistory([
      createPersistedMessage({ id: 'h1', role: 'user', content: 'q1' }),
      createPersistedMessage({ id: 'h2', content: 'a1' })
    ]);
    await waitFor(() => document.querySelectorAll('.message').length === 2);

    let branchCalls = 0;
    state.setRuntimeMessageHandler(() => {
      branchCalls += 1;
      return branchCalls === 1 ? { success: false, error: 'denied' } : { success: true };
    });
    const branchButton = document.querySelector<HTMLButtonElement>('.message-action-branch');
    branchButton?.click();
    await waitFor(() => branchCalls === 1);
    branchButton?.click();
    await waitFor(() => branchCalls === 2);
  });

  it('renders only the active branch from INIT_CHAT', async () => {
    await bootWithHistory([
      createPersistedMessage({ id: 'h1', role: 'user', content: 'q1', parentId: null }),
      createPersistedMessage({ id: 'a1', content: 'first', parentId: 'h1' }),
      createPersistedMessage({ id: 'a2', content: 'second', parentId: 'h1' })
    ], 'a1');
    await waitFor(() => document.querySelectorAll('.message').length === 2);

    expect(document.querySelectorAll('.message-user').length).toBe(1);
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('first');
  });
});

describe('chat window message versions', () => {
  async function bootWithVersions(): Promise<void> {
    await bootChat(
      {
        providers: [createProvider({ id: 'p1' })],
        featureSettings: { ...baseFeatureSettings, defaultProviderId: 'p1' }
      },
      'p1'
    );
    const extensionOrigin = window.location.origin;
    window.postMessage({
      type: 'INIT_CHAT',
      chatId: 'chat-versions',
      historyMessages: [
        createPersistedMessage({ id: 'h1', role: 'user', content: 'q1', parentId: null }),
        createPersistedMessage({ id: 'a1', content: 'first answer', parentId: 'h1' }),
        createPersistedMessage({ id: 'a2', content: 'second answer', parentId: 'h1' })
      ],
      activeLeafId: 'a1'
    }, extensionOrigin);
    await waitFor(() => document.querySelectorAll('.message').length === 2);
  }

  it('shows the version navigator and switches between siblings', async () => {
    await bootWithVersions();

    expect(document.querySelector('.message-versions .message-version-label')?.textContent).toBe('1/2');
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('first answer');

    document.querySelector<HTMLButtonElement>('.message-version-btn[data-version-dir="1"]')?.click();

    await waitFor(() => document.querySelector('.message-version-label')?.textContent === '2/2');
    expect(document.querySelector('.message-assistant .message-content')?.textContent).toContain('second answer');
    expect(state.runtimeMessages).toContainEqual({
      type: 'SET_ACTIVE_LEAF',
      chatId: 'chat-versions',
      leafId: 'a2'
    });
  });

  it('edits a user message into a sibling branch and resends', async () => {
    await bootWithVersions();

    document.querySelector<HTMLButtonElement>('.message-user .message-action-edit')?.click();
    const textarea = await waitFor(() => document.querySelector<HTMLTextAreaElement>('.message-edit-input'));
    textarea.value = 'edited question';
    document.querySelector<HTMLButtonElement>('.message-edit-save')?.click();

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.purpose === 'edit' ? candidate : null;
    });

    expect(payload.appendUserMessage).toBe(true);
    expect(payload.parentMessageId).toBeNull();
    expect(payload.userMessage).toBe('edited question');
    expect(payload.userMessageId).toBeTruthy();
    expect(payload.userMessageId).not.toBe('h1');
    expect(payload.messages[payload.messages.length - 1]).toEqual({ role: 'user', content: 'edited question' });
  });

  it('regenerates an assistant message without appending a user turn', async () => {
    await bootWithVersions();

    const regenerateButton = document.querySelector<HTMLButtonElement>('.message-assistant .message-action-regenerate');
    regenerateButton?.click();
    regenerateButton?.click();

    const payload = await waitFor(() => {
      const candidate = lastStartChat();
      return candidate && candidate.purpose === 'regenerate' ? candidate : null;
    });

    expect(payload.appendUserMessage).toBe(false);
    expect(payload.parentMessageId).toBe('h1');
    expect(payload.userMessageId).toBe('h1');
    expect(payload.userMessage).toBe('q1');
    expect(startChatPayloads()).toHaveLength(1);
  });
});
