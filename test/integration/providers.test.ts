import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { completeProviderTurn, streamProviderResponse } from '../../src/providers/openai-compatible';
import { runSearchToolSession } from '../../src/search/tool-session';
import type { ChatRequestMessage, StreamEvent, StreamEventPayload } from '../../src/shared/types';
import { createModel, createProvider, createSearchSettings, createSearchTool, TEST_BASE_URL } from '../helpers/factories';
import { createSseResponse } from '../helpers/sse';

// DSML tags contain literal closing-tag text; build them programmatically.
const LT = String.fromCharCode(60);
const D = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const openTag = (name: string, attrs = '') => `${LT}${D}${name}${attrs}>`;
const closeTag = (name: string) => `${LT}/${D}${name}>`;

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  server.resetHandlers();
});

describe('chat completions parsing', () => {
  it('normalizes request headers/body and joins content parts', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(request.headers.get('authorization')).toBe('Bearer test-key');
        expect(body.model).toBe('test-model');
        expect(body.stream).toBe(false);
        expect(body.tool_choice).toBe('auto');
        const requestMessages = body.messages as Array<Record<string, unknown>>;
        expect(requestMessages[requestMessages.length - 1]).toEqual({ role: 'user', content: 'hello' });

        const tools = body.tools as Array<Record<string, unknown>>;
        expect(tools[0].type).toBe('function');
        expect((tools[0].function as Record<string, unknown>).parameters).toEqual(createSearchTool().parameters);

        return HttpResponse.json({
          usage: {
            prompt_tokens: 11,
            completion_tokens: 7,
            total_tokens: 18,
            output_tokens_details: { reasoning_tokens: 2 }
          },
          choices: [
            {
              message: {
                content: [{ text: 'Hello' }, { text: ', browser extension.' }]
              }
            }
          ]
        });
      })
    );

    const turn = await completeProviderTurn({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'hello' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()],
      toolChoice: 'auto'
    });

    expect(turn.content).toBe('Hello, browser extension.');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.usage?.inputTokens).toBe(11);
    expect(turn.usage?.outputTokens).toBe(7);
    expect(turn.usage?.reasoningTokens).toBe(2);
  });
});

describe('chat tool-call parsing', () => {
  it('keeps valid tool calls, coerces object arguments, and drops malformed ones', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_object_args',
                    type: 'function',
                    function: {
                      name: 'web_search',
                      arguments: { query: '北京天气', extra: 'ignored-by-tool' }
                    }
                  },
                  {
                    id: '',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"missing id"}' }
                  },
                  {
                    id: 'missing_name',
                    type: 'function',
                    function: { arguments: '{"query":"missing name"}' }
                  }
                ]
              }
            }
          ]
        })
      )
    );

    const turn = await completeProviderTurn({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'search' }],
      generationParams: { temperature: 0.2 },
      signal: new AbortController().signal,
      tools: [createSearchTool()]
    });

    expect(turn.toolCalls).toEqual([
      {
        id: 'call_object_args',
        name: 'web_search',
        arguments: JSON.stringify({ query: '北京天气', extra: 'ignored-by-tool' })
      }
    ]);
  });
});

describe('DSML fallback parsing', () => {
  it('extracts multiple tool calls embedded as DSML text and strips them from content', async () => {
    const dsml =
      'Answer prefix ' +
      openTag('tool_calls') +
      openTag('invoke', ' name="web_search"') +
      openTag('parameter', ' name="query" string="true"') +
      '北京天气预报 2025年1月30日' +
      closeTag('parameter') +
      openTag('parameter', ' name="locale"') +
      'zh-CN' +
      closeTag('parameter') +
      closeTag('invoke') +
      openTag('invoke', ' name="web_search"') +
      openTag('parameter', ' name="query"') +
      '上海天气' +
      closeTag('parameter') +
      closeTag('invoke') +
      closeTag('tool_calls') +
      ' answer suffix';

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({
          choices: [{ message: { content: dsml } }]
        })
      )
    );

    const turn = await completeProviderTurn({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'search with dsml' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()]
    });

    expect(turn.content).toBe('Answer prefix  answer suffix');
    expect(turn.toolCalls).toEqual([
      {
        id: 'dsml_call_1',
        name: 'web_search',
        arguments: JSON.stringify({ query: '北京天气预报 2025年1月30日', locale: 'zh-CN' })
      },
      {
        id: 'dsml_call_2',
        name: 'web_search',
        arguments: JSON.stringify({ query: '上海天气' })
      }
    ]);
  });
});

describe('standard tool calls win over DSML text', () => {
  it('uses structured tool_calls and leaves the DSML text in content', async () => {
    const dsmlText =
      openTag('tool_calls') +
      openTag('invoke', ' name="web_search"') +
      openTag('parameter', ' name="query"') +
      'wrong' +
      closeTag('parameter') +
      closeTag('invoke') +
      closeTag('tool_calls');

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({
          choices: [
            {
              message: {
                content: dsmlText,
                tool_calls: [
                  {
                    id: 'standard_call',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"standard wins"}' }
                  }
                ]
              }
            }
          ]
        })
      )
    );

    const turn = await completeProviderTurn({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'standard plus dsml' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()]
    });

    expect(turn.content.includes('DSML')).toBe(true);
    expect(turn.toolCalls).toEqual([
      { id: 'standard_call', name: 'web_search', arguments: '{"query":"standard wins"}' }
    ]);
  });
});

describe('responses transport parsing', () => {
  it('parses output blocks, function calls, and DSML fallbacks', async () => {
    let requestCount = 0;
    const dsmlResponse =
      openTag('tool_calls') +
      openTag('invoke', ' name="web_search"') +
      openTag('parameter', ' name="query"') +
      'responses dsml' +
      closeTag('parameter') +
      closeTag('invoke') +
      closeTag('tool_calls');

    server.use(
      http.post(`${TEST_BASE_URL}/responses`, async ({ request }) => {
        requestCount += 1;
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.model).toBe('test-model');
        expect(body.stream).toBe(false);
        expect(body.tool_choice).toBe('auto');
        expect(Array.isArray(body.input)).toBe(true);

        if (requestCount === 1) {
          return HttpResponse.json({
            id: 'resp_1',
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            output: [
              {
                type: 'message',
                content: [
                  { type: 'output_text', text: 'response text' },
                  { type: 'text', text: ' plus text block' }
                ]
              },
              {
                type: 'function_call',
                id: 'fallback_id',
                name: 'web_search',
                arguments: { query: 'responses object args' }
              }
            ]
          });
        }

        return HttpResponse.json({ id: 'resp_2', output_text: dsmlResponse });
      })
    );

    const standard = await completeProviderTurn({
      provider: createProvider({ transport: 'responses' }),
      model: createModel(),
      messages: [{ role: 'user', content: 'responses standard' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()],
      toolChoice: 'auto'
    });

    expect(standard.responseId).toBe('resp_1');
    expect(standard.content).toBe('response text plus text block');
    expect(standard.toolCalls).toEqual([
      {
        id: 'fallback_id',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'responses object args' })
      }
    ]);
    expect(standard.usage?.totalTokens).toBe(8);

    const dsml = await completeProviderTurn({
      provider: createProvider({ transport: 'responses' }),
      model: createModel(),
      messages: [{ role: 'user', content: 'responses dsml' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()]
    });

    expect(dsml.content).toBe('');
    expect(dsml.toolCalls).toEqual([
      {
        id: 'dsml_call_1',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'responses dsml' })
      }
    ]);
  });
});

describe('streaming parsing', () => {
  it('parses chat-completions SSE deltas and usage', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.stream).toBe(true);
        return createSseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":[{"text":"lo"}],"reasoning_content":"thinking"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
          'data: [DONE]\n\n'
        ]);
      })
    );

    const events: StreamEventPayload[] = [];
    const usage = await streamProviderResponse({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'stream chat' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      requestId: 'req-chat-stream',
      streamingEnabled: true,
      onEvent: (event) => events.push(event)
    });

    expect(events.filter((event) => event.type === 'contentDelta').map((event) => event.delta)).toEqual(['Hel', 'lo']);
    expect(events.filter((event) => event.type === 'reasoningDelta').map((event) => event.delta)).toEqual(['thinking']);
    expect(usage?.totalTokens).toBe(5);
  });

  it('parses responses SSE deltas and usage', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/responses`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.stream).toBe(true);
        return createSseResponse([
          'data: {"type":"response.output_text.delta","delta":"A"}\n\n',
          'data: {"type":"response.reasoning_summary_text.delta","delta":"R"}\n\n',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}\n\n'
        ]);
      })
    );

    const events: StreamEventPayload[] = [];
    const usage = await streamProviderResponse({
      provider: createProvider({ transport: 'responses' }),
      model: createModel(),
      messages: [{ role: 'user', content: 'stream responses' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      requestId: 'req-responses-stream',
      streamingEnabled: true,
      onEvent: (event) => events.push(event)
    });

    expect(events.filter((event) => event.type === 'contentDelta').map((event) => event.delta)).toEqual(['A']);
    expect(events.filter((event) => event.type === 'reasoningDelta').map((event) => event.delta)).toEqual(['R']);
    expect(usage?.inputTokens).toBe(4);
    expect(usage?.outputTokens).toBe(5);
    expect(usage?.totalTokens).toBe(9);
  });

  it('surfaces non-2xx responses as errors', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () =>
        HttpResponse.json({ error: 'denied' }, { status: 401 })
      )
    );

    await expect(
      completeProviderTurn({
        provider: createProvider(),
        model: createModel(),
        messages: [{ role: 'user', content: 'fail' }],
        generationParams: { temperature: null },
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/Provider returned 401/);
  });
});

describe('search tool session', () => {
  it('runs a search round, feeds results back to the model, and emits events', async () => {
    const messages: ChatRequestMessage[] = [{ role: 'user', content: '查北京天气' }];
    const llmBodies: Array<Record<string, unknown>> = [];
    let llmCount = 0;
    let tavilyBody: Record<string, unknown> | null = null;

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        llmCount += 1;
        const body = (await request.json()) as Record<string, unknown>;
        llmBodies.push(body);

        if (llmCount === 1) {
          expect(Array.isArray(body.tools)).toBe(true);
          return HttpResponse.json({
            choices: [
              {
                message: {
                  content:
                    openTag('tool_calls') +
                    openTag('invoke', ' name="web_search"') +
                    openTag('parameter', ' name="query"') +
                    '北京天气预报 2025年1月30日' +
                    closeTag('parameter') +
                    closeTag('invoke') +
                    closeTag('tool_calls')
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
          });
        }

        expect(body.tools).toBeUndefined();
        const turnMessages = body.messages as Array<Record<string, unknown>>;
        const lastTurnMessage = turnMessages[turnMessages.length - 1];
        expect(lastTurnMessage?.role).toBe('tool');
        expect(String(lastTurnMessage?.content)).toMatch(/Beijing Weather/);
        return HttpResponse.json({
          choices: [{ message: { content: '北京 2025 年 1 月 30 日天气：晴。' } }],
          usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 }
        });
      }),
      http.post('https://api.tavily.com/search', async ({ request }) => {
        tavilyBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          credits: 2,
          results: [
            {
              title: 'Beijing Weather',
              url: 'https://weather.example/beijing',
              content: 'Sunny and cold.',
              score: 0.92
            }
          ]
        });
      })
    );

    const events: StreamEvent[] = [];
    const result = await runSearchToolSession({
      provider: createProvider(),
      modelId: 'test-model',
      messages,
      requestId: 'req-search',
      searchSettings: createSearchSettings({ maxRounds: 1 }),
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    });

    expect(llmBodies.length).toBe(2);
    expect(tavilyBody).toBeTruthy();
    const capturedTavily = tavilyBody as unknown as Record<string, unknown>;
    expect(capturedTavily.api_key).toBe('tavily-key');
    expect(capturedTavily.query).toBe('北京天气预报 2025年1月30日');
    expect(result.content).toBe('北京 2025 年 1 月 30 日天气：晴。');
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0].status).toBe('completed');
    expect(result.sources.length).toBe(1);
    expect(result.searchMeta?.credits).toBe(2);
    expect(result.usage?.totalTokens).toBe(43);
    expect(events.some((event) => event.type === 'statusUpdate' && event.status === 'searching')).toBe(true);
    expect(events.some((event) => event.type === 'sourceUpdate' && event.sources.length === 1)).toBe(true);
    expect(events.some((event) => event.type === 'toolCallUpdate' && event.toolCalls[0]?.status === 'completed')).toBe(true);
  });

  it('preserves deepseek reasoning_content on the assistant tool-call message', async () => {
    const reasoningContent = '  Need weather search.\nCall the web_search tool.  ';
    const llmBodies: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        llmBodies.push(body);

        if (llmBodies.length === 1) {
          return HttpResponse.json({
            choices: [
              {
                message: {
                  content: '',
                  reasoning_content: reasoningContent,
                  tool_calls: [
                    {
                      id: 'call_deepseek_weather',
                      type: 'function',
                      function: { name: 'web_search', arguments: JSON.stringify({ query: '北京天气' }) }
                    }
                  ]
                }
              }
            ]
          });
        }

        const turnMessages = body.messages as Array<Record<string, unknown>>;
        const assistantToolMessage = turnMessages.find(
          (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
        );
        expect(assistantToolMessage?.content).toBe('');
        expect(assistantToolMessage?.reasoning_content).toBe(reasoningContent);

        return HttpResponse.json({ choices: [{ message: { content: '北京天气已获取。' } }] });
      }),
      http.post('https://api.tavily.com/search', () =>
        HttpResponse.json({
          results: [{ title: 'Beijing Weather', url: 'https://weather.example/beijing', content: 'Sunny.', score: 0.9 }]
        })
      )
    );

    await runSearchToolSession({
      provider: createProvider({
        defaultModel: 'deepseek-v4-pro',
        modelCatalog: [
          createModel({ modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', reasoningFormat: 'reasoning_content' })
        ]
      }),
      modelId: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: '查北京天气' }],
      requestId: 'req-deepseek-reasoning',
      searchSettings: createSearchSettings({ maxRounds: 1 }),
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      onEvent: () => undefined
    });

    expect(llmBodies.length).toBe(2);
  });

  it('preserves configured reasoning_content for non-deepseek models', async () => {
    const reasoningContent = 'Provider requires this reasoning_content to continue tool use.';
    const llmBodies: Array<Record<string, unknown>> = [];

    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        llmBodies.push(body);

        if (llmBodies.length === 1) {
          return HttpResponse.json({
            choices: [
              {
                message: {
                  content: '',
                  reasoning_content: reasoningContent,
                  tool_calls: [
                    {
                      id: 'call_configured_reasoning',
                      type: 'function',
                      function: {
                        name: 'web_search',
                        arguments: JSON.stringify({ query: 'configured reasoning weather' })
                      }
                    }
                  ]
                }
              }
            ]
          });
        }

        const turnMessages = body.messages as Array<Record<string, unknown>>;
        const assistantToolMessage = turnMessages.find(
          (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
        );
        expect(assistantToolMessage?.reasoning_content).toBe(reasoningContent);

        return HttpResponse.json({ choices: [{ message: { content: 'Configured reasoning content was preserved.' } }] });
      }),
      http.post('https://api.tavily.com/search', () =>
        HttpResponse.json({
          results: [
            { title: 'Configured Reasoning Weather', url: 'https://weather.example/configured', content: 'Clear.', score: 0.9 }
          ]
        })
      )
    );

    await runSearchToolSession({
      provider: createProvider({
        defaultModel: 'qwen-reasoner',
        modelCatalog: [
          createModel({ modelId: 'qwen-reasoner', displayName: 'Qwen Reasoner', reasoningFormat: 'reasoning_content' })
        ]
      }),
      modelId: 'qwen-reasoner',
      messages: [{ role: 'user', content: 'Search with configured reasoning content.' }],
      requestId: 'req-configured-reasoning',
      searchSettings: createSearchSettings({ maxRounds: 1 }),
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      onEvent: () => undefined
    });

    expect(llmBodies.length).toBe(2);
  });

  it('drops reasoning_content for models that do not request it', async () => {
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const messages = body.messages as Array<Record<string, unknown>>;

        if (messages.length === 1) {
          return HttpResponse.json({
            choices: [
              {
                message: {
                  content: '',
                  reasoning_content: 'provider-specific reasoning must not be replayed',
                  tool_calls: [
                    {
                      id: 'call_regular_weather',
                      type: 'function',
                      function: { name: 'web_search', arguments: JSON.stringify({ query: '南京天气' }) }
                    }
                  ]
                }
              }
            ]
          });
        }

        const assistantToolMessage = messages.find(
          (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
        );
        expect(Object.prototype.hasOwnProperty.call(assistantToolMessage ?? {}, 'reasoning_content')).toBe(false);

        return HttpResponse.json({ choices: [{ message: { content: '南京天气已获取。' } }] });
      }),
      http.post('https://api.tavily.com/search', () =>
        HttpResponse.json({
          results: [{ title: 'Nanjing Weather', url: 'https://weather.example/nanjing', content: 'Cloudy.', score: 0.9 }]
        })
      )
    );

    await runSearchToolSession({
      provider: createProvider(),
      modelId: 'test-model',
      messages: [{ role: 'user', content: '查南京天气' }],
      requestId: 'req-non-deepseek-reasoning',
      searchSettings: createSearchSettings({ maxRounds: 1 }),
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      onEvent: () => undefined
    });
  });

  it('records failed tool calls for invalid arguments', async () => {
    let requestCount = 0;
    server.use(
      http.post(`${TEST_BASE_URL}/chat/completions`, () => {
        requestCount += 1;
        if (requestCount === 1) {
          return HttpResponse.json({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_bad_args',
                      type: 'function',
                      function: { name: 'web_search', arguments: '{not json' }
                    }
                  ]
                }
              }
            ]
          });
        }

        return HttpResponse.json({ choices: [{ message: { content: 'Cannot search without a valid query.' } }] });
      })
    );

    const result = await runSearchToolSession({
      provider: createProvider(),
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'bad tool args' }],
      requestId: 'req-bad-args',
      searchSettings: createSearchSettings(),
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      onEvent: () => undefined
    });

    expect(result.toolCalls[0].status).toBe('failed');
    expect(result.toolCalls[0].output).toBe('Expected a non-empty query string.');
  });
});
