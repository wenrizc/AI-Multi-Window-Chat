import { completeProviderTurn } from '../providers/openai-compatible';
import { searchWithTavily } from './tavily';
import type {
  AssistantToolCallMessage,
  ProviderConfig,
  ProviderMessage,
  SearchMeta,
  SearchSettings,
  SearchSource,
  StreamEvent,
  StreamEventPayload,
  ToolCall,
  ToolCallRecord,
  ToolDefinition,
  ToolResultMessage,
  UsageMetrics
} from '../shared/types';
import { addUsage, clampSearchRounds, getModel, i18nMessage } from '../shared/utils';

interface SearchToolSessionResult {
  content: string;
  reasoningSummary: string | null;
  toolCalls: ToolCallRecord[];
  usage: UsageMetrics | null;
  sources: SearchSource[];
  searchMeta: SearchMeta | null;
}

const SEARCH_TOOL_NAME = 'web_search';

function emit(
  requestId: string,
  onEvent: (event: StreamEvent) => void,
  event: StreamEventPayload
) {
  onEvent({ ...event, requestId });
}

function createSearchToolDefinition(): ToolDefinition {
  return {
    type: 'function',
    name: SEARCH_TOOL_NAME,
    description:
      'Search the live web for up-to-date facts. Use this when the answer depends on current information, recent events, or external sources.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The concise web search query to send to Tavily.'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  };
}

function buildSearchMeta(queries: string[], sources: SearchSource[], credits: number | null): SearchMeta | null {
  if (queries.length === 0) {
    return null;
  }

  return {
    queries: [...queries],
    credits,
    sourceCount: sources.length,
    rounds: queries.length
  };
}

function upsertToolCallRecord(records: ToolCallRecord[], next: ToolCallRecord): ToolCallRecord[] {
  const index = records.findIndex((record) => record.id === next.id);
  if (index >= 0) {
    records[index] = next;
  } else {
    records.push(next);
  }
  return [...records];
}

function parseSearchQuery(toolCall: ToolCall): string | null {
  try {
    const parsed = JSON.parse(toolCall.arguments) as Record<string, unknown>;
    return typeof parsed.query === 'string' && parsed.query.trim() ? parsed.query.trim() : null;
  } catch {
    return null;
  }
}

function formatToolOutput(input: {
  query: string;
  sources: SearchSource[];
  searchMeta: SearchMeta | null;
}): string {
  const lines = [`Query: ${input.query}`];
  input.sources.forEach((source, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.snippet) {
      lines.push(`Summary: ${source.snippet}`);
    }
  });
  if (input.searchMeta?.credits !== null) {
    lines.push('');
    lines.push(`Credits: ${input.searchMeta?.credits ?? 0}`);
  }
  return lines.join('\n');
}

async function executeToolCall(input: {
  toolCall: ToolCall;
  requestId: string;
  searchSettings: SearchSettings;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
  aggregateQueries: string[];
  aggregateSources: SearchSource[];
  aggregateCredits: { total: number; hasValue: boolean };
  toolCallRecords: ToolCallRecord[];
}): Promise<{ toolOutput: ToolResultMessage; toolCalls: ToolCallRecord[] }> {
  const pendingRecord: ToolCallRecord = {
    id: input.toolCall.id,
    name: input.toolCall.name,
    status: 'pending',
    arguments: input.toolCall.arguments,
    output: null
  };
  const pendingRecords = upsertToolCallRecord(input.toolCallRecords, pendingRecord);
  emit(input.requestId, input.onEvent, {
    type: 'toolCallUpdate',
    toolCalls: pendingRecords
  });

  if (input.toolCall.name !== SEARCH_TOOL_NAME) {
    const failedRecord: ToolCallRecord = {
      ...pendingRecord,
      status: 'failed',
      output: `Unsupported tool: ${input.toolCall.name}`
    };
    const nextRecords = upsertToolCallRecord(input.toolCallRecords, failedRecord);
    emit(input.requestId, input.onEvent, {
      type: 'toolCallUpdate',
      toolCalls: nextRecords
    });
    return {
      toolCalls: nextRecords,
      toolOutput: {
        role: 'tool',
        toolCallId: input.toolCall.id,
        name: input.toolCall.name,
        content: JSON.stringify({ error: `Unsupported tool: ${input.toolCall.name}` })
      }
    };
  }

  const query = parseSearchQuery(input.toolCall);
  if (!query) {
    const failedRecord: ToolCallRecord = {
      ...pendingRecord,
      status: 'failed',
      output: 'Expected a non-empty query string.'
    };
    const nextRecords = upsertToolCallRecord(input.toolCallRecords, failedRecord);
    emit(input.requestId, input.onEvent, {
      type: 'toolCallUpdate',
      toolCalls: nextRecords
    });
    return {
      toolCalls: nextRecords,
      toolOutput: {
        role: 'tool',
        toolCallId: input.toolCall.id,
        name: input.toolCall.name,
        content: JSON.stringify({ error: 'Expected a non-empty query string.' })
      }
    };
  }

  emit(input.requestId, input.onEvent, {
    type: 'statusUpdate',
    status: 'searching',
    message: i18nMessage('chat__statusSearchingFor', query)
  });

  const searchResult = await searchWithTavily({
    query,
    settings: input.searchSettings,
    signal: input.signal
  });

  input.aggregateQueries.push(query);
  input.aggregateSources.push(...searchResult.sources);
  if (searchResult.searchMeta?.credits !== null) {
    input.aggregateCredits.total += searchResult.searchMeta?.credits ?? 0;
    input.aggregateCredits.hasValue = true;
  }

  const nextSearchMeta = buildSearchMeta(
    input.aggregateQueries,
    input.aggregateSources,
    input.aggregateCredits.hasValue ? input.aggregateCredits.total : null
  );

  emit(input.requestId, input.onEvent, {
    type: 'sourceUpdate',
    sources: input.aggregateSources,
    searchMeta: nextSearchMeta
  });

  const output = formatToolOutput({
    query,
    sources: searchResult.sources,
    searchMeta: searchResult.searchMeta
  });
  const completedRecord: ToolCallRecord = {
    ...pendingRecord,
    status: 'completed',
    output
  };
  const nextRecords = upsertToolCallRecord(input.toolCallRecords, completedRecord);
  emit(input.requestId, input.onEvent, {
    type: 'toolCallUpdate',
    toolCalls: nextRecords
  });

  return {
    toolCalls: nextRecords,
    toolOutput: {
      role: 'tool',
      toolCallId: input.toolCall.id,
      name: input.toolCall.name,
      content: output
    }
  };
}

export async function runSearchToolSession(input: {
  provider: ProviderConfig;
  modelId: string;
  messages: ProviderMessage[];
  requestId: string;
  searchSettings: SearchSettings;
  generationParams: { temperature: number | null };
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}): Promise<SearchToolSessionResult> {
  const model = getModel(input.provider, input.modelId);
  const searchTool = createSearchToolDefinition();
  const maxRounds = clampSearchRounds(input.searchSettings.maxRounds);
  const preserveReasoningContent = model.reasoningFormat === 'reasoning_content';

  let usage: UsageMetrics | null = null;
  let content = '';
  let reasoningSummary: string | null = null;
  let toolCalls: ToolCallRecord[] = [];
  const queries: string[] = [];
  const allSources: SearchSource[] = [];
  const credits = { total: 0, hasValue: false };

  if (input.provider.transport === 'responses') {
    let previousResponseId: string | null = null;
    let pendingToolOutputs: ToolResultMessage[] = [];
    let toolsEnabled = true;
    let roundsUsed = 0;

    while (true) {
      emit(input.requestId, input.onEvent, {
        type: 'statusUpdate',
        status: roundsUsed === 0 ? 'deciding_search' : 'generating',
        message: i18nMessage(roundsUsed === 0 ? 'chat__statusDecidingSearch' : 'chat__statusGenerating')
      });

      const turn = await completeProviderTurn({
        provider: input.provider,
        model,
        messages: previousResponseId ? undefined : input.messages,
        previousResponseId,
        toolOutputs: previousResponseId ? pendingToolOutputs : undefined,
        generationParams: input.generationParams,
        signal: input.signal,
        tools: toolsEnabled ? [searchTool] : undefined,
        toolChoice: toolsEnabled ? 'auto' : undefined
      });

      usage = addUsage(usage, turn.usage);
      content = turn.content;
      reasoningSummary = turn.reasoningSummary;

      if (turn.toolCalls.length === 0) {
        return {
          content,
          reasoningSummary,
          toolCalls,
          usage,
          sources: allSources,
          searchMeta: buildSearchMeta(
            queries,
            allSources,
            credits.hasValue ? credits.total : null
          )
        };
      }

      if (!turn.responseId) {
        throw new Error('Responses tool call is missing response id.');
      }

      pendingToolOutputs = [];
      for (const toolCall of turn.toolCalls) {
        const toolResult = await executeToolCall({
          toolCall,
          requestId: input.requestId,
          searchSettings: input.searchSettings,
          signal: input.signal,
          onEvent: input.onEvent,
          aggregateQueries: queries,
          aggregateSources: allSources,
          aggregateCredits: credits,
          toolCallRecords: toolCalls
        });
        toolCalls = toolResult.toolCalls;
        pendingToolOutputs.push(toolResult.toolOutput);
      }

      previousResponseId = turn.responseId;
      roundsUsed += 1;
      if (roundsUsed >= maxRounds) {
        toolsEnabled = false;
      }
    }
  }

  let messages = [...input.messages];
  let toolsEnabled = true;
  let roundsUsed = 0;

  while (true) {
    emit(input.requestId, input.onEvent, {
      type: 'statusUpdate',
      status: roundsUsed === 0 ? 'deciding_search' : 'generating',
      message: i18nMessage(roundsUsed === 0 ? 'chat__statusDecidingSearch' : 'chat__statusGenerating')
    });

    const turn = await completeProviderTurn({
      provider: input.provider,
      model,
      messages,
      generationParams: input.generationParams,
      signal: input.signal,
      tools: toolsEnabled ? [searchTool] : undefined,
      toolChoice: toolsEnabled ? 'auto' : undefined
    });

    usage = addUsage(usage, turn.usage);
    content = turn.content;
    reasoningSummary = turn.reasoningSummary;

    if (turn.toolCalls.length === 0) {
      return {
        content,
        reasoningSummary,
        toolCalls,
        usage,
        sources: allSources,
        searchMeta: buildSearchMeta(
          queries,
          allSources,
          credits.hasValue ? credits.total : null
        )
      };
    }

    const toolOutputs: ToolResultMessage[] = [];
    for (const toolCall of turn.toolCalls) {
      const toolResult = await executeToolCall({
        toolCall,
        requestId: input.requestId,
        searchSettings: input.searchSettings,
        signal: input.signal,
        onEvent: input.onEvent,
        aggregateQueries: queries,
        aggregateSources: allSources,
        aggregateCredits: credits,
        toolCallRecords: toolCalls
      });
      toolCalls = toolResult.toolCalls;
      toolOutputs.push(toolResult.toolOutput);
    }

    const assistantToolMessage: AssistantToolCallMessage = {
      role: 'assistant',
      content: turn.content,
      toolCalls: turn.toolCalls
    };
    if (preserveReasoningContent && typeof turn.reasoningContent === 'string') {
      assistantToolMessage.reasoningContent = turn.reasoningContent;
    }

    messages = [
      ...messages,
      assistantToolMessage,
      ...toolOutputs
    ];

    roundsUsed += 1;
    if (roundsUsed >= maxRounds) {
      toolsEnabled = false;
    }
  }
}
