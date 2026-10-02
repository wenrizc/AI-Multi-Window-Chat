import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createChatRequest, createChatSession, createFeatureSettings, createProvider, TEST_BASE_URL } from '../helpers/factories';
import { byteSse, deferred, llmTurn, scriptedLlm, type Transport } from '../helpers/llm-mock';

const server = setupServer();
const state = getChromeState();
let scripts: ReturnType<typeof scriptedLlm>[] = [];

function useScript(transport: Transport, steps: Parameters<typeof scriptedLlm>[1], baseUrl = TEST_BASE_URL) {
  const script = scriptedLlm(transport, steps, baseUrl);
  scripts.push(script);
  server.use(script.handler);
  return script;
}

afterEach(() => {
  const current = scripts;
  scripts = [];
  current.forEach(script => script.verify());
});

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

describe.each<Transport>(['chat_completions', 'responses'])('background %s lifecycle', transport => {
  it('reports malformed streaming data without saving a partial assistant answer', async () => {
    seedStore({ providers: [createProvider({ transport })] });
    const first = transport === 'responses'
      ? { type: 'response.output_text.delta', delta: 'Incomplete' }
      : { choices: [{ delta: { content: 'Incomplete' } }] };
    useScript(transport, [() => byteSse(`data: ${JSON.stringify(first)}\n\ndata: {broken}\n\n`)]);
    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ streamingEnabled: true }) });
    expect(await waitForEvent(port, event => event.type === 'failed')).toMatchObject({ code: 'parse', retryable: false });
    expect(port.posted).toContainEqual({ type: 'contentDelta', requestId: 'req-test', delta: 'Incomplete' });
    expect(port.posted.some(event => (event as StreamEvent).type === 'completed')).toBe(false);
    expect(currentStore().chatHistory[0].messages.map(message => [message.role, message.content])).toEqual([['user', 'hello']]);
    expect(currentStore().chatHistory[0].totalUsage).toBeNull();
  });

  it('persists only one user message after failure and a successful retry, then appends another turn', async () => {
    seedStore({ providers: [createProvider({ transport })] });
    useScript(transport, [
      () => new HttpResponse(null, { status: 503 }),
      () => llmTurn(transport, { content: 'Recovered' }),
      () => llmTurn(transport, { content: 'Next answer' })
    ]);
    const port = connect();
    for (const [requestId, userMessage, terminal] of [
      ['first', 'hello', 'failed'], ['retry', 'hello', 'completed'], ['next', 'follow up', 'completed']
    ]) {
      port.emit({ type: 'start_chat', payload: createChatRequest({ requestId, userMessage, messages: [{ role: 'user', content: userMessage }] }) });
      await waitForEvent(port, event => event.requestId === requestId && event.type === terminal);
    }
    const session = currentStore().chatHistory[0];
    expect(session.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'hello'], ['assistant', 'Recovered'], ['user', 'follow up'], ['assistant', 'Next answer']
    ]);
    expect(session.totalUsage?.totalTokens).toBe(10);
    expect(currentStore().chatHistory).toHaveLength(1);
  });

  it('persists streamed content, reasoning and usage after delivering ordered port events', async () => {
    seedStore({ providers: [createProvider({ transport })] });
    useScript(transport, [() => byteSse(transport === 'responses'
      ? 'data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Think"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n'
      : 'data: {"choices":[{"delta":{"content":"你好","reasoning_content":"Think"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n')]);
    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ streamingEnabled: true }) });
    const completed = await waitForEvent(port, event => event.type === 'completed');
    expect(completed).toMatchObject({ response: { content: '你好', reasoningSummary: 'Think', usage: { totalTokens: 5 } } });
    expect(port.posted.map(event => (event as StreamEvent).type)).toEqual(['started', 'statusUpdate', 'contentDelta', 'reasoningDelta', 'usageUpdate', 'completed']);
    expect(currentStore().chatHistory[0].messages[1]).toMatchObject({ content: '你好', reasoningSummary: 'Think', tokenUsage: { totalTokens: 5 } });
  });

  it('persists search sources, tool records and usage across the complete background pipeline', async () => {
    seedStore({ providers: [createProvider({ transport })], featureSettings: createFeatureSettings() });
    useScript(transport, [
      () => llmTurn(transport, { calls: [{ id: 'weather', name: 'web_search', arguments: '{"query":"weather"}' }] }),
      () => llmTurn(transport, { content: 'Sunny today.' })
    ]);
    server.use(http.post('https://api.tavily.com/search', () => HttpResponse.json({ credits: 1, results: [{ title: 'Weather', url: 'https://weather.test', content: 'Sunny' }] })));
    const port = connect();
    port.emit({ type: 'start_chat', payload: createChatRequest({ mode: 'search' }) });
    const completed = await waitForEvent(port, event => event.type === 'completed');
    expect(completed).toMatchObject({ response: { content: 'Sunny today.', usage: { totalTokens: 10 }, searchMeta: { sourceCount: 1, credits: 1 }, toolCalls: [{ id: 'weather', status: 'completed' }] } });
    const message = currentStore().chatHistory[0].messages[1];
    expect(message).toMatchObject({ mode: 'search', content: 'Sunny today.', tokenUsage: { totalTokens: 10 }, sources: [{ url: 'https://weather.test' }], toolCalls: [{ id: 'weather', status: 'completed' }] });
  });
});

it('disconnecting one window aborts its in-flight HTTP request while another window completes', async () => {
  const secondUrl = 'https://second-llm.test/v1';
  seedStore({ providers: [createProvider(), createProvider({ id: 'second', baseUrl: secondUrl })] });
  const arrived = deferred<void>();
  const aborted = deferred<void>();
  const release = deferred<void>();
  useScript('chat_completions', [async ({ request }) => {
    request.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    arrived.resolve();
    await release.promise;
    return llmTurn('chat_completions', { content: 'Must not persist' });
  }]);
  useScript('chat_completions', [async () => {
    await release.promise;
    return llmTurn('chat_completions', { content: 'Other window answer' });
  }], secondUrl);
  const first = connect();
  const second = connect();
  try {
    first.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'one', chatId: 'one' }) });
    second.emit({ type: 'start_chat', payload: createChatRequest({ requestId: 'two', chatId: 'two', providerId: 'second' }) });
    await arrived.promise;
    first.disconnect();
    await aborted.promise;
    await waitForEvent(first, event => event.type === 'aborted');
    release.resolve();
    await waitForEvent(second, event => event.type === 'completed');
    expect(first.posted.every(event => (event as StreamEvent).requestId === 'one')).toBe(true);
    expect(second.posted.every(event => (event as StreamEvent).requestId === 'two')).toBe(true);
    expect(currentStore().chatHistory.find(chat => chat.chatId === 'one')?.messages.map(message => message.role)).toEqual(['user']);
    expect(currentStore().chatHistory.find(chat => chat.chatId === 'two')?.messages.map(message => message.content)).toEqual(['hello', 'Other window answer']);
  } finally {
    release.resolve();
    first.disconnect();
    second.disconnect();
  }
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
