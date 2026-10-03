import { streamProviderResponse, testProviderConnection } from '../providers/openai-compatible';
import { runSearchToolSession } from '../search/tool-session';
import { PORT_NAME } from '../shared/constants';
import { getChatSession, getConfig, updateChatSession, upsertChatSession } from '../shared/storage';
import { resolveActivePath } from '../shared/conversation-tree';
import { classifyError, type FailureCode } from '../shared/errors';
import type {
  ChatRequest,
  ChatRequestMessage,
  PersistedMessage,
  ProviderConfig,
  StreamEvent,
  UsageMetrics
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

/** Token totals summed over the messages actually visible in the active branch. */
function sumActiveUsage(messages: PersistedMessage[], activeLeafId: string | null): UsageMetrics | null {
  return resolveActivePath(messages, activeLeafId).reduce<UsageMetrics | null>((acc, message) => {
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
}

function createPersistedMessage(input: {
  id?: string;
  parentId?: string | null;
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
    id: input.id ?? uid('msg'),
    role: input.role,
    content: input.content,
    parentId: input.parentId ?? null,
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
  const existing = await getChatSession(input.request.chatId);
  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const previousMessages = existing?.messages ?? [];

  const appendUserMessage = input.request.appendUserMessage !== false;
  const userMessageId = input.request.userMessageId ?? uid('msg');
  const assistantMessageId = input.request.assistantMessageId ?? uid('msg');
  // New senders always pass a parent (possibly null for a root). Legacy senders
  // omit it, so attach to the current active leaf to keep the chain connected.
  const parentMessageId = input.request.parentMessageId !== undefined
    ? input.request.parentMessageId
    : (existing?.activeLeafId ?? null);

  const lastMessage = previousMessages[previousMessages.length - 1];
  const existingUserById = previousMessages.find((message) => message.id === userMessageId);

  // A retry (or an edit that reuses the same id) already persisted this user
  // message; legacy senders without ids still dedupe on identical trailing text.
  let effectiveUserId = userMessageId;
  let userMessages: PersistedMessage[] = [];
  if (!appendUserMessage) {
    // Regenerating an assistant message: no new user turn.
    effectiveUserId = parentMessageId ?? userMessageId;
  } else if (existingUserById) {
    effectiveUserId = existingUserById.id;
  } else if (
    !input.request.userMessageId &&
    lastMessage?.role === 'user' &&
    lastMessage.content === input.request.userMessage
  ) {
    effectiveUserId = lastMessage.id;
  } else {
    userMessages = [createPersistedMessage({
      id: userMessageId,
      parentId: parentMessageId,
      role: 'user',
      content: input.request.userMessage,
      mode: input.request.mode,
      providerId: input.request.providerId,
      modelId: input.request.modelId,
      promptId: input.request.promptId
    })];
  }

  const assistantMessage = createPersistedMessage({
    id: assistantMessageId,
    parentId: effectiveUserId,
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

  const messages: PersistedMessage[] = [...previousMessages, ...userMessages, assistantMessage];
  const activeLeafId = assistantMessage.id;

  const session = {
    chatId: input.request.chatId,
    title: existing?.title || input.request.windowTitle || compactText(input.request.userMessage)?.slice(0, 60) || i18nMessage('common__newChat'),
    providerId: input.request.providerId,
    promptId: input.request.promptId,
    streamingOverride: input.request.streamingOverride,
    mode: input.request.mode,
    messages,
    activeLeafId,
    branchOf: existing?.branchOf ?? null,
    totalUsage: sumActiveUsage(messages, activeLeafId),
    createdAt,
    updatedAt
  };

  await upsertChatSession(session);
}

async function persistUserMessage(request: ChatRequest) {
  // A failed regeneration has no new user turn to save; the active leaf is kept.
  if (request.appendUserMessage === false) {
    return;
  }

  const existing = await getChatSession(request.chatId);
  const userMessageId = request.userMessageId ?? uid('msg');
  const lastMessage = existing?.messages[existing.messages.length - 1];
  const alreadyPersisted = existing?.messages.some((message) => message.id === userMessageId)
    || (!request.userMessageId
      && lastMessage?.role === 'user'
      && lastMessage.content === request.userMessage);
  if (alreadyPersisted) {
    return;
  }

  const createdAt = existing?.createdAt ?? nowIso();
  const updatedAt = nowIso();
  const userMessage = createPersistedMessage({
    id: userMessageId,
    parentId: request.parentMessageId !== undefined
      ? request.parentMessageId
      : (existing?.activeLeafId ?? null),
    role: 'user',
    content: request.userMessage,
    mode: request.mode,
    providerId: request.providerId,
    modelId: request.modelId,
    promptId: request.promptId
  });

  const messages = existing ? [...existing.messages, userMessage] : [userMessage];
  await upsertChatSession({
    chatId: request.chatId,
    title: existing?.title || request.windowTitle || compactText(request.userMessage)?.slice(0, 60) || i18nMessage('common__newChat'),
    providerId: request.providerId,
    promptId: request.promptId,
    streamingOverride: request.streamingOverride,
    mode: request.mode,
    messages,
    activeLeafId: userMessage.id,
    branchOf: existing?.branchOf ?? null,
    totalUsage: existing?.totalUsage ?? null,
    createdAt,
    updatedAt
  });
}

async function renameConversation(chatId: string, title: string) {
  const nextTitle = compactText(title);
  if (!nextTitle) {
    return;
  }

  await updateChatSession(chatId, (session) => {
    session.title = nextTitle;
    session.updatedAt = nowIso();
    return session;
  });
}

function postFailure(
  port: chrome.runtime.Port,
  requestId: string,
  failure: { code: FailureCode; error: string; retryable: boolean; status?: number | null }
) {
  post(port, {
    type: 'failed',
    requestId,
    error: failure.error,
    code: failure.code,
    retryable: failure.retryable,
    status: failure.status ?? null
  });
}

async function handleChatRequest(port: chrome.runtime.Port, request: ChatRequest) {
  const config = await getConfig();
  const provider = config.providers.find((item) => item.id === request.providerId);
  if (!provider) {
    postFailure(port, request.requestId, {
      code: 'provider_not_found',
      error: i18nMessage('chat__statusProviderNotFound'),
      retryable: false
    });
    return;
  }

  const model = getModel(provider, request.modelId);
  if (!model) {
    postFailure(port, request.requestId, {
      code: 'model_unavailable',
      error: i18nMessage('chat__errorModelUnavailable'),
      retryable: false
    });
    return;
  }

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
    if (request.attachments?.length && request.mode === 'chat') {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        last.content = [
          { type: 'text', text: typeof last.content === 'string' ? last.content : request.userMessage },
          ...request.attachments
            .filter((attachment) => attachment.status === 'ready' && attachment.mimeType.startsWith('image/'))
            .map((attachment) => ({ type: 'image_url' as const, image_url: { url: attachment.dataUrl } }))
        ];
      }
    }

    if (request.mode === 'search') {
      const searchResult = await runSearchToolSession({
        provider,
        modelId: request.modelId,
        messages,
        requestId: request.requestId,
        searchSettings: config.featureSettings.search,
        generationParams: { ...request.generationParams, reasoningEffort: request.reasoningEffort },
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
        generationParams: { ...request.generationParams, reasoningEffort: request.reasoningEffort },
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
    await persistUserMessage(request).catch((persistError) => {
      console.warn('Failed to persist user message', persistError);
    });
    if (controller.signal.aborted) {
      post(port, {
        type: 'aborted',
        requestId: request.requestId
      });
    } else {
      const failure = classifyError(error);
      postFailure(port, request.requestId, failure);
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
      postFailure(port, (message.payload as ChatRequest).requestId, classifyError(error));
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TEST_PROVIDER') {
    testProviderConnection(message.provider as ProviderConfig)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === 'RENAME_CHAT' && typeof message.chatId === 'string' && typeof message.title === 'string') {
    renameConversation(message.chatId, message.title)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === 'SET_ACTIVE_LEAF' && typeof message.chatId === 'string' && typeof message.leafId === 'string') {
    updateChatSession(message.chatId, (session) => {
      session.activeLeafId = message.leafId;
      return session;
    })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === 'BRANCH_CHAT_WINDOW' && message.chat && typeof message.chat.chatId === 'string') {
    // Forward a branched session to the content script of the tab that owns the
    // iframe so it can open an in-page window, reusing OPEN_CHAT_WINDOW.
    const tabId = sender?.tab?.id;
    if (typeof tabId === 'number') {
      chrome.tabs.sendMessage(tabId, { type: 'OPEN_CHAT_WINDOW', chat: message.chat })
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    sendResponse({ success: false, error: 'No tab is associated with the branch request.' });
    return false;
  }
  return false;
});
