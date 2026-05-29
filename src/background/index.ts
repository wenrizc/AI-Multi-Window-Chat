import { streamProviderResponse, testProviderConnection } from '../providers/openai-compatible';
import { runSearchToolSession } from '../search/tool-session';
import { PORT_NAME } from '../shared/constants';
import { getStore, upsertChatSession } from '../shared/storage';
import type {
  ChatRequest,
  ChatRequestMessage,
  PersistedMessage,
  ProviderConfig,
  StreamEvent
} from '../shared/types';
import {
  compactText,
  getModel,
  i18nMessage,
  nowIso,
  uid
} from '../shared/utils';

const activeRequests = new Map<string, {
  controller: AbortController;
  port: chrome.runtime.Port;
}>();

function post(port: chrome.runtime.Port, event: StreamEvent) {
  try {
    port.postMessage(event);
  } catch (error) {
    console.warn('Failed to post port event', error);
  }
}

function createPersistedMessage(input: {
  role: PersistedMessage['role'];
  content: string;
  mode: PersistedMessage['mode'];
  providerId: string | null;
  modelId: string | null;
  promptId: string | null;
  reasoningSummary?: string | null;
  toolCalls?: PersistedMessage['toolCalls'];
  sources?: PersistedMessage['sources'];
  tokenUsage?: PersistedMessage['tokenUsage'];
  searchMeta?: PersistedMessage['searchMeta'];
}): PersistedMessage {
  return {
    id: uid('msg'),
    role: input.role,
    content: input.content,
    reasoningSummary: input.reasoningSummary ?? null,
    toolCalls: input.toolCalls ?? [],
    sources: input.sources ?? [],
    tokenUsage: input.tokenUsage ?? null,
    mode: input.mode,
    providerId: input.providerId,
    modelId: input.modelId,
    promptId: input.promptId,
    searchMeta: input.searchMeta ?? null,
    createdAt: nowIso()
  };
}

async function persistConversation(input: {
  request: ChatRequest;
  assistantContent: string;
  reasoningSummary: string | null;
  toolCalls: PersistedMessage['toolCalls'];
  sources: PersistedMessage['sources'];
  usage: PersistedMessage['tokenUsage'];
  searchMeta: PersistedMessage['searchMeta'];
}) {
  const store = await getStore();
  const existing = store.chatHistory.find((chat) => chat.chatId === input.request.chatId);
  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();

  const userMessages = [
    createPersistedMessage({
      role: 'user',
      content: input.request.userMessage,
      mode: input.request.mode,
      providerId: input.request.providerId,
      modelId: input.request.modelId,
      promptId: input.request.promptId
    })
  ];

  const assistantMessage = createPersistedMessage({
    role: 'assistant',
    content: input.assistantContent,
    mode: input.request.mode,
    providerId: input.request.providerId,
    modelId: input.request.modelId,
    promptId: input.request.promptId,
    reasoningSummary: input.reasoningSummary,
    toolCalls: input.toolCalls,
    sources: input.sources,
    tokenUsage: input.usage,
    searchMeta: input.searchMeta
  });

  const messages: PersistedMessage[] = existing
    ? [...existing.messages, ...userMessages, assistantMessage]
    : [...userMessages, assistantMessage];

  const totalUsage = messages.reduce<PersistedMessage['tokenUsage']>((acc, message) => {
    if (!message.tokenUsage) {
      return acc;
    }
    return {
      inputTokens: (acc?.inputTokens ?? 0) + (message.tokenUsage.inputTokens ?? 0),
      outputTokens: (acc?.outputTokens ?? 0) + (message.tokenUsage.outputTokens ?? 0),
      reasoningTokens: (acc?.reasoningTokens ?? 0) + (message.tokenUsage.reasoningTokens ?? 0),
      cacheReadTokens: (acc?.cacheReadTokens ?? 0) + (message.tokenUsage.cacheReadTokens ?? 0),
      totalTokens: (acc?.totalTokens ?? 0) + (message.tokenUsage.totalTokens ?? 0)
    };
  }, null);

  const session = {
    chatId: input.request.chatId,
    title: existing?.title || compactText(input.request.userMessage)?.slice(0, 60) || i18nMessage('common__newChat'),
    providerId: input.request.providerId,
    promptId: input.request.promptId,
    mode: input.request.mode,
    messages,
    totalUsage,
    createdAt,
    updatedAt
  };

  await upsertChatSession(session);
}

async function handleChatRequest(port: chrome.runtime.Port, request: ChatRequest) {
  const store = await getStore();
  const provider = store.providers.find((item) => item.id === request.providerId);
  if (!provider) {
    post(port, { type: 'failed', requestId: request.requestId, error: i18nMessage('chat__statusProviderNotFound') });
    return;
  }

  const model = getModel(provider, request.modelId);
  const controller = new AbortController();
  activeRequests.set(request.requestId, {
    controller,
    port
  });

  let content = '';
  let reasoningSummary = '';
  let sources: PersistedMessage['sources'] = [];
  let searchMeta: PersistedMessage['searchMeta'] = null;
  let usage: PersistedMessage['tokenUsage'] = null;
  let toolCalls: PersistedMessage['toolCalls'] = [];

  post(port, {
    type: 'started',
    requestId: request.requestId,
    mode: request.mode
  });

  try {
    let messages: ChatRequestMessage[] = request.messages;

    if (request.mode === 'search') {
      const searchResult = await runSearchToolSession({
        provider,
        modelId: request.modelId,
        messages,
        requestId: request.requestId,
        searchSettings: store.featureSettings.search,
        generationParams: request.generationParams,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'sourceUpdate') {
            sources = event.sources;
            searchMeta = event.searchMeta;
          }
          if (event.type === 'toolCallUpdate') {
            toolCalls = event.toolCalls;
          }
          post(port, event);
        }
      });
      content = searchResult.content;
      reasoningSummary = searchResult.reasoningSummary ?? '';
      toolCalls = searchResult.toolCalls;
      usage = searchResult.usage;
      sources = searchResult.sources;
      searchMeta = searchResult.searchMeta;
      if (reasoningSummary) {
        post(port, {
          type: 'reasoningDelta',
          requestId: request.requestId,
          delta: reasoningSummary
        });
      }
      if (content) {
        post(port, {
          type: 'contentDelta',
          requestId: request.requestId,
          delta: content
        });
      }
      if (usage) {
        post(port, {
          type: 'usageUpdate',
          requestId: request.requestId,
          usage
        });
      }
    } else {
      post(port, {
        type: 'statusUpdate',
        requestId: request.requestId,
        status: 'generating',
        message: i18nMessage('chat__statusGenerating')
      });

      await streamProviderResponse({
        provider,
        model,
        messages,
        requestId: request.requestId,
        signal: controller.signal,
        generationParams: request.generationParams,
        streamingEnabled: request.streamingEnabled,
        onEvent: (event) => {
          if (event.type === 'contentDelta') {
            content += event.delta;
          }
          if (event.type === 'reasoningDelta') {
            reasoningSummary += event.delta;
          }
          if (event.type === 'usageUpdate') {
            usage = event.usage;
            post(port, {
              type: 'usageUpdate',
              requestId: request.requestId,
              usage
            });
            return;
          }
          post(port, event);
        }
      });
    }

    const persistedReasoning = compactText(reasoningSummary);

    await persistConversation({
      request,
      assistantContent: content,
      reasoningSummary: persistedReasoning,
      toolCalls,
      sources,
      usage,
      searchMeta
    });

    post(port, {
      type: 'completed',
      requestId: request.requestId,
      response: {
        content,
        reasoningSummary: persistedReasoning,
        toolCalls,
        usage,
        sources,
        searchMeta
      }
    });
  } catch (error) {
    if (controller.signal.aborted) {
      post(port, {
        type: 'aborted',
        requestId: request.requestId
      });
    } else {
      const message = error instanceof Error ? error.message : i18nMessage('common__unknownError');
      post(port, {
        type: 'failed',
        requestId: request.requestId,
        error: message
      });
    }
  } finally {
    activeRequests.delete(request.requestId);
  }
}

function handlePortMessage(port: chrome.runtime.Port, rawMessage: unknown) {
  if (!rawMessage || typeof rawMessage !== 'object') {
    return;
  }
  const message = rawMessage as { type?: string; payload?: unknown; requestId?: string };
  if (message.type === 'start_chat' && message.payload) {
    handleChatRequest(port, message.payload as ChatRequest).catch((error) => {
      post(port, {
        type: 'failed',
        requestId: (message.payload as ChatRequest).requestId,
        error: error instanceof Error ? error.message : i18nMessage('common__unknownError')
      });
    });
    return;
  }

  if (message.type === 'abort_chat' && message.requestId) {
    const entry = activeRequests.get(message.requestId);
    entry?.controller.abort();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) {
    return;
  }

  port.onMessage.addListener((message) => handlePortMessage(port, message));
  port.onDisconnect.addListener(() => {
    for (const [requestId, entry] of activeRequests.entries()) {
      if (entry.port === port) {
        entry.controller.abort();
        activeRequests.delete(requestId);
      }
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'TEST_PROVIDER') {
    testProviderConnection(message.provider as ProviderConfig)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});
