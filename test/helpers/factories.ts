import type {
  ChatRequest,
  ChatSession,
  FeatureSettings,
  ModelConfig,
  PersistedMessage,
  PromptConfig,
  ProviderConfig,
  RootStore,
  SearchSettings,
  ToolDefinition
} from '../../src/shared/types';

export const TEST_BASE_URL = 'https://llm.test/v1';

export function createProvider(input: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-test',
    name: 'Provider Test',
    baseUrl: TEST_BASE_URL,
    apiKey: 'test-key',
    transport: 'chat_completions',
    defaultModel: 'test-model',
    defaultGenerationParams: { temperature: null },
    headers: {},
    authMode: 'bearer',
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

export function createModel(input: Partial<ModelConfig> = {}): ModelConfig {
  return {
    modelId: 'test-model',
    displayName: 'Test Model',
    supportsStreaming: true,
    maxContextMessages: null,
    reasoningFormat: 'none',
    ...input
  };
}

export function createPrompt(input: Partial<PromptConfig> = {}): PromptConfig {
  return {
    id: 'prompt-test',
    name: 'Prompt Test',
    content: 'You are a helpful assistant.',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input
  };
}

export function createSearchSettings(input: Partial<SearchSettings> = {}): SearchSettings {
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

export function createFeatureSettings(input: Partial<FeatureSettings> = {}): FeatureSettings {
  return {
    defaultProviderId: null,
    defaultPromptId: null,
    defaultStreaming: false,
    search: createSearchSettings(),
    ...input
  };
}

export function createSearchTool(): ToolDefinition {
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

export function createPersistedMessage(input: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id: 'message-1',
    role: 'assistant',
    content: 'Hello',
    reasoningSummary: null,
    toolCalls: [],
    sources: [],
    tokenUsage: null,
    mode: 'chat',
    providerId: 'provider-test',
    modelId: 'test-model',
    promptId: null,
    searchMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...input
  };
}

export function createRootStore(input: Partial<RootStore> = {}): RootStore {
  return {
    schemaVersion: 5,
    providers: [],
    prompts: [],
    featureSettings: createFeatureSettings(),
    chatHistory: [],
    ...input
  };
}

export function createChatSession(input: Partial<ChatSession> = {}): ChatSession {
  return {
    chatId: 'chat-test',
    title: 'Test chat',
    providerId: 'provider-test',
    promptId: null,
    streamingOverride: null,
    maxContextMessagesOverride: null,
    mode: 'chat',
    messages: [],
    totalUsage: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input
  };
}

export function createChatRequest(input: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: 'req-test',
    chatId: 'chat-test',
    windowTitle: 'Test window',
    providerId: 'provider-test',
    modelId: 'test-model',
    promptId: null,
    streamingOverride: null,
    maxContextMessages: null,
    maxContextMessagesOverride: null,
    userMessage: 'hello',
    mode: 'chat',
    messages: [{ role: 'user', content: 'hello' }],
    generationParams: { temperature: null },
    streamingEnabled: false,
    ...input
  };
}
