import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  CHAT_INDEX_KEY,
  CHAT_SESSION_PREFIX,
  LEGACY_STORAGE_KEY,
  META_KEY,
  PORT_NAME,
  createEmptyConfig,
  createEmptyStore
} from '../../src/shared/constants';
import type {
  ChatIndexEntry,
  ChatSession,
  RootStore,
  StorageConfig,
  StreamEvent
} from '../../src/shared/types';
import { chatSessionKey } from '../../src/shared/storage';
import { getChromeState, type PortMock } from '../helpers/chrome-mock';
import { createChatRequest, createChatSession, createProvider, TEST_BASE_URL } from '../helpers/factories';

const server = setupServer();
const state = getChromeState();

/**
 * Seeds the legacy v4 blob so the background worker exercises the real v4 -> v5
 * migration on first access.
 */
function seedStore(overrides: Partial<RootStore> = {}): RootStore {
  const store: RootStore = { ...createEmptyStore(), ...overrides };
  state.seedStorage({ [LEGACY_STORAGE_KEY]: store });
  return store;
}

/** Reads the v5 layout synchronously for assertions. */
function currentStore(): RootStore {
  const config = (state.storage[META_KEY] as StorageConfig | undefined) ?? createEmptyConfig();
  const index = (state.storage[CHAT_INDEX_KEY] as ChatIndexEntry[] | undefined) ?? [];
  const chatHistory: ChatSession[] = [];
  for (const entry of index) {
    const session = state.storage[chatSessionKey(entry.chatId)] as ChatSession | undefined;
    if (session) {
      chatHistory.push(session);
    }
  }
  return { ...config, chatHistory };
}

function connect(): PortMock {
  return chrome.runtime.connect({ name: PORT_NAME }) as unknown as PortMock;
}

async function waitForEvent<T extends StreamEvent = StreamEvent>(
  port: PortMock,
  predicate: (event: StreamEvent) => boolean,
  timeout = 5000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = port.posted.find((event) => predicate(event as StreamEvent));
    if (found) {
      return found as T;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for port event. Posted: ${JSON.stringify(port.posted)}`);
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  // Import registers the runtime.onConnect / runtime.onMessage listeners.
  await import('../../src/background/index');
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  server.resetHandlers();
});

describe('background chat streaming', () => {
  it('streams a reply and persists the conversation', async () => {
    seedStore({ providers: [createProvider()] });
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.model).toBe('test-model');
        expect(body.stream).toBe(false);
        return HttpResponse.json({
          choices: [{ message: { content: 'Hello from background.' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        });
      })
    );

    const port = connect();
    const payload = createChatRequest({ requestId: 'req-bg-success', userMessage: 'ping background' });
    port.emit({ type: 'start_chat', payload });

    const completed = await waitForEvent(port, (event) => event.type === 'completed');
    expect(completed.type).toBe('completed');
    if (completed.type === 'completed') {
      expect(completed.response.content).toBe('Hello from background.');
      expect(completed.response.usage?.totalTokens).toBe(7);
    }

    const types = port.posted.map((event) => (event as StreamEvent).type);
    expect(types[0]).toBe('started');
    expect(types).toContain('statusUpdate');
    expect(types).toContain('contentDelta');
    expect(types).toContain('usageUpdate');

    const session = currentStore().chatHistory[0];
    expect(session.chatId).toBe('chat-test');
    expect(session.title).toBe('Test window');
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(session.messages[0].content).toBe('ping background');
    expect(session.messages[1].content).toBe('Hello from background.');
    expect(session.messages[1].tokenUsage?.totalTokens).toBe(7);
    expect(session.totalUsage?.totalTokens).toBe(7);
  });

  it('appends to an existing conversation without overwriting history', async () => {
    seedStore({
      providers: [createProvider()],
      chatHistory: [createChatSession({ chatId: 'chat-test', title: 'Existing', messages: [] })]
    });
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ choices: [{ message: { content: 'Second answer.' } }] })
      )
    );

    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'req-bg-append' }) });
    await waitForEvent(port, (event) => event.type === 'completed');

    const session = currentStore().chatHistory[0];
    expect(session.title).toBe('Existing');
    expect(session.messages.map((message) => message.content)).toEqual(['hello', 'Second answer.']);
  });

  it('reports a missing provider without persisting anything', async () => {
    seedStore({ providers: [] });

    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'req-bg-no-provider' }) });

    const failed = await waitForEvent(port, (event) => event.type === 'failed');
    if (failed.type === 'failed') {
      expect(failed.error).toBe('Provider not found.');
      expect(failed.code).toBe('provider_not_found');
      expect(failed.retryable).toBe(false);
    }
    expect(currentStore().chatHistory).toEqual([]);
  });

  it('reports an unavailable model without persisting anything', async () => {
    seedStore({ providers: [createProvider({ defaultModel: '', modelCatalog: [] })] });

    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'req-bg-no-model' }) });

    const failed = await waitForEvent(port, (event) => event.type === 'failed');
    if (failed.type === 'failed') {
      expect(failed.error).toBe('Model does not exist or is unavailable.');
      expect(failed.code).toBe('model_unavailable');
    }
    expect(currentStore().chatHistory).toEqual([]);
  });

  it('persists the user message when a request fails', async () => {
    seedStore({ providers: [createProvider()] });
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 })
      )
    );

    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'req-bg-error' }) });

    const failed = await waitForEvent(port, (event) => event.type === 'failed');
    if (failed.type === 'failed') {
      expect(failed.error).toMatch(/500/);
      expect(failed.code).toBe('http_error');
      expect(failed.retryable).toBe(true);
      expect(failed.status).toBe(500);
    }

    const session = currentStore().chatHistory[0];
    expect(session.messages.map((message) => message.role)).toEqual(['user']);
    expect(session.messages[0].content).toBe('hello');
  });

  it('aborts an in-flight request', async () => {
    seedStore({ providers: [createProvider()] });
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return HttpResponse.json({ choices: [{ message: { content: 'too late' } }] });
      })
    );

    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'req-bg-abort' }) });
    await waitForEvent(port, (event) => event.type === 'started');

    port.emit({ type: 'abort_chat', requestId: 'req-bg-abort' });
    const aborted = await waitForEvent(port, (event) => event.type === 'aborted');
    expect(aborted.type).toBe('aborted');

    const session = currentStore().chatHistory[0];
    expect(session.messages.map((message) => message.role)).toEqual(['user']);
  });
});

describe('background runtime messages', () => {
  it('tests a provider connection through TEST_PROVIDER', async () => {
    server.use(http.get(`${TEST_BASE_URL}/models`, () => HttpResponse.json({ data: [] })));

    const response = await state.dispatchRuntimeMessage({
      type: 'TEST_PROVIDER',
      provider: createProvider()
    });
    expect(response).toEqual({ success: true });
  });

  it('reports a failed provider connection through TEST_PROVIDER', async () => {
    server.use(http.get(`${TEST_BASE_URL}/models`, () => new HttpResponse('denied', { status: 401 })));

    const response = await state.dispatchRuntimeMessage({
      type: 'TEST_PROVIDER',
      provider: createProvider()
    });
    expect(response).toEqual({ success: false, error: 'denied' });
  });

  it('renames a conversation through RENAME_CHAT', async () => {
    seedStore({ chatHistory: [createChatSession({ chatId: 'chat-test', title: 'Old title' })] });

    const response = await state.dispatchRuntimeMessage({
      type: 'RENAME_CHAT',
      chatId: 'chat-test',
      title: '  Renamed session  '
    });

    expect(response).toEqual({ success: true });
    const session: ChatSession = currentStore().chatHistory[0];
    expect(session.title).toBe('Renamed session');
  });

  it('ignores unrelated runtime messages', async () => {
    const response = await state.dispatchRuntimeMessage({ type: 'SOMETHING_ELSE' });
    expect(response).toBeUndefined();
  });
});
