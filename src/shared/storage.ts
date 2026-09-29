import {
  CHAT_INDEX_KEY,
  CHAT_SESSION_PREFIX,
  DEFAULT_FEATURE_SETTINGS,
  DEFAULT_SEARCH_SETTINGS,
  LEGACY_STORAGE_KEY,
  META_KEY,
  MIGRATION_KEY,
  SCHEMA_VERSION,
  createEmptyConfig
} from './constants';
import { StorageQuotaError, isQuotaErrorText } from './errors';
import type {
  ChatIndexEntry,
  ChatSession,
  FeatureSettings,
  PersistedMessage,
  RootStore,
  SearchMeta,
  SearchSource,
  StorageConfig,
  ToolCallRecord,
  UsageMetrics
} from './types';
import { createUsageMetrics, nowIso } from './utils';

/**
 * Schema v5 storage.
 *
 * Instead of one monolithic `app_state_v4` value this layer keeps:
 *   - `app_meta_v5`   -> { schemaVersion, providers, prompts, featureSettings }
 *   - `chat_index_v5` -> ChatIndexEntry[] (a rebuildable cache)
 *   - `chat_<id>`     -> a full ChatSession
 *
 * Only the metadata is cloned on config edits, and a chat write touches a
 * single session key plus the index instead of cloning every conversation.
 */

export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024;
const MIGRATION_BATCH_SIZE = 20;

type StorageMode = 'v5' | 'v4';
type LegacyStore = Partial<RootStore> & { schemaVersion?: number };

export interface StorageUsage {
  bytes: number;
  quotaBytes: number;
  ratio: number;
}

export function chatSessionKey(chatId: string): string {
  return `${CHAT_SESSION_PREFIX}${chatId}`;
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function byteSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function buildIndexEntry(session: ChatSession): ChatIndexEntry {
  return {
    chatId: session.chatId,
    title: session.title,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    approxBytes: byteSize(session)
  };
}

function normalizeSearchSettings(input: unknown): FeatureSettings['search'] {
  const candidate = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const timeRange = candidate.timeRange;
  return {
    tavilyApiKey: typeof candidate.tavilyApiKey === 'string' ? candidate.tavilyApiKey : DEFAULT_SEARCH_SETTINGS.tavilyApiKey,
    enabledByDefault: false,
    searchDepth: candidate.searchDepth === 'advanced' ? 'advanced' : 'basic',
    timeRange: timeRange === 'day' || timeRange === 'week' || timeRange === 'month' || timeRange === 'year'
      ? timeRange
      : null,
    maxResults: typeof candidate.maxResults === 'number' && candidate.maxResults >= 1
      ? Math.floor(candidate.maxResults)
      : DEFAULT_SEARCH_SETTINGS.maxResults,
    maxRounds: typeof candidate.maxRounds === 'number' && candidate.maxRounds >= 1
      ? Math.min(2, Math.floor(candidate.maxRounds))
      : DEFAULT_SEARCH_SETTINGS.maxRounds
  };
}

function normalizeFeatureSettings(input: unknown): FeatureSettings {
  const candidate = input && typeof input === 'object' ? input as Partial<FeatureSettings> : {};
  return {
    defaultProviderId: typeof candidate.defaultProviderId === 'string' ? candidate.defaultProviderId : null,
    defaultPromptId: typeof candidate.defaultPromptId === 'string' ? candidate.defaultPromptId : null,
    defaultStreaming: false,
    search: normalizeSearchSettings(candidate.search)
  };
}

export function normalizeConfig(config: StorageConfig): { config: StorageConfig; changed: boolean } {
  let changed = false;
  const next = structuredClone(config) as StorageConfig;
  next.schemaVersion = SCHEMA_VERSION;

  if (!Array.isArray(next.providers)) {
    next.providers = [];
    changed = true;
  }
  if (!Array.isArray(next.prompts)) {
    next.prompts = [];
    changed = true;
  }

  const normalizedFeature = normalizeFeatureSettings(next.featureSettings);
  if (JSON.stringify(normalizedFeature) !== JSON.stringify(next.featureSettings)) {
    changed = true;
  }
  next.featureSettings = normalizedFeature;

  for (const provider of next.providers) {
    if (!provider.headers || typeof provider.headers !== 'object') {
      provider.headers = {};
      changed = true;
    }
    if (provider.authMode !== 'bearer' && provider.authMode !== 'custom' && provider.authMode !== 'none') {
      provider.authMode = 'bearer';
      changed = true;
    }
    if (!Array.isArray(provider.modelCatalog)) {
      provider.modelCatalog = [];
      changed = true;
    }
    for (const model of provider.modelCatalog) {
      if (typeof model.supportsStreaming !== 'boolean') {
        model.supportsStreaming = true;
        changed = true;
      }
      if (model.maxContextMessages === undefined) {
        model.maxContextMessages = null;
        changed = true;
      }
    }
  }

  return { config: next, changed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeUsage(value: unknown): UsageMetrics | null {
  return isRecord(value) ? createUsageMetrics(value as Partial<UsageMetrics>) : null;
}

function normalizeToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string') {
      return [];
    }
    const status = item.status === 'completed' || item.status === 'failed' || item.status === 'pending'
      ? item.status
      : 'failed';
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `tool-${index + 1}`,
      name: item.name,
      status,
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
      output: typeof item.output === 'string' ? item.output : null
    }];
  });
}

function normalizeSources(value: unknown): SearchSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') {
      return [];
    }
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `source-${index + 1}`,
      title: item.title,
      url: item.url,
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
      score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
      query: typeof item.query === 'string' ? item.query : '',
      credits: typeof item.credits === 'number' && Number.isFinite(item.credits) ? item.credits : null
    }];
  });
}

function normalizeSearchMeta(value: unknown): SearchMeta | null {
  if (!isRecord(value) || !Array.isArray(value.queries)) {
    return null;
  }
  const queries = value.queries.filter((query): query is string => typeof query === 'string');
  if (queries.length !== value.queries.length) {
    return null;
  }
  return {
    queries,
    credits: typeof value.credits === 'number' && Number.isFinite(value.credits) ? value.credits : null,
    sourceCount: typeof value.sourceCount === 'number' && Number.isFinite(value.sourceCount)
      ? Math.max(0, Math.floor(value.sourceCount))
      : 0,
    rounds: typeof value.rounds === 'number' && Number.isFinite(value.rounds)
      ? Math.max(0, Math.floor(value.rounds))
      : queries.length
  };
}

function normalizeMessage(value: unknown, index: number): PersistedMessage | null {
  if (!isRecord(value) || typeof value.content !== 'string') {
    return null;
  }
  const role = value.role === 'system' || value.role === 'user' || value.role === 'assistant'
    ? value.role
    : null;
  if (!role) {
    return null;
  }

  return {
    id: typeof value.id === 'string' && value.id ? value.id : `message-${index + 1}`,
    role,
    content: value.content,
    reasoningSummary: typeof value.reasoningSummary === 'string' ? value.reasoningSummary : null,
    toolCalls: normalizeToolCalls(value.toolCalls),
    sources: normalizeSources(value.sources),
    tokenUsage: normalizeUsage(value.tokenUsage),
    mode: value.mode === 'search' ? 'search' : 'chat',
    providerId: typeof value.providerId === 'string' ? value.providerId : null,
    modelId: typeof value.modelId === 'string' ? value.modelId : null,
    promptId: typeof value.promptId === 'string' ? value.promptId : null,
    searchMeta: normalizeSearchMeta(value.searchMeta),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : nowIso()
  };
}

export function normalizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const session = raw as Partial<ChatSession>;
  if (typeof session.chatId !== 'string' || !session.chatId) {
    return null;
  }
  const createdAt = typeof session.createdAt === 'string' ? session.createdAt : nowIso();
  const messages = Array.isArray(session.messages)
    ? session.messages
      .map((message, index) => normalizeMessage(message, index))
      .filter((message): message is PersistedMessage => message !== null)
    : [];
  return {
    chatId: session.chatId,
    title: typeof session.title === 'string' && session.title ? session.title : session.chatId,
    providerId: typeof session.providerId === 'string' ? session.providerId : null,
    promptId: typeof session.promptId === 'string' ? session.promptId : null,
    streamingOverride: typeof session.streamingOverride === 'boolean' ? session.streamingOverride : null,
    maxContextMessagesOverride: typeof session.maxContextMessagesOverride === 'number' && Number.isFinite(session.maxContextMessagesOverride)
      ? Math.max(1, Math.floor(session.maxContextMessagesOverride))
      : null,
    mode: session.mode === 'search' ? 'search' : 'chat',
    messages,
    totalUsage: normalizeUsage(session.totalUsage),
    createdAt,
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : createdAt
  };
}

async function write(items: Record<string, unknown>): Promise<void> {
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (isQuotaErrorText(error)) {
      throw new StorageQuotaError('Storage quota exceeded. Export a backup and remove older chats.');
    }
    throw error;
  }
}

/**
 * Serializes every mutation that touches more than a single key (a chat write
 * must also update the index). Reads stay lock-free.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationQueue.then(task, task);
  mutationQueue = run.then(() => undefined, () => undefined);
  return run;
}

/* ------------------------------------------------------------------ */
/* Initialization + migration                                          */
/* ------------------------------------------------------------------ */

async function readLegacyStore(): Promise<LegacyStore | null> {
  const result = await chrome.storage.local.get([LEGACY_STORAGE_KEY]);
  const store = result[LEGACY_STORAGE_KEY] as LegacyStore | undefined;
  return store && typeof store === 'object' ? store : null;
}

async function readMetaRaw(): Promise<StorageConfig | null> {
  const result = await chrome.storage.local.get([META_KEY]);
  const meta = result[META_KEY] as StorageConfig | undefined;
  if (!meta || typeof meta !== 'object' || meta.schemaVersion !== SCHEMA_VERSION) {
    return null;
  }
  return meta;
}

/**
 * Resolves the active storage mode. v5 wins once migration has completed; while
 * legacy v4 data exists (or migration fails) we operate explicitly on v4.
 */
async function initialize(): Promise<StorageMode> {
  const legacy = await readLegacyStore();
  if (legacy) {
    try {
      await migrateV4ToV5(legacy);
      return 'v5';
    } catch (error) {
      console.error('Schema v4 -> v5 migration failed; continuing on the v4 store.', error);
      return 'v4';
    }
  }

  if (!(await readMetaRaw())) {
    await write({ [META_KEY]: createEmptyConfig(), [CHAT_INDEX_KEY]: [] });
  }
  return 'v5';
}

async function migrateV4ToV5(legacy: LegacyStore): Promise<void> {
  await write({ [MIGRATION_KEY]: { status: 'migrating', startedAt: nowIso() } });

  const { config } = normalizeConfig({
    schemaVersion: SCHEMA_VERSION,
    providers: Array.isArray(legacy.providers) ? legacy.providers : [],
    prompts: Array.isArray(legacy.prompts) ? legacy.prompts : [],
    featureSettings: normalizeFeatureSettings(legacy.featureSettings)
  });

  const sessions = (Array.isArray(legacy.chatHistory) ? legacy.chatHistory : [])
    .map(normalizeSession)
    .filter((session): session is ChatSession => session !== null);
  const index = sessions.map(buildIndexEntry);

  await write({ [META_KEY]: config, [CHAT_INDEX_KEY]: index });

  for (let offset = 0; offset < sessions.length; offset += MIGRATION_BATCH_SIZE) {
    const batch: Record<string, unknown> = {};
    for (const session of sessions.slice(offset, offset + MIGRATION_BATCH_SIZE)) {
      batch[chatSessionKey(session.chatId)] = session;
    }
    await write(batch);
  }

  // Validate before deleting v4 so a partial migration never masquerades as done.
  const keys = sessions.map((session) => chatSessionKey(session.chatId));
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  for (const session of sessions) {
    const persisted = stored[chatSessionKey(session.chatId)] as ChatSession | undefined;
    if (!persisted || persisted.chatId !== session.chatId || !Array.isArray(persisted.messages)) {
      throw new Error(`Migration validation failed for chat ${session.chatId}.`);
    }
  }

  await write({ [MIGRATION_KEY]: { status: 'done', finishedAt: nowIso(), count: sessions.length } });
  await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
}

/* ------------------------------------------------------------------ */
/* v5 operations                                                       */
/* ------------------------------------------------------------------ */

async function readV5Config(): Promise<StorageConfig> {
  const meta = (await readMetaRaw()) ?? createEmptyConfig();
  const { config, changed } = normalizeConfig(meta);
  if (changed) {
    await write({ [META_KEY]: config });
  }
  return config;
}

function isValidIndex(value: unknown): value is ChatIndexEntry[] {
  return Array.isArray(value) && value.every(
    (entry) => entry && typeof entry === 'object' && typeof (entry as ChatIndexEntry).chatId === 'string'
  );
}

async function rebuildIndex(): Promise<ChatIndexEntry[]> {
  const all = await chrome.storage.local.get(null);
  const entries: ChatIndexEntry[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CHAT_SESSION_PREFIX) || key === CHAT_INDEX_KEY) {
      continue;
    }
    const session = normalizeSession(value);
    if (session) {
      entries.push(buildIndexEntry(session));
    }
  }
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await write({ [CHAT_INDEX_KEY]: entries });
  return entries;
}

async function readV5Index(): Promise<ChatIndexEntry[]> {
  const stored = await chrome.storage.local.get([CHAT_INDEX_KEY]);
  if (isValidIndex(stored[CHAT_INDEX_KEY])) {
    return structuredClone(stored[CHAT_INDEX_KEY]);
  }
  return enqueue(rebuildIndex);
}

async function syncIndexEntry(session: ChatSession, index?: ChatIndexEntry[]): Promise<ChatIndexEntry[]> {
  const next = index ?? await readV5Index();
  const entry = buildIndexEntry(session);
  const at = next.findIndex((item) => item.chatId === session.chatId);
  if (at >= 0) {
    next[at] = entry;
  } else {
    next.unshift(entry);
  }
  await write({ [CHAT_INDEX_KEY]: next });
  return next;
}

async function readV5Session(chatId: string): Promise<ChatSession | null> {
  const key = chatSessionKey(chatId);
  const stored = await chrome.storage.local.get([key]);
  return normalizeSession(stored[key]);
}

async function performUpsertSession(session: ChatSession): Promise<ChatSession> {
  const key = chatSessionKey(session.chatId);
  const existing = await readV5Session(session.chatId);

  if (existing && existing.updatedAt > session.updatedAt) {
    console.warn(`Rejected stale write for chat ${session.chatId}.`);
    await syncIndexEntry(existing);
    return existing;
  }

  await write({ [key]: session });
  await syncIndexEntry(session);
  return session;
}

async function performDeleteSession(chatId: string): Promise<void> {
  const index = (await readV5Index()).filter((entry) => entry.chatId !== chatId);
  await write({ [CHAT_INDEX_KEY]: index });
  await chrome.storage.local.remove(chatSessionKey(chatId));
}

async function performClearSessions(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(
    (key) => key.startsWith(CHAT_SESSION_PREFIX) && key !== CHAT_INDEX_KEY
  );
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
  await write({ [CHAT_INDEX_KEY]: [] });
}

async function performSaveAll(sessions: ChatSession[]): Promise<void> {
  const index = sessions.map(buildIndexEntry);
  const writes: Record<string, unknown> = {};
  for (const session of sessions) {
    writes[chatSessionKey(session.chatId)] = session;
  }

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter(
    (key) => key.startsWith(CHAT_SESSION_PREFIX) && key !== CHAT_INDEX_KEY && !(key in writes)
  );
  if (stale.length) {
    await chrome.storage.local.remove(stale);
  }
  if (Object.keys(writes).length) {
    await write(writes);
  }
  await write({ [CHAT_INDEX_KEY]: index });
}

/* ------------------------------------------------------------------ */
/* v4 fallback (explicitly selected when migration cannot complete)     */
/* ------------------------------------------------------------------ */

async function readV4Store(): Promise<RootStore> {
  const legacy = (await readLegacyStore()) ?? ({} as LegacyStore);
  const { config } = normalizeConfig({
    ...createEmptyConfig(),
    providers: Array.isArray(legacy.providers) ? legacy.providers : [],
    prompts: Array.isArray(legacy.prompts) ? legacy.prompts : [],
    featureSettings: normalizeFeatureSettings(legacy.featureSettings)
  });
  const chatHistory = (Array.isArray(legacy.chatHistory) ? legacy.chatHistory : [])
    .map(normalizeSession)
    .filter((session): session is ChatSession => session !== null);
  return { ...config, chatHistory };
}

async function writeV4Store(store: RootStore): Promise<void> {
  await write({ [LEGACY_STORAGE_KEY]: store });
}

/* ------------------------------------------------------------------ */
/* Public facade                                                       */
/* ------------------------------------------------------------------ */

export async function getConfig(): Promise<StorageConfig> {
  return (await initialize()) === 'v5' ? readV5Config() : (await readV4Store());
}

export async function saveConfig(config: StorageConfig): Promise<StorageConfig> {
  const { config: normalized } = normalizeConfig(config);
  if ((await initialize()) === 'v5') {
    await write({ [META_KEY]: normalized });
  } else {
    const legacy = await readV4Store();
    await writeV4Store({ ...legacy, ...normalized });
  }
  return normalized;
}

export async function getChatSession(chatId: string): Promise<ChatSession | null> {
  if ((await initialize()) === 'v5') {
    return readV5Session(chatId);
  }
  const store = await readV4Store();
  return store.chatHistory.find((session) => session.chatId === chatId) ?? null;
}

export async function upsertChatSession(session: ChatSession): Promise<ChatSession> {
  const normalized = normalizeSession(session);
  if (!normalized) {
    throw new Error('Cannot persist an invalid chat session.');
  }

  if ((await initialize()) === 'v5') {
    return enqueue(() => performUpsertSession(normalized));
  }

  return enqueue(async () => {
    const store = await readV4Store();
    const index = store.chatHistory.findIndex((item) => item.chatId === normalized.chatId);
    if (index >= 0) {
      store.chatHistory[index] = normalized;
    } else {
      store.chatHistory.unshift(normalized);
    }
    await writeV4Store(store);
    return normalized;
  });
}

export async function updateChatSession(
  chatId: string,
  updater: (session: ChatSession) => ChatSession | void
): Promise<ChatSession | null> {
  if ((await initialize()) === 'v5') {
    return enqueue(async () => {
      const existing = await readV5Session(chatId);
      if (!existing) {
        return null;
      }
      const next = normalizeSession(updater(existing) ?? existing);
      return next ? performUpsertSession(next) : null;
    });
  }

  return enqueue(async () => {
    const store = await readV4Store();
    const existing = store.chatHistory.find((item) => item.chatId === chatId);
    if (!existing) {
      return null;
    }
    const next = normalizeSession(updater(existing) ?? existing);
    if (!next) {
      return null;
    }
    const index = store.chatHistory.findIndex((item) => item.chatId === chatId);
    store.chatHistory[index] = next;
    await writeV4Store(store);
    return next;
  });
}

export async function deleteChatSession(chatId: string): Promise<void> {
  if ((await initialize()) === 'v5') {
    return enqueue(() => performDeleteSession(chatId));
  }
  return enqueue(async () => {
    const store = await readV4Store();
    store.chatHistory = store.chatHistory.filter((session) => session.chatId !== chatId);
    await writeV4Store(store);
  });
}

export async function clearChatSessions(): Promise<void> {
  if ((await initialize()) === 'v5') {
    return enqueue(performClearSessions);
  }
  return enqueue(async () => {
    const store = await readV4Store();
    store.chatHistory = [];
    await writeV4Store(store);
  });
}

export async function listChatSummaries(): Promise<ChatIndexEntry[]> {
  if ((await initialize()) === 'v5') {
    return readV5Index();
  }
  const store = await readV4Store();
  return store.chatHistory.map(buildIndexEntry);
}

export async function getAllChatSessions(): Promise<ChatSession[]> {
  if ((await initialize()) === 'v5') {
    const index = await readV5Index();
    if (index.length === 0) {
      return [];
    }
    const keys = index.map((entry) => chatSessionKey(entry.chatId));
    const stored = await chrome.storage.local.get(keys);
    const sessions: ChatSession[] = [];
    for (const entry of index) {
      const session = normalizeSession(stored[chatSessionKey(entry.chatId)]);
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }
  return (await readV4Store()).chatHistory;
}

export async function getStore(): Promise<RootStore> {
  if ((await initialize()) === 'v5') {
    const config = await readV5Config();
    return { ...config, chatHistory: await getAllChatSessions() };
  }
  return readV4Store();
}

/** Backwards-compatible alias used across the codebase. */
export async function ensureStore(): Promise<RootStore> {
  return getStore();
}

/** Full-store write; only used by tests and one-off migrations. */
export async function saveStore(store: RootStore): Promise<void> {
  if ((await initialize()) !== 'v5') {
    await enqueue(() => writeV4Store(store));
    return;
  }
  await saveConfig(store);
  await enqueue(() => performSaveAll(
    (store.chatHistory ?? [])
      .map(normalizeSession)
      .filter((session): session is ChatSession => session !== null)
  ));
}

/** Config-level update: clones only the small metadata object. */
export async function updateStore(
  updater: (config: StorageConfig) => StorageConfig | void
): Promise<StorageConfig> {
  const current = await getConfig();
  const draft = structuredClone(current);
  const updated = updater(draft) ?? draft;
  return saveConfig(updated);
}

export async function getStorageUsage(): Promise<StorageUsage> {
  let bytes = 0;
  try {
    const local = chrome.storage.local as typeof chrome.storage.local & {
      getBytesInUse?: (keys: string[] | null) => Promise<number>;
    };
    if (typeof local.getBytesInUse === 'function') {
      bytes = await local.getBytesInUse(null);
    }
  } catch {
    bytes = 0;
  }

  const quotaBytes =
    (chrome.storage.local as { QUOTA_BYTES?: number }).QUOTA_BYTES ?? DEFAULT_QUOTA_BYTES;
  return {
    bytes,
    quotaBytes,
    ratio: quotaBytes > 0 ? bytes / quotaBytes : 0
  };
}

export const STORAGE_HELPERS = {
  chatSessionKey,
  buildIndexEntry
};
