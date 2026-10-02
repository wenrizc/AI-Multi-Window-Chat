import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { runSearchToolSession } from '../../src/search/tool-session';
import type { StreamEvent, ToolCall } from '../../src/shared/types';
import { createProvider, createSearchSettings } from '../helpers/factories';
import { llmTurn, scriptedLlm, type Transport } from '../helpers/llm-mock';

const server = setupServer();
let scripts: ReturnType<typeof scriptedLlm>[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { scripts = []; });
afterEach(() => {
  server.resetHandlers();
  scripts.forEach(script => script.verify());
});
afterAll(() => server.close());

const call = (id: string, query: string): ToolCall => ({ id, name: 'web_search', arguments: JSON.stringify({ query }) });
function useScript(transport: Transport, steps: Parameters<typeof scriptedLlm>[1]) {
  const script = scriptedLlm(transport, steps);
  scripts.push(script);
  server.use(script.handler);
  return script;
}
function run(transport: Transport, maxRounds = 2, events: StreamEvent[] = []) {
  return runSearchToolSession({
    provider: createProvider({ transport }), modelId: 'test-model',
    messages: [{ role: 'user', content: 'Compare current weather' }],
    requestId: 'search-session', searchSettings: createSearchSettings({ maxRounds }),
    generationParams: { temperature: 0.3 }, signal: new AbortController().signal,
    onEvent: event => events.push(structuredClone(event))
  });
}

describe.each<Transport>(['chat_completions', 'responses'])('%s search orchestration', transport => {
  it('can answer directly without contacting search', async () => {
    useScript(transport, [({ body }) => {
      expect(body).toMatchObject({ stream: false, temperature: 0.3, tool_choice: 'auto' });
      expect(body.tools).toHaveLength(1);
      return llmTurn(transport, { content: 'No search needed.' });
    }]);
    expect(await run(transport)).toMatchObject({ content: 'No search needed.', sources: [], toolCalls: [], searchMeta: null, usage: { totalTokens: 5 } });
  });

  it('feeds multiple tool results back, chains rounds, and stops offering tools at the limit', async () => {
    const queries: string[] = [];
    server.use(http.post('https://api.tavily.com/search', async ({ request }) => {
      const body = await request.json() as { query: string };
      queries.push(body.query);
      return HttpResponse.json({ credits: 1, results: [{ title: body.query, url: `https://weather.test/${queries.length}`, content: 'Sunny' }] });
    }));
    const script = useScript(transport, [
      () => llmTurn(transport, { id: 'r1', calls: [call('a', 'Beijing'), call('b', 'Shanghai')] }),
      () => llmTurn(transport, { id: 'r2', calls: [call('c', 'Singapore')] }),
      ({ body }) => {
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('tool_choice');
        return llmTurn(transport, { content: 'Weather compared.' });
      }
    ]);
    const events: StreamEvent[] = [];
    const result = await run(transport, 2, events);
    expect(queries).toEqual(['Beijing', 'Shanghai', 'Singapore']);
    expect(result).toMatchObject({ content: 'Weather compared.', usage: { inputTokens: 9, outputTokens: 6, totalTokens: 15 }, searchMeta: { queries, credits: 3, sourceCount: 3 } });
    expect(result.toolCalls.map(item => [item.id, item.status])).toEqual([['a', 'completed'], ['b', 'completed'], ['c', 'completed']]);
    expect(result.sources).toHaveLength(3);
    expect(events.every(event => event.requestId === 'search-session')).toBe(true);
    expect(events.filter(event => event.type === 'sourceUpdate').map(event => event.sources.length)).toEqual([1, 2, 3]);
    if (transport === 'responses') {
      expect(script.requests[1].body).toMatchObject({ previous_response_id: 'r1', input: [
        { type: 'function_call_output', call_id: 'a', output: expect.stringContaining('Query: Beijing') },
        { type: 'function_call_output', call_id: 'b', output: expect.stringContaining('Query: Shanghai') }
      ] });
      expect(script.requests[2].body).toMatchObject({ previous_response_id: 'r2', input: [
        { type: 'function_call_output', call_id: 'c', output: expect.stringContaining('Query: Singapore') }
      ] });
    } else {
      const messages = script.requests[2].body.messages as Record<string, unknown>[];
      expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'tool']);
      expect(messages.filter(message => message.role === 'tool')).toEqual([
        expect.objectContaining({ tool_call_id: 'a', content: expect.stringContaining('Query: Beijing') }),
        expect.objectContaining({ tool_call_id: 'b', content: expect.stringContaining('Query: Shanghai') }),
        expect.objectContaining({ tool_call_id: 'c', content: expect.stringContaining('Query: Singapore') })
      ]);
    }
  });

  it.each([
    ['unsupported tool', { id: 'bad', name: 'delete_file', arguments: '{}' }, 'Unsupported tool: delete_file'],
    ['invalid JSON', { id: 'bad', name: 'web_search', arguments: '{broken' }, 'Expected a non-empty query string.'],
    ['blank query', call('bad', '  '), 'Expected a non-empty query string.']
  ] as const)('returns %s errors to the model without making a search request', async (_name, tool, error) => {
    const script = useScript(transport, [
      () => llmTurn(transport, { calls: [tool] }),
      () => llmTurn(transport, { content: 'Recovered.' })
    ]);
    const result = await run(transport);
    expect(result.toolCalls).toEqual([{ ...tool, status: 'failed', output: error }]);
    expect(result.sources).toEqual([]);
    const body = script.requests[1].body;
    const outputs = (transport === 'responses' ? body.input : body.messages) as Record<string, unknown>[];
    expect(outputs).toContainEqual(expect.objectContaining(transport === 'responses'
      ? { call_id: 'bad', output: JSON.stringify({ error }) }
      : { tool_call_id: 'bad', content: JSON.stringify({ error }) }));
  });

  it('stops the session when search fails instead of producing a fabricated answer', async () => {
    useScript(transport, [() => llmTurn(transport, { calls: [call('a', 'weather')] })]);
    server.use(http.post('https://api.tavily.com/search', () => new HttpResponse(null, { status: 503 })));
    await expect(run(transport)).rejects.toThrow(/503/);
  });

  it('handles empty search results and still supplies a tool result', async () => {
    useScript(transport, [
      () => llmTurn(transport, { calls: [call('a', '  obscure query  ')] }),
      () => llmTurn(transport, { content: 'No sources found.' })
    ]);
    server.use(http.post('https://api.tavily.com/search', () => HttpResponse.json({ results: [] })));
    expect(await run(transport)).toMatchObject({ sources: [], searchMeta: { queries: ['obscure query'], credits: null, sourceCount: 0 }, toolCalls: [{ status: 'completed', output: 'Query: obscure query' }] });
  });
});

it('rejects Responses tool calls without a response id before executing search', async () => {
  useScript('responses', [() => HttpResponse.json({ output: [{ type: 'function_call', call_id: 'a', name: 'web_search', arguments: '{"query":"weather"}' }] })]);
  await expect(run('responses')).rejects.toThrow('Responses tool call is missing response id.');
});
