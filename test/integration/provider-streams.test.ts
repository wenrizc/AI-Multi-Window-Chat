import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { streamProviderResponse } from '../../src/providers/openai-compatible';
import type { StreamEvent } from '../../src/shared/types';
import { createModel, createProvider } from '../helpers/factories';
import { byteSse, deferred, scriptedLlm, type Transport } from '../helpers/llm-mock';
import { STREAM_TIMEOUTS } from '../../src/shared/timeout';

const server = setupServer();
let script: ReturnType<typeof scriptedLlm> | undefined;
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
  const current = script;
  script = undefined;
  current?.verify();
});
afterAll(() => server.close());

function run(transport: Transport, events: StreamEvent[]) {
  return streamProviderResponse({
    provider: createProvider({ transport }), model: createModel(),
    messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: '你好' }],
    generationParams: { temperature: null }, signal: new AbortController().signal,
    requestId: 'stream-test', streamingEnabled: true, onEvent: event => events.push(event)
  });
}

describe.each<Transport>(['chat_completions', 'responses'])('%s streaming transport', transport => {
  it('aborts a provider that never sends headers and reports a retryable timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const arrived = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    script = scriptedLlm(transport, [async ({ request }) => {
      signal = request.signal;
      arrived.resolve();
      await release.promise;
      return byteSse('');
    }]);
    server.use(script.handler);
    const events: StreamEvent[] = [];
    const result = run(transport, events);
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout', retryable: true });
    try {
      await arrived.promise;
      await vi.advanceTimersByTimeAsync(STREAM_TIMEOUTS.firstByteMs);
      await assertion;
      expect(signal?.aborted).toBe(true);
      expect(events).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it.each([1, 7, 4096])('decodes UTF-8, CRLF, heartbeats and an unterminated final event with %i-byte chunks', async chunkSize => {
    const frames = transport === 'responses' ? [
      ': heartbeat',
      'event: response.output_text.delta\r\ndata: {"delta":"你好🌏"}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"思考"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}'
    ] : [
      ': heartbeat',
      'data: {"choices":[{"delta":{"content":"你好🌏"}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}'
    ];
    script = scriptedLlm(transport, [({ body }) => {
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty('temperature');
      if (transport === 'chat_completions') expect(body.stream_options).toEqual({ include_usage: true });
      return byteSse(frames.join('\r\n\r\n'), chunkSize);
    }]);
    server.use(script.handler);
    const events: StreamEvent[] = [];
    expect(await run(transport, events)).toMatchObject({ totalTokens: 6 });
    expect(events).toEqual([
      { type: 'contentDelta', requestId: 'stream-test', delta: '你好🌏' },
      { type: 'reasoningDelta', requestId: 'stream-test', delta: '思考' },
      { type: 'usageUpdate', requestId: 'stream-test', usage: expect.objectContaining({ totalTokens: 6 }) }
    ]);
  });

  it('surfaces malformed SSE after partial content as a non-retryable parse error', async () => {
    const first = transport === 'responses'
      ? { type: 'response.output_text.delta', delta: 'partial' }
      : { choices: [{ delta: { content: 'partial' } }] };
    script = scriptedLlm(transport, [() => byteSse(`data: ${JSON.stringify(first)}\n\ndata: {broken}\n\n`)]);
    server.use(script.handler);
    const events: StreamEvent[] = [];
    await expect(run(transport, events)).rejects.toMatchObject({ code: 'parse', retryable: false });
    expect(events).toEqual([{ type: 'contentDelta', requestId: 'stream-test', delta: 'partial' }]);
  });

  it.each([
    [403, 'auth', false], [404, 'model_unavailable', false],
    [408, 'http_error', true], [429, 'http_error', true], [503, 'http_error', true]
  ])('classifies HTTP %i before emitting any deltas', async (status, code, retryable) => {
    script = scriptedLlm(transport, [() => new HttpResponse(null, { status: Number(status) })]);
    server.use(script.handler);
    const events: StreamEvent[] = [];
    await expect(run(transport, events)).rejects.toMatchObject({ code, retryable, status });
    expect(events).toEqual([]);
  });

  it('classifies a network failure and does not retry implicitly', async () => {
    script = scriptedLlm(transport, [() => HttpResponse.error()]);
    server.use(script.handler);
    await expect(run(transport, [])).rejects.toMatchObject({ code: 'network', retryable: true });
  });
});
