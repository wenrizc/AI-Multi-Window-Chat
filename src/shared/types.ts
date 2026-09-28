import type { FailureCode } from './errors';

export type ChatRole = 'system' | 'user' | 'assistant';

export type TransportType = 'chat_completions' | 'responses';

export type ReasoningFormat = 'none' | 'openai_summary' | 'reasoning_content';

/**
 * How the provider request is authenticated.
 *
 * - `bearer`: inject `Authorization: Bearer <apiKey>` automatically.
 * - `custom`: the user manages auth entirely through custom headers.
 * - `none`:   no auth header is sent.
 *
 * Optional so that providers saved before this field existed keep working; it
 * is normalized to `bearer` on read/write.
 */
export type AuthMode = 'bearer' | 'custom' | 'none';

export type ChatMode = 'chat' | 'search';

export interface UsageMetrics {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  totalTokens: number | null;
}

export interface ModelConfig {
  modelId: string;
  displayName: string;
  supportsStreaming: boolean;
  maxContextMessages: number | null;
  reasoningFormat: ReasoningFormat;
}

export interface GenerationParams {
  temperature: number | null;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  transport: TransportType;
  defaultModel: string;
  defaultGenerationParams: GenerationParams;
  headers: Record<string, string>;
  authMode?: AuthMode;
  modelCatalog: ModelConfig[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptConfig {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchSettings {
  tavilyApiKey: string;
  enabledByDefault: boolean;
  searchDepth: 'basic' | 'advanced';
  timeRange: 'day' | 'week' | 'month' | 'year' | null;
  maxResults: number;
  maxRounds: number;
}

export interface FeatureSettings {
  defaultProviderId: string | null;
  defaultPromptId: string | null;
  defaultStreaming: boolean;
  search: SearchSettings;
}

export interface SearchSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  score: number | null;
  query: string;
  credits: number | null;
}

export interface SearchMeta {
  queries: string[];
  credits: number | null;
  sourceCount: number;
  rounds: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  status: 'pending' | 'completed' | 'failed';
  arguments: string;
  output: string | null;
}

export interface PersistedMessage {
  id: string;
  role: ChatRole;
  content: string;
  reasoningSummary: string | null;
  toolCalls: ToolCallRecord[];
  sources: SearchSource[];
  tokenUsage: UsageMetrics | null;
  mode: ChatMode;
  providerId: string | null;
  modelId: string | null;
  promptId: string | null;
  searchMeta: SearchMeta | null;
  createdAt: string;
}

export interface ChatSession {
  chatId: string;
  title: string;
  providerId: string | null;
  promptId: string | null;
  streamingOverride: boolean | null;
  maxContextMessagesOverride: number | null;
  mode: ChatMode;
  messages: PersistedMessage[];
  totalUsage: UsageMetrics | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageConfig {
  schemaVersion: 5;
  providers: ProviderConfig[];
  prompts: PromptConfig[];
  featureSettings: FeatureSettings;
}

export interface ChatIndexEntry {
  chatId: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  approxBytes: number;
}

export interface RootStore extends StorageConfig {
  chatHistory: ChatSession[];
}

export const STORAGE_SCHEMA_VERSION = 5 as const;

export interface ChatRequestMessage {
  role: ChatRole;
  content: string;
}

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssistantToolCallMessage {
  role: 'assistant';
  content: string;
  reasoningContent?: string | null;
  toolCalls: ToolCall[];
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
}

export type ProviderMessage = ChatRequestMessage | AssistantToolCallMessage | ToolResultMessage;

export type ProviderToolChoice = 'auto' | 'none';

export interface ProviderTurnResult {
  content: string;
  reasoningSummary: string | null;
  reasoningContent?: string | null;
  usage: UsageMetrics | null;
  toolCalls: ToolCall[];
  responseId: string | null;
}

export interface ChatRequest {
  requestId: string;
  chatId: string;
  windowTitle: string;
  providerId: string;
  modelId: string;
  promptId: string | null;
  streamingOverride: boolean | null;
  maxContextMessages: number | null;
  maxContextMessagesOverride: number | null;
  userMessage: string;
  mode: ChatMode;
  messages: ChatRequestMessage[];
  generationParams: GenerationParams;
  streamingEnabled: boolean;
}

export interface LlmResponseSummary {
  content: string;
  reasoningSummary: string | null;
  toolCalls: ToolCallRecord[];
  usage: UsageMetrics | null;
  sources: SearchSource[];
  searchMeta: SearchMeta | null;
}

export type StreamStatus =
  | 'started'
  | 'deciding_search'
  | 'searching'
  | 'generating'
  | 'usage'
  | 'completed'
  | 'aborted'
  | 'error';

type StreamEventBase = {
  started: { type: 'started'; mode: ChatMode };
  statusUpdate: { type: 'statusUpdate'; status: StreamStatus; message: string };
  contentDelta: { type: 'contentDelta'; delta: string };
  reasoningDelta: { type: 'reasoningDelta'; delta: string };
  toolCallUpdate: { type: 'toolCallUpdate'; toolCalls: ToolCallRecord[] };
  sourceUpdate: { type: 'sourceUpdate'; sources: SearchSource[]; searchMeta: SearchMeta | null };
  usageUpdate: { type: 'usageUpdate'; usage: UsageMetrics | null };
  completed: { type: 'completed'; response: LlmResponseSummary };
  aborted: { type: 'aborted' };
  failed: { type: 'failed'; error: string; code: FailureCode; retryable: boolean; status?: number | null };
};

export type StreamEventPayload = StreamEventBase[keyof StreamEventBase];

type WithRequestId<T> = T & { requestId: string };

export type StreamEvent =
  | WithRequestId<StreamEventBase['started']>
  | WithRequestId<StreamEventBase['statusUpdate']>
  | WithRequestId<StreamEventBase['contentDelta']>
  | WithRequestId<StreamEventBase['reasoningDelta']>
  | WithRequestId<StreamEventBase['toolCallUpdate']>
  | WithRequestId<StreamEventBase['sourceUpdate']>
  | WithRequestId<StreamEventBase['usageUpdate']>
  | WithRequestId<StreamEventBase['completed']>
  | WithRequestId<StreamEventBase['aborted']>
  | WithRequestId<StreamEventBase['failed']>;
