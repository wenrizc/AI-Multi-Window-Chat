import type {
  AssistantToolCallMessage,
  ModelConfig,
  ProviderConfig,
  ProviderMessage,
  ProviderToolChoice,
  ProviderTurnResult,
  StreamEvent,
  StreamEventPayload,
  ToolCall,
  ToolDefinition,
  ToolResultMessage,
  UsageMetrics
} from '../shared/types';
import { mergeUsagePayload } from '../shared/parsers';
import { compactText, normalizeBaseUrl } from '../shared/utils';

interface StreamCallbacks {
  onEvent: (event: StreamEventPayload) => void;
  signal: AbortSignal;
  requestId: string;
}

function createHeaders(provider: ProviderConfig): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
    ...provider.headers
  };
}

function isAssistantToolCallMessage(message: ProviderMessage): message is AssistantToolCallMessage {
  return message.role === 'assistant' && 'toolCalls' in message;
}

function isToolResultMessage(message: ProviderMessage): message is ToolResultMessage {
  return message.role === 'tool';
}

function toChatMessages(messages: ProviderMessage[], includeReasoningContent: boolean) {
  return messages.map((message) => {
    if (isToolResultMessage(message)) {
      return {
        role: 'tool',
        content: message.content,
        tool_call_id: message.toolCallId,
        name: message.name
      };
    }

    if (isAssistantToolCallMessage(message)) {
      const chatMessage: Record<string, unknown> = {
        role: 'assistant',
        content: includeReasoningContent ? message.content : compactText(message.content),
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: toolCall.arguments
          }
        }))
      };
      if (includeReasoningContent && typeof message.reasoningContent === 'string') {
        chatMessage.reasoning_content = message.reasoningContent;
      }
      return chatMessage;
    }

    return {
      role: message.role,
      content: message.content
    };
  });
}

function toResponsesTextInput(messages: ProviderMessage[]) {
  return messages.flatMap((message) => {
    if (isToolResultMessage(message) || isAssistantToolCallMessage(message)) {
      return [];
    }

    return [{
      role: message.role,
      content: [
        {
          type: 'input_text',
          text: message.content
        }
      ]
    }];
  });
}

function toResponsesToolOutputs(toolOutputs: ToolResultMessage[]) {
  return toolOutputs.map((toolOutput) => ({
    type: 'function_call_output',
    call_id: toolOutput.toolCallId,
    output: toolOutput.content
  }));
}

function toChatTools(tools: ToolDefinition[] | undefined) {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function toResponsesTools(tools: ToolDefinition[] | undefined) {
  if (!tools?.length) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

async function* sseIterator(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const lines = chunk
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      let data = '';
      let event = '';
      for (const line of lines) {
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        }
        if (line.startsWith('data:')) {
          data += line.slice(5).trim();
        }
      }

      if (data) {
        yield { event, data };
      }
    }
  }
}

function emit(callbacks: StreamCallbacks, event: StreamEventPayload) {
  callbacks.onEvent(event);
}

function extractTextFromContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((item) => (item && typeof item === 'object' ? String((item as Record<string, unknown>).text ?? '') : ''))
    .join('');
}

function extractChatReasoning(value: Record<string, unknown>): string {
  return typeof value.reasoning_content === 'string' ? value.reasoning_content : '';
}

function normalizeToolArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return '{}';
  }
  return JSON.stringify(value);
}

function extractChatToolCalls(value: Record<string, unknown>): ToolCall[] {
  if (!Array.isArray(value.tool_calls)) {
    return [];
  }

  return value.tool_calls.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const entry = item as Record<string, unknown>;
    const fn =
      entry.function && typeof entry.function === 'object'
        ? entry.function as Record<string, unknown>
        : {};
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = typeof fn.name === 'string' ? fn.name : '';

    if (!id || !name) {
      return [];
    }

    return [{
      id,
      name,
      arguments: normalizeToolArguments(fn.arguments)
    }];
  });
}

function extractResponsesText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  if (!Array.isArray(payload.output)) {
    return '';
  }

  const fragments: string[] = [];
  for (const item of payload.output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (!Array.isArray(entry.content)) {
      continue;
    }
    for (const content of entry.content) {
      if (!content || typeof content !== 'object') {
        continue;
      }
      const block = content as Record<string, unknown>;
      if (block.type === 'output_text' || block.type === 'text') {
        fragments.push(String(block.text ?? ''));
      }
    }
  }
  return fragments.join('');
}

function extractResponsesReasoning(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.output)) {
    return '';
  }

  const fragments: string[] = [];
  for (const item of payload.output) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.type === 'reasoning' && Array.isArray(entry.summary)) {
      for (const summary of entry.summary) {
        if (!summary || typeof summary !== 'object') {
          continue;
        }
        fragments.push(String((summary as Record<string, unknown>).text ?? ''));
      }
    }
  }
  return fragments.join('');
}

function extractResponsesToolCalls(payload: Record<string, unknown>): ToolCall[] {
  if (!Array.isArray(payload.output)) {
    return [];
  }

  return payload.output.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'function_call') {
      return [];
    }

    const id =
      typeof entry.call_id === 'string'
        ? entry.call_id
        : typeof entry.id === 'string'
          ? entry.id
          : '';
    const name = typeof entry.name === 'string' ? entry.name : '';

    if (!id || !name) {
      return [];
    }

    return [{
      id,
      name,
      arguments: normalizeToolArguments(entry.arguments)
    }];
  });
}

const DSML_TOOL_CALLS_BLOCK_REGEX =
  /<[^>]*DSML[^>]*tool_calls[^>]*>[\s\S]*?<\/[^>]*DSML[^>]*tool_calls[^>]*>/g;
const DSML_INVOKE_REGEX =
  /<[^>]*DSML[^>]*invoke\b([^>]*)>([\s\S]*?)<\/[^>]*DSML[^>]*invoke[^>]*>/g;
const DSML_PARAMETER_REGEX =
  /<[^>]*DSML[^>]*parameter\b([^>]*)>([\s\S]*?)<\/[^>]*DSML[^>]*parameter[^>]*>/g;

function parseAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const regex = /([A-Za-z_][\w:-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    attributes[match[1]] = match[2];
  }

  return attributes;
}

function extractDsmlToolCalls(content: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const blocks = content.match(DSML_TOOL_CALLS_BLOCK_REGEX) ?? [];

  for (const block of blocks) {
    let invokeMatch: RegExpExecArray | null;
    DSML_INVOKE_REGEX.lastIndex = 0;

    while ((invokeMatch = DSML_INVOKE_REGEX.exec(block)) !== null) {
      const invokeAttributes = parseAttributes(invokeMatch[1]);
      const name = invokeAttributes.name?.trim();
      if (!name) {
        continue;
      }

      const args: Record<string, string> = {};
      DSML_PARAMETER_REGEX.lastIndex = 0;
      let parameterMatch: RegExpExecArray | null;
      while ((parameterMatch = DSML_PARAMETER_REGEX.exec(invokeMatch[2])) !== null) {
        const parameterAttributes = parseAttributes(parameterMatch[1]);
        const parameterName = parameterAttributes.name?.trim();
        if (parameterName) {
          args[parameterName] = parameterMatch[2].trim();
        }
      }

      toolCalls.push({
        id: `dsml_call_${toolCalls.length + 1}`,
        name,
        arguments: JSON.stringify(args)
      });
    }
  }

  return toolCalls;
}

function removeDsmlToolCallBlocks(content: string): string {
  return compactText(content.replace(DSML_TOOL_CALLS_BLOCK_REGEX, '')) ?? '';
}

function applyDsmlToolCallFallback(result: ProviderTurnResult): ProviderTurnResult {
  if (result.toolCalls.length > 0 || !result.content.includes('DSML')) {
    return result;
  }

  const toolCalls = extractDsmlToolCalls(result.content);
  if (toolCalls.length === 0) {
    return result;
  }

  return {
    ...result,
    content: removeDsmlToolCallBlocks(result.content),
    toolCalls
  };
}

function extractResponsesUsage(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (payload.usage && typeof payload.usage === 'object') {
    return payload.usage as Record<string, unknown>;
  }

  if (payload.response && typeof payload.response === 'object') {
    const response = payload.response as Record<string, unknown>;
    if (response.usage && typeof response.usage === 'object') {
      return response.usage as Record<string, unknown>;
    }
  }

  return undefined;
}

async function streamChatCompletions(
  provider: ProviderConfig,
  modelId: string,
  includeReasoningContent: boolean,
  messages: ProviderMessage[],
  generationParams: { temperature: number | null },
  callbacks: StreamCallbacks,
  tools?: ToolDefinition[],
  toolChoice?: ProviderToolChoice
) {
  const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: createHeaders(provider),
    signal: callbacks.signal,
    body: JSON.stringify({
      model: modelId,
      messages: toChatMessages(messages, includeReasoningContent),
      stream: true,
      stream_options: {
        include_usage: true
      },
      temperature: generationParams.temperature ?? undefined,
      tools: toChatTools(tools),
      tool_choice: tools?.length ? toolChoice ?? 'auto' : undefined
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Provider returned ${response.status}`);
  }

  let usage: UsageMetrics | null = null;

  for await (const entry of sseIterator(response.body)) {
    if (entry.data === '[DONE]') {
      break;
    }

    const payload = JSON.parse(entry.data) as Record<string, unknown>;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> : null;
    const delta = choice?.delta && typeof choice.delta === 'object' ? choice.delta as Record<string, unknown> : {};

    const textDelta = extractTextFromContent(delta.content);
    const reasoningDelta = extractChatReasoning(delta);

    if (textDelta) {
      emit(callbacks, { type: 'contentDelta', delta: textDelta });
    }
    if (reasoningDelta) {
      emit(callbacks, { type: 'reasoningDelta', delta: reasoningDelta });
    }

    const nextUsage = mergeUsagePayload(usage, payload.usage as Record<string, unknown> | undefined);
    if (nextUsage && nextUsage !== usage) {
      usage = nextUsage;
      emit(callbacks, { type: 'usageUpdate', usage });
    }
  }

  return usage;
}

async function completeChatCompletions(
  provider: ProviderConfig,
  modelId: string,
  includeReasoningContent: boolean,
  messages: ProviderMessage[],
  generationParams: { temperature: number | null },
  callbacks: StreamCallbacks,
  tools?: ToolDefinition[],
  toolChoice?: ProviderToolChoice
) {
  const result = await completeChatTurn({
    provider,
    modelId,
    includeReasoningContent,
    messages,
    generationParams,
    signal: callbacks.signal,
    tools,
    toolChoice
  });

  if (result.content) {
    emit(callbacks, { type: 'contentDelta', delta: result.content });
  }
  if (result.reasoningSummary) {
    emit(callbacks, { type: 'reasoningDelta', delta: result.reasoningSummary });
  }
  if (result.usage) {
    emit(callbacks, { type: 'usageUpdate', usage: result.usage });
  }

  return result.usage;
}

async function streamResponses(
  provider: ProviderConfig,
  modelId: string,
  messages: ProviderMessage[],
  generationParams: { temperature: number | null },
  callbacks: StreamCallbacks,
  tools?: ToolDefinition[],
  toolChoice?: ProviderToolChoice
) {
  const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/responses`, {
    method: 'POST',
    headers: createHeaders(provider),
    signal: callbacks.signal,
    body: JSON.stringify({
      model: modelId,
      input: toResponsesTextInput(messages),
      stream: true,
      temperature: generationParams.temperature ?? undefined,
      tools: toResponsesTools(tools),
      tool_choice: tools?.length ? toolChoice ?? 'auto' : undefined
    })
  });

  if (!response.ok || !response.body) {
    throw new Error(`Provider returned ${response.status}`);
  }

  let usage: UsageMetrics | null = null;

  for await (const entry of sseIterator(response.body)) {
    const payload = JSON.parse(entry.data) as Record<string, unknown>;
    const type = String(payload.type ?? entry.event ?? '');

    if (type === 'response.output_text.delta') {
      const delta = String(payload.delta ?? '');
      if (delta) {
        emit(callbacks, { type: 'contentDelta', delta });
      }
      continue;
    }

    if (type === 'response.reasoning_summary_text.delta') {
      const delta = String(payload.delta ?? '');
      if (delta) {
        emit(callbacks, { type: 'reasoningDelta', delta });
      }
      continue;
    }

    if (type === 'response.completed') {
      usage = mergeUsagePayload(usage, extractResponsesUsage(payload));
      if (usage) {
        emit(callbacks, { type: 'usageUpdate', usage });
      }
    }
  }

  return usage;
}

async function completeResponses(
  provider: ProviderConfig,
  modelId: string,
  messages: ProviderMessage[],
  generationParams: { temperature: number | null },
  callbacks: StreamCallbacks,
  tools?: ToolDefinition[],
  toolChoice?: ProviderToolChoice
) {
  const result = await completeResponsesTurn({
    provider,
    modelId,
    messages,
    generationParams,
    signal: callbacks.signal,
    tools,
    toolChoice
  });

  if (result.content) {
    emit(callbacks, { type: 'contentDelta', delta: result.content });
  }
  if (result.reasoningSummary) {
    emit(callbacks, { type: 'reasoningDelta', delta: result.reasoningSummary });
  }
  if (result.usage) {
    emit(callbacks, { type: 'usageUpdate', usage: result.usage });
  }

  return result.usage;
}

async function completeChatTurn(input: {
  provider: ProviderConfig;
  modelId: string;
  includeReasoningContent: boolean;
  messages: ProviderMessage[];
  generationParams: { temperature: number | null };
  signal: AbortSignal;
  tools?: ToolDefinition[];
  toolChoice?: ProviderToolChoice;
}): Promise<ProviderTurnResult> {
  const response = await fetch(`${normalizeBaseUrl(input.provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: createHeaders(input.provider),
    signal: input.signal,
    body: JSON.stringify({
      model: input.modelId,
      messages: toChatMessages(input.messages, input.includeReasoningContent),
      stream: false,
      temperature: input.generationParams.temperature ?? undefined,
      tools: toChatTools(input.tools),
      tool_choice: input.tools?.length ? input.toolChoice ?? 'auto' : undefined
    })
  });

  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  const choice = Array.isArray(payload.choices) ? payload.choices[0] as Record<string, unknown> : null;
  const message = choice?.message && typeof choice.message === 'object'
    ? choice.message as Record<string, unknown>
    : {};

  const reasoningContent = extractChatReasoning(message);

  return applyDsmlToolCallFallback({
    content: extractTextFromContent(message.content),
    reasoningSummary: compactText(reasoningContent),
    reasoningContent: reasoningContent || null,
    usage: mergeUsagePayload(null, payload.usage as Record<string, unknown> | undefined),
    toolCalls: extractChatToolCalls(message),
    responseId: null
  });
}

async function completeResponsesTurn(input: {
  provider: ProviderConfig;
  modelId: string;
  messages?: ProviderMessage[];
  generationParams: { temperature: number | null };
  signal: AbortSignal;
  tools?: ToolDefinition[];
  toolChoice?: ProviderToolChoice;
  previousResponseId?: string | null;
  toolOutputs?: ToolResultMessage[];
}): Promise<ProviderTurnResult> {
  const body: Record<string, unknown> = {
    model: input.modelId,
    stream: false,
    temperature: input.generationParams.temperature ?? undefined
  };

  if (input.previousResponseId) {
    body.previous_response_id = input.previousResponseId;
    body.input = toResponsesToolOutputs(input.toolOutputs ?? []);
  } else {
    body.input = toResponsesTextInput(input.messages ?? []);
  }

  if (input.tools?.length) {
    body.tools = toResponsesTools(input.tools);
    body.tool_choice = input.toolChoice ?? 'auto';
  }

  const response = await fetch(`${normalizeBaseUrl(input.provider.baseUrl)}/responses`, {
    method: 'POST',
    headers: createHeaders(input.provider),
    signal: input.signal,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Provider returned ${response.status}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return applyDsmlToolCallFallback({
    content: extractResponsesText(payload),
    reasoningSummary: compactText(extractResponsesReasoning(payload)),
    reasoningContent: null,
    usage: mergeUsagePayload(null, extractResponsesUsage(payload)),
    toolCalls: extractResponsesToolCalls(payload),
    responseId: typeof payload.id === 'string' ? payload.id : null
  });
}

export async function completeProviderTurn(input: {
  provider: ProviderConfig;
  model: ModelConfig;
  messages?: ProviderMessage[];
  generationParams: { temperature: number | null };
  signal: AbortSignal;
  tools?: ToolDefinition[];
  toolChoice?: ProviderToolChoice;
  previousResponseId?: string | null;
  toolOutputs?: ToolResultMessage[];
}): Promise<ProviderTurnResult> {
  if (input.provider.transport === 'responses') {
    return completeResponsesTurn({
      provider: input.provider,
      modelId: input.model.modelId,
      messages: input.messages,
      generationParams: input.generationParams,
      signal: input.signal,
      tools: input.tools,
      toolChoice: input.toolChoice,
      previousResponseId: input.previousResponseId,
      toolOutputs: input.toolOutputs
    });
  }

  return completeChatTurn({
    provider: input.provider,
    modelId: input.model.modelId,
    includeReasoningContent: input.model.reasoningFormat === 'reasoning_content',
    messages: input.messages ?? [],
    generationParams: input.generationParams,
    signal: input.signal,
    tools: input.tools,
    toolChoice: input.toolChoice
  });
}

export async function streamProviderResponse(input: {
  provider: ProviderConfig;
  model: ModelConfig;
  messages: ProviderMessage[];
  generationParams: { temperature: number | null };
  signal: AbortSignal;
  requestId: string;
  onEvent: (event: StreamEvent) => void;
  tools?: ToolDefinition[];
  toolChoice?: ProviderToolChoice;
  streamingEnabled?: boolean;
}) {
  const callbacks: StreamCallbacks = {
    signal: input.signal,
    requestId: input.requestId,
    onEvent: (event) => input.onEvent({ ...event, requestId: input.requestId })
  };

  const shouldStream = input.streamingEnabled !== false;

  if (input.provider.transport === 'responses') {
    if (shouldStream) {
      return streamResponses(
        input.provider,
        input.model.modelId,
        input.messages,
        input.generationParams,
        callbacks,
        input.tools,
        input.toolChoice
      );
    }
    return completeResponses(
      input.provider,
      input.model.modelId,
      input.messages,
      input.generationParams,
      callbacks,
      input.tools,
      input.toolChoice
    );
  }

  if (shouldStream) {
    return streamChatCompletions(
      input.provider,
      input.model.modelId,
      input.model.reasoningFormat === 'reasoning_content',
      input.messages,
      input.generationParams,
      callbacks,
      input.tools,
      input.toolChoice
    );
  }

  return completeChatCompletions(
    input.provider,
    input.model.modelId,
    input.model.reasoningFormat === 'reasoning_content',
    input.messages,
    input.generationParams,
    callbacks,
    input.tools,
    input.toolChoice
  );
}

export async function testProviderConnection(provider: ProviderConfig): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(provider.baseUrl)}/models`, {
    method: 'GET',
    headers: createHeaders(provider)
  });

  if (!response.ok) {
    const text = compactText(await response.text()) || response.statusText;
    throw new Error(text);
  }
}
