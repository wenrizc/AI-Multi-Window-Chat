import { expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { ProviderConfig, ToolCall } from '../../src/shared/types';
import { TEST_BASE_URL } from './factories';

export type Transport = ProviderConfig['transport'];
export interface RecordedRequest {
  body: Record<string, unknown>;
  request: Request;
}
type Step = (input: RecordedRequest) => Response | Promise<Response>;

/** HTTP-boundary script. Each instance owns its queue, including concurrent chats.
 * Assertions in MSW handlers otherwise become HTTP 500s; retain and rethrow them
 * during verification so an expected HTTP failure cannot hide a broken fixture.
 */
export function scriptedLlm(transport: Transport, steps: Step[], baseUrl = TEST_BASE_URL) {
  const requests: RecordedRequest[] = [];
  const errors: unknown[] = [];
  const handler = http.post(`${baseUrl}/${transport === 'responses' ? 'responses' : 'chat/completions'}`, async ({ request }) => {
    const index = requests.length;
    try {
      const input = { request, body: await request.json() as Record<string, unknown> };
      requests.push(input);
      if (!steps[index]) throw new Error(`Unexpected LLM request #${index + 1}: ${request.url}`);
      return await steps[index](input);
    } catch (error) {
      errors.push(error);
      return HttpResponse.json({ error: 'LLM mock script failed' }, { status: 500 });
    }
  });
  return {
    handler,
    requests,
    verify() {
      if (errors.length) throw errors[0];
      expect(requests).toHaveLength(steps.length);
    }
  };
}

/** Fixed wire fixtures; no production serializer/parser is used by the mock. */
export function llmTurn(transport: Transport, options: {
  content?: string;
  calls?: ToolCall[];
  id?: string;
} = {}): Response {
  const { content = '', calls = [], id = 'response-test' } = options;
  return HttpResponse.json(transport === 'responses' ? {
    id,
    output: [
      { type: 'message', content: [{ type: 'output_text', text: content }] },
      ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }))
    ],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
  } : {
    choices: [{ message: {
      role: 'assistant', content,
      tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }))
    } }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  });
}

/** Split encoded bytes, including within UTF-8 characters and SSE delimiters. */
export function byteSse(text: string, chunkSize = 1): Response {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer');
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.length);
    }
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

/** Explicit synchronization instead of timing-dependent sleeps. */
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
