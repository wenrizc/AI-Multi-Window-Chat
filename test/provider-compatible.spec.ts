import assert from 'node:assert/strict';
import { LLMock } from '@copilotkit/aimock/jest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { completeProviderTurn, streamProviderResponse } from '../src/providers/openai-compatible';
import { runSearchToolSession } from '../src/search/tool-session';
import type {
  ChatRequestMessage,
  ModelConfig,
  ProviderConfig,
  SearchSettings,
  StreamEvent,
  StreamEventPayload,
  ToolDefinition
} from '../src/shared/types';

const BASE_URL = 'https://llm.test/v1';

function createProvider(input: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-test',
    name: 'Provider Test',
    baseUrl: BASE_URL,
    apiKey: 'test-key',
    transport: 'chat_completions',
    defaultModel: 'test-model',
    defaultGenerationParams: { temperature: null },
    headers: {},
    modelCatalog: [
      {
        modelId: 'test-model',
        displayName: 'Test Model',
        supportsStreaming: true,
        maxContextMessages: null,
        reasoningFormat: 'none'
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input
  };
}

function createModel(input: Partial<ModelConfig> = {}): ModelConfig {
  return {
    modelId: 'test-model',
    displayName: 'Test Model',
    supportsStreaming: true,
    maxContextMessages: null,
    reasoningFormat: 'none',
    ...input
  };
}

function createSearchSettings(input: Partial<SearchSettings> = {}): SearchSettings {
  return {
    tavilyApiKey: 'tavily-key',
    enabledByDefault: false,
    searchDepth: 'basic',
    timeRange: null,
    maxResults: 3,
    maxRounds: 2,
    ...input
  };
}

function createSearchTool(): ToolDefinition {
  return {
    type: 'function',
    name: 'web_search',
    description: 'Search the web',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' }
      },
      required: ['query'],
      additionalProperties: false
    }
  };
}

function encodeSse(lines: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    }
  });
}

function createSseResponse(lines: string[]) {
  return new Response(encodeSse(lines), {
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

function installChromeI18nMock() {
  (globalThis as { chrome?: typeof chrome }).chrome = {
    i18n: {
      getMessage(key: string, substitutions?: string | Array<string | number>) {
        const values = Array.isArray(substitutions) ? substitutions : substitutions ? [substitutions] : [];
        const templates: Record<string, string> = {
          chat__statusDecidingSearch: 'Deciding whether to search',
          chat__statusGenerating: 'Generating',
          chat__statusSearchingFor: 'Searching for $1',
          chat__statusConfigureTavilyFirst: 'Configure Tavily first',
          chat__statusTavilyReturned: 'Tavily returned $1'
        };
        let result = templates[key] ?? key;
        values.forEach((value, index) => {
          result = result.replace(`$${index + 1}`, String(value));
        });
        return result;
      },
      getAcceptLanguages(callback?: (languages: string[]) => void) {
        const languages = ['en'];
        callback?.(languages);
        return Promise.resolve(languages);
      },
      getUILanguage() {
        return 'en';
      },
      detectLanguage(_text: string, callback?: (result: chrome.i18n.LanguageDetectionResult) => void) {
        const result = { isReliable: true, languages: [{ language: 'en', percentage: 100 }] };
        callback?.(result);
        return Promise.resolve(result);
      }
    }
  } as unknown as typeof chrome;
}

async function runWithMswServer(callback: (server: ReturnType<typeof setupServer>) => Promise<void>) {
  const server = setupServer();
  server.listen({ onUnhandledRequest: 'error' });
  try {
    await callback(server);
  } finally {
    server.close();
  }
}

async function runChatCompletionParsingTests(server: ReturnType<typeof setupServer>) {
  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      assert.equal(request.headers.get('authorization'), 'Bearer test-key');
      assert.equal(body.model, 'test-model');
      assert.equal(body.stream, false);
      assert.equal(body.tool_choice, 'auto');
      const requestMessages = body.messages as Array<Record<string, unknown>>;
      assert.deepEqual(requestMessages[requestMessages.length - 1], {
        role: 'user',
        content: 'hello'
      });

      const tools = body.tools as Array<Record<string, unknown>>;
      assert.equal(tools[0].type, 'function');
      assert.deepEqual((tools[0].function as Record<string, unknown>).parameters, createSearchTool().parameters);

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
              content: [
                { text: 'Hello' },
                { text: ', browser extension.' }
              ]
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

  assert.equal(turn.content, 'Hello, browser extension.');
  assert.deepEqual(turn.toolCalls, []);
  assert.equal(turn.usage?.inputTokens, 11);
  assert.equal(turn.usage?.outputTokens, 7);
  assert.equal(turn.usage?.reasoningTokens, 2);
}

async function runChatToolCallShapeTests(server: ReturnType<typeof setupServer>) {
  server.use(
    http.post(`${BASE_URL}/chat/completions`, () => HttpResponse.json({
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
                function: {
                  name: 'web_search',
                  arguments: '{"query":"missing id"}'
                }
              },
              {
                id: 'missing_name',
                type: 'function',
                function: {
                  arguments: '{"query":"missing name"}'
                }
              }
            ]
          }
        }
      ]
    }))
  );

  const turn = await completeProviderTurn({
    provider: createProvider(),
    model: createModel(),
    messages: [{ role: 'user', content: 'search' }],
    generationParams: { temperature: 0.2 },
    signal: new AbortController().signal,
    tools: [createSearchTool()]
  });

  assert.deepEqual(turn.toolCalls, [
    {
      id: 'call_object_args',
      name: 'web_search',
      arguments: JSON.stringify({ query: '北京天气', extra: 'ignored-by-tool' })
    }
  ]);
}

async function runDsmlFallbackParsingTests(server: ReturnType<typeof setupServer>) {
  const dsml =
    'Answer prefix <｜｜DSML｜｜tool_calls>' +
    '<｜｜DSML｜｜invoke name="web_search">' +
    '<｜｜DSML｜｜parameter name="query" string="true">北京天气预报 2025年1月30日</｜｜DSML｜｜parameter>' +
    '<｜｜DSML｜｜parameter name="locale">zh-CN</｜｜DSML｜｜parameter>' +
    '</｜｜DSML｜｜invoke>' +
    '<｜｜DSML｜｜invoke name="web_search">' +
    '<｜｜DSML｜｜parameter name="query">上海天气</｜｜DSML｜｜parameter>' +
    '</｜｜DSML｜｜invoke>' +
    '</｜｜DSML｜｜tool_calls> answer suffix';

  server.use(
    http.post(`${BASE_URL}/chat/completions`, () => HttpResponse.json({
      choices: [
        {
          message: {
            content: dsml
          }
        }
      ]
    }))
  );

  const turn = await completeProviderTurn({
    provider: createProvider(),
    model: createModel(),
    messages: [{ role: 'user', content: 'search with dsml' }],
    generationParams: { temperature: null },
    signal: new AbortController().signal,
    tools: [createSearchTool()]
  });

  assert.equal(turn.content, 'Answer prefix  answer suffix');
  assert.deepEqual(turn.toolCalls, [
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
}

async function runStandardToolCallsBeatDsmlTextTests(server: ReturnType<typeof setupServer>) {
  server.use(
    http.post(`${BASE_URL}/chat/completions`, () => HttpResponse.json({
      choices: [
        {
          message: {
            content: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="web_search"><｜｜DSML｜｜parameter name="query">wrong</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
            tool_calls: [
              {
                id: 'standard_call',
                type: 'function',
                function: {
                  name: 'web_search',
                  arguments: '{"query":"standard wins"}'
                }
              }
            ]
          }
        }
      ]
    }))
  );

  const turn = await completeProviderTurn({
    provider: createProvider(),
    model: createModel(),
    messages: [{ role: 'user', content: 'standard plus dsml' }],
    generationParams: { temperature: null },
    signal: new AbortController().signal,
    tools: [createSearchTool()]
  });

  assert.equal(turn.content.includes('DSML'), true);
  assert.deepEqual(turn.toolCalls, [
    {
      id: 'standard_call',
      name: 'web_search',
      arguments: '{"query":"standard wins"}'
    }
  ]);
}

async function runResponsesParsingTests(server: ReturnType<typeof setupServer>) {
  let requestCount = 0;
  server.use(
    http.post(`${BASE_URL}/responses`, async ({ request }) => {
      requestCount += 1;
      const body = await request.json() as Record<string, unknown>;
      assert.equal(body.model, 'test-model');
      assert.equal(body.stream, false);
      assert.equal(body.tool_choice, 'auto');
      assert.ok(Array.isArray(body.input));

      if (requestCount === 1) {
        return HttpResponse.json({
          id: 'resp_1',
          usage: {
            input_tokens: 5,
            output_tokens: 3,
            total_tokens: 8
          },
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

      return HttpResponse.json({
        id: 'resp_2',
        output_text: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="web_search"><｜｜DSML｜｜parameter name="query">responses dsml</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>'
      });
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

  assert.equal(standard.responseId, 'resp_1');
  assert.equal(standard.content, 'response text plus text block');
  assert.deepEqual(standard.toolCalls, [
    {
      id: 'fallback_id',
      name: 'web_search',
      arguments: JSON.stringify({ query: 'responses object args' })
    }
  ]);
  assert.equal(standard.usage?.totalTokens, 8);

  const dsml = await completeProviderTurn({
    provider: createProvider({ transport: 'responses' }),
    model: createModel(),
    messages: [{ role: 'user', content: 'responses dsml' }],
    generationParams: { temperature: null },
    signal: new AbortController().signal,
    tools: [createSearchTool()]
  });

  assert.equal(dsml.content, '');
  assert.deepEqual(dsml.toolCalls, [
    {
      id: 'dsml_call_1',
      name: 'web_search',
      arguments: JSON.stringify({ query: 'responses dsml' })
    }
  ]);
}

async function runStreamingParsingTests(server: ReturnType<typeof setupServer>) {
  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      assert.equal(body.stream, true);
      return createSseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":[{"text":"lo"}],"reasoning_content":"thinking"}}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
        'data: [DONE]\n\n'
      ]);
    })
  );

  const chatEvents: StreamEventPayload[] = [];
  const usage = await streamProviderResponse({
    provider: createProvider(),
    model: createModel(),
    messages: [{ role: 'user', content: 'stream chat' }],
    generationParams: { temperature: null },
    signal: new AbortController().signal,
    requestId: 'req-chat-stream',
    streamingEnabled: true,
    onEvent: (event) => chatEvents.push(event)
  });

  assert.deepEqual(
    chatEvents.filter((event) => event.type === 'contentDelta').map((event) => event.delta),
    ['Hel', 'lo']
  );
  assert.deepEqual(
    chatEvents.filter((event) => event.type === 'reasoningDelta').map((event) => event.delta),
    ['thinking']
  );
  assert.equal(usage?.totalTokens, 5);

  server.resetHandlers();
  server.use(
    http.post(`${BASE_URL}/responses`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      assert.equal(body.stream, true);
      return createSseResponse([
        'data: {"type":"response.output_text.delta","delta":"A"}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"R"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}\n\n'
      ]);
    })
  );

  const responsesEvents: StreamEventPayload[] = [];
  const responsesUsage = await streamProviderResponse({
    provider: createProvider({ transport: 'responses' }),
    model: createModel(),
    messages: [{ role: 'user', content: 'stream responses' }],
    generationParams: { temperature: null },
    signal: new AbortController().signal,
    requestId: 'req-responses-stream',
    streamingEnabled: true,
    onEvent: (event) => responsesEvents.push(event)
  });

  assert.deepEqual(
    responsesEvents.filter((event) => event.type === 'contentDelta').map((event) => event.delta),
    ['A']
  );
  assert.deepEqual(
    responsesEvents.filter((event) => event.type === 'reasoningDelta').map((event) => event.delta),
    ['R']
  );
  assert.equal(responsesUsage?.inputTokens, 4);
  assert.equal(responsesUsage?.outputTokens, 5);
  assert.equal(responsesUsage?.totalTokens, 9);
}

async function runProviderErrorTests(server: ReturnType<typeof setupServer>) {
  server.use(
    http.post(`${BASE_URL}/chat/completions`, () => HttpResponse.json({ error: 'denied' }, { status: 401 }))
  );

  await assert.rejects(
    () => completeProviderTurn({
      provider: createProvider(),
      model: createModel(),
      messages: [{ role: 'user', content: 'fail' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal
    }),
    /Provider returned 401/
  );
}

async function runSearchToolSessionTests(server: ReturnType<typeof setupServer>) {
  installChromeI18nMock();

  const messages: ChatRequestMessage[] = [{ role: 'user', content: '查北京天气' }];
  const llmBodies: Array<Record<string, unknown>> = [];
  let llmCount = 0;
  let tavilyBody: Record<string, unknown> | null = null;

  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      llmCount += 1;
      const body = await request.json() as Record<string, unknown>;
      llmBodies.push(body);

      if (llmCount === 1) {
        assert.ok(Array.isArray(body.tools), 'Search mode should send the web_search tool on the first turn.');
        return HttpResponse.json({
          choices: [
            {
              message: {
                content: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="web_search"><｜｜DSML｜｜parameter name="query">北京天气预报 2025年1月30日</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>'
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14
          }
        });
      }

      assert.equal(body.tools, undefined, 'Search tools should be disabled after maxRounds is reached.');
      const turnMessages = body.messages as Array<Record<string, unknown>>;
      const lastTurnMessage = turnMessages[turnMessages.length - 1];
      assert.equal(lastTurnMessage?.role, 'tool');
      assert.match(String(lastTurnMessage?.content), /Beijing Weather/);
      return HttpResponse.json({
        choices: [
          {
            message: {
              content: '北京 2025 年 1 月 30 日天气：晴。'
            }
          }
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 9,
          total_tokens: 29
        }
      });
    }),
    http.post('https://api.tavily.com/search', async ({ request }) => {
      tavilyBody = await request.json() as Record<string, unknown>;
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

  assert.equal(llmBodies.length, 2);
  assert.ok(tavilyBody);
  const capturedTavilyBody = tavilyBody as Record<string, unknown>;
  assert.equal(capturedTavilyBody.api_key, 'tavily-key');
  assert.equal(capturedTavilyBody.query, '北京天气预报 2025年1月30日');
  assert.equal(result.content, '北京 2025 年 1 月 30 日天气：晴。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].status, 'completed');
  assert.equal(result.sources.length, 1);
  assert.equal(result.searchMeta?.credits, 2);
  assert.equal(result.usage?.totalTokens, 43);
  assert.ok(events.some((event) => event.type === 'statusUpdate' && event.status === 'searching'));
  assert.ok(events.some((event) => event.type === 'sourceUpdate' && event.sources.length === 1));
  assert.ok(events.some((event) => event.type === 'toolCallUpdate' && event.toolCalls[0]?.status === 'completed'));
}

async function runDeepSeekReasoningContentHistoryTests(server: ReturnType<typeof setupServer>) {
  installChromeI18nMock();

  const reasoningContent = '  Need weather search.\nCall the web_search tool.  ';
  const llmBodies: Array<Record<string, unknown>> = [];

  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
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
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ query: '北京天气' })
                    }
                  }
                ]
              }
            }
          ]
        });
      }

      const turnMessages = body.messages as Array<Record<string, unknown>>;
      const assistantToolMessage = turnMessages.find((message) =>
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      );
      assert.equal(assistantToolMessage?.content, '');
      assert.equal(assistantToolMessage?.reasoning_content, reasoningContent);

      return HttpResponse.json({
        choices: [
          {
            message: {
              content: '北京天气已获取。'
            }
          }
        ]
      });
    }),
    http.post('https://api.tavily.com/search', () => HttpResponse.json({
      results: [
        {
          title: 'Beijing Weather',
          url: 'https://weather.example/beijing',
          content: 'Sunny.',
          score: 0.9
        }
      ]
    }))
  );

  await runSearchToolSession({
    provider: createProvider({
      defaultModel: 'deepseek-v4-pro',
      modelCatalog: [
        createModel({
          modelId: 'deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          reasoningFormat: 'reasoning_content'
        })
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

  assert.equal(llmBodies.length, 2);
}

async function runConfiguredReasoningContentHistoryTests(server: ReturnType<typeof setupServer>) {
  installChromeI18nMock();

  const reasoningContent = 'Provider requires this reasoning_content to continue tool use.';
  const llmBodies: Array<Record<string, unknown>> = [];

  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
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
      const assistantToolMessage = turnMessages.find((message) =>
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      );
      assert.equal(assistantToolMessage?.reasoning_content, reasoningContent);

      return HttpResponse.json({
        choices: [
          {
            message: {
              content: 'Configured reasoning content was preserved.'
            }
          }
        ]
      });
    }),
    http.post('https://api.tavily.com/search', () => HttpResponse.json({
      results: [
        {
          title: 'Configured Reasoning Weather',
          url: 'https://weather.example/configured',
          content: 'Clear.',
          score: 0.9
        }
      ]
    }))
  );

  await runSearchToolSession({
    provider: createProvider({
      defaultModel: 'qwen-reasoner',
      modelCatalog: [
        createModel({
          modelId: 'qwen-reasoner',
          displayName: 'Qwen Reasoner',
          reasoningFormat: 'reasoning_content'
        })
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

  assert.equal(llmBodies.length, 2);
}

async function runNonDeepSeekReasoningContentHistoryTests(server: ReturnType<typeof setupServer>) {
  installChromeI18nMock();

  server.use(
    http.post(`${BASE_URL}/chat/completions`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
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
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ query: '南京天气' })
                    }
                  }
                ]
              }
            }
          ]
        });
      }

      const assistantToolMessage = messages.find((message) =>
        message.role === 'assistant' && Array.isArray(message.tool_calls)
      );
      assert.ok(!Object.prototype.hasOwnProperty.call(assistantToolMessage ?? {}, 'reasoning_content'));

      return HttpResponse.json({
        choices: [
          {
            message: {
              content: '南京天气已获取。'
            }
          }
        ]
      });
    }),
    http.post('https://api.tavily.com/search', () => HttpResponse.json({
      results: [
        {
          title: 'Nanjing Weather',
          url: 'https://weather.example/nanjing',
          content: 'Cloudy.',
          score: 0.9
        }
      ]
    }))
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
}

async function runSearchFailureTests(server: ReturnType<typeof setupServer>) {
  installChromeI18nMock();
  let requestCount = 0;
  server.use(
    http.post(`${BASE_URL}/chat/completions`, () => {
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
                    function: {
                      name: 'web_search',
                      arguments: '{not json'
                    }
                  }
                ]
              }
            }
          ]
        });
      }

      return HttpResponse.json({
        choices: [
          {
            message: {
              content: 'Cannot search without a valid query.'
            }
          }
        ]
      });
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

  assert.equal(result.toolCalls[0].status, 'failed');
  assert.equal(result.toolCalls[0].output, 'Expected a non-empty query string.');
}

async function runAimockTests() {
  const textMock = new LLMock({ port: 0, logLevel: 'silent' });
  textMock.onMessage('aimock hello', { content: 'Hello from aimock.' });
  await textMock.start();
  try {
    const turn = await completeProviderTurn({
      provider: createProvider({ baseUrl: `${textMock.url}/v1` }),
      model: createModel(),
      messages: [{ role: 'user', content: 'aimock hello' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal
    });

    assert.equal(turn.content, 'Hello from aimock.');
    assert.equal(textMock.getRequests().length, 1);
  } finally {
    await textMock.stop();
  }

  const toolMock = new LLMock({ port: 0, logLevel: 'silent' });
  toolMock.onToolCall('web_search', {
    toolCalls: [
      {
        id: 'aimock_tool_call',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'aimock weather' })
      }
    ]
  });
  await toolMock.start();
  try {
    const turn = await completeProviderTurn({
      provider: createProvider({ baseUrl: `${toolMock.url}/v1` }),
      model: createModel(),
      messages: [{ role: 'user', content: 'use a tool' }],
      generationParams: { temperature: null },
      signal: new AbortController().signal,
      tools: [createSearchTool()],
      toolChoice: 'auto'
    });

    assert.deepEqual(turn.toolCalls, [
      {
        id: 'aimock_tool_call',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'aimock weather' })
      }
    ]);
    assert.equal(toolMock.getLastRequest()?.path, '/v1/chat/completions');
    assert.equal(toolMock.getLastRequest()?.body?.model, 'test-model');
  } finally {
    await toolMock.stop();
  }
}

export async function runProviderCompatibleTests() {
  await runWithMswServer(async (server) => {
    await runChatCompletionParsingTests(server);
    server.resetHandlers();
    await runChatToolCallShapeTests(server);
    server.resetHandlers();
    await runDsmlFallbackParsingTests(server);
    server.resetHandlers();
    await runStandardToolCallsBeatDsmlTextTests(server);
    server.resetHandlers();
    await runResponsesParsingTests(server);
    server.resetHandlers();
    await runStreamingParsingTests(server);
    server.resetHandlers();
    await runProviderErrorTests(server);
    server.resetHandlers();
    await runSearchToolSessionTests(server);
    server.resetHandlers();
    await runDeepSeekReasoningContentHistoryTests(server);
    server.resetHandlers();
    await runConfiguredReasoningContentHistoryTests(server);
    server.resetHandlers();
    await runNonDeepSeekReasoningContentHistoryTests(server);
    server.resetHandlers();
    await runSearchFailureTests(server);
  });

  await runAimockTests();
}
