import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_INDEX_KEY,
  LEGACY_STORAGE_KEY,
  META_KEY,
  MIGRATION_KEY,
  createEmptyConfig,
  createEmptyStore
} from '../../src/shared/constants';
import { StorageQuotaError } from '../../src/shared/errors';
import {
  chatSessionKey,
  clearChatSessions,
  deleteChatSession,
  ensureStore,
  getAllChatSessions,
  getChatSession,
  getChatPromptSelection,
  getConfig,
  getStorageUsage,
  getStore,
  listChatSummaries,
  normalizeSession,
  saveConfig,
  saveChatPromptSelection,
  saveStore,
  updateChatSession,
  updateStore,
  upsertChatSession
} from '../../src/shared/storage';
import type { ChatIndexEntry, ChatSession, RootStore, StorageConfig } from '../../src/shared/types';
import { getChromeState } from '../helpers/chrome-mock';
import { createChatSession, createModel, createPersistedMessage, createProvider } from '../helpers/factories';

type State = ReturnType<typeof getChromeState>;

describe('prompt selection and snapshots', () => {
  it('keeps the latest selection in history and export after an older request finishes', async () => {
    const session = createChatSession({ promptId: 'pa' });
    await upsertChatSession(session);
    await saveChatPromptSelection(session.chatId, 'pb');
    await upsertChatSession({ ...session, updatedAt: '2026-10-11T00:00:00Z' });
    expect((await getChatSession(session.chatId))?.promptId).toBe('pb');
    expect((await getStore()).chatHistory[0].promptId).toBe('pb');
    await saveChatPromptSelection(session.chatId, null);
    expect((await getAllChatSessions())[0].promptId).toBeNull();
  });
  it('preserves the distinction between unset and no prompt and cleans up saved selections', async () => {
    expect(await getChatPromptSelection('empty')).toBeUndefined();
    await saveChatPromptSelection('empty', null);
    expect(await getChatPromptSelection('empty')).toBeNull();
    await saveChatPromptSelection('other', 'pb');
    await deleteChatSession('empty');
    expect(await getChatPromptSelection('empty')).toBeUndefined();
    expect(await getChatPromptSelection('other')).toBe('pb');
    await clearChatSessions();
    expect(await getChatPromptSelection('other')).toBeUndefined();
  });
  it('retains prompt content snapshots through save and read, including explicit no prompt', async () => {
    const snapshot = { id: 'pa', name: 'A', content: 'Original instruction' };
    await upsertChatSession(createChatSession({ messages: [
      createPersistedMessage({ id: 'one', promptId: 'pa', promptSnapshot: snapshot }),
      createPersistedMessage({ id: 'two', promptId: null, promptSnapshot: null }),
      createPersistedMessage({ id: 'legacy' })
    ] }));
    const session = await getChatSession('chat-test');
    expect(session?.messages[0].promptSnapshot).toEqual(snapshot);
    expect(session?.messages[1].promptSnapshot).toBeNull();
    expect(session?.messages[2].promptSnapshot).toBeUndefined();
  });
  it('retains the saved selection if deleting the session fails', async () => {
    const session = createChatSession({ promptId: 'pa' });
    await upsertChatSession(session);
    await saveChatPromptSelection(session.chatId, 'pb');
    getChromeState().failNextSetForKey(CHAT_INDEX_KEY);
    await expect(deleteChatSession(session.chatId)).rejects.toThrow();
    expect((await getChatSession(session.chatId))?.promptId).toBe('pb');
  });
  it('replaces old prompt selections when the full store is replaced', async () => {
    await upsertChatSession(createChatSession({ chatId: 'kept', promptId: 'pa' }));
    await saveChatPromptSelection('kept', 'pb');
    await saveChatPromptSelection('removed', 'pb');
    await saveStore({ ...createEmptyStore(), chatHistory: [createChatSession({ chatId: 'kept', promptId: null })] });
    expect((await getChatSession('kept'))?.promptId).toBeNull();
    expect(await getChatPromptSelection('removed')).toBeUndefined();
  });
  it('keeps sessions and selections when clearing the index fails', async () => {
    const session = createChatSession({ promptId: 'pa' });
    await upsertChatSession(session);
    await saveChatPromptSelection(session.chatId, null);
    getChromeState().failNextSetForKey(CHAT_INDEX_KEY);
    await expect(clearChatSessions()).rejects.toThrow();
    expect((await getChatSession(session.chatId))?.promptId).toBeNull();
    expect((await getAllChatSessions())).toHaveLength(1);
  });
});

function readMeta(state: State): StorageConfig {
  return state.storage[META_KEY] as StorageConfig;
}

function readIndex(state: State): ChatIndexEntry[] {
  return state.storage[CHAT_INDEX_KEY] as ChatIndexEntry[];
}

function readChat(state: State, chatId: string): ChatSession | undefined {
  return state.storage[chatSessionKey(chatId)] as ChatSession | undefined;
}

describe('createEmptyStore', () => {
  it('migrates global thinking levels only to the default model', async () => {
    const state = getChromeState();
    const config = createEmptyConfig();
    config.providers = [createProvider({ id: 'p1' }), createProvider({ id: 'p2' })];
    config.featureSettings.defaultProviderId = 'p1';
    state.seedStorage({ [META_KEY]: config, customReasoningEfforts: ['xhigh', 'xhigh', 'high'] });
    const saved = await getConfig();
    expect(saved.providers[0].modelCatalog[0].customReasoningEfforts).toEqual(['xhigh']);
    expect(saved.providers[1].modelCatalog[0].customReasoningEfforts).toBeUndefined();
    expect(state.storage.customReasoningEfforts).toBeUndefined();
  });

  it('preserves explicitly saved model levels during global migration', async () => {
    const state = getChromeState();
    const config = createEmptyConfig();
    config.providers = [createProvider({ id: 'p1' })];
    config.providers[0].modelCatalog[0].customReasoningEfforts = [];
    config.featureSettings.defaultProviderId = 'p1';
    state.seedStorage({ [META_KEY]: config, customReasoningEfforts: ['xhigh'] });
    expect((await getConfig()).providers[0].modelCatalog[0].customReasoningEfforts).toEqual([]);
    expect(state.storage.customReasoningEfforts).toBeUndefined();
  });
  it('ships the v5 fixed defaults (streaming/search disabled)', () => {
    const store = createEmptyStore();
    expect(store.schemaVersion).toBe(5);
    expect(store.providers).toEqual([]);
    expect(store.prompts).toEqual([]);
    expect(store.chatHistory).toEqual([]);
    expect(store.featureSettings.defaultStreaming).toBe(false);
    expect(store.featureSettings.search.enabledByDefault).toBe(false);
  });
});

describe('session normalization', () => {
  it('drops malformed messages and supplies safe defaults for nested fields', () => {
    const session = normalizeSession({
      chatId: 'chat-1',
      messages: [
        { role: 'assistant', content: 'valid', toolCalls: [{ name: 'search', status: 'pending' }] },
        { role: 'assistant', content: 42 },
        { role: 'unknown', content: 'invalid role' }
      ],
      totalUsage: { inputTokens: '12' }
    });

    expect(session?.messages).toHaveLength(1);
    expect(session?.messages[0].content).toBe('valid');
    expect(session?.messages[0].toolCalls[0]).toMatchObject({
      name: 'search',
      status: 'pending',
      arguments: '',
      output: null
    });
    expect(session?.totalUsage?.inputTokens).toBe(12);
    expect(session?.totalUsage?.outputTokens).toBeNull();
  });

  it('preserves explicit tree data', () => {
    const session = normalizeSession({
      chatId: 'chat-1',
      activeLeafId: 'm2',
      branchOf: { chatId: 'origin', messageId: 'root' },
      messages: [
        { id: 'm1', role: 'user', content: 'hi', parentId: null },
        { id: 'm2', role: 'assistant', content: 'hello', parentId: 'm1' }
      ]
    });

    expect(session?.activeLeafId).toBe('m2');
    expect(session?.branchOf).toEqual({ chatId: 'origin', messageId: 'root' });
    expect(session?.messages[1].parentId).toBe('m1');
  });

  it('back-fills a linear parent chain for legacy sessions', () => {
    const session = normalizeSession({
      chatId: 'legacy',
      messages: [
        { id: 'm1', role: 'user', content: 'hi' },
        { id: 'm2', role: 'assistant', content: 'hello' }
      ]
    });

    expect(session?.messages[0].parentId).toBeNull();
    expect(session?.messages[1].parentId).toBe('m1');
    expect(session?.activeLeafId).toBe('m2');
  });

  it('drops malformed branch origins', () => {
    const session = normalizeSession({
      chatId: 'chat-1',
      branchOf: { messageId: 'only-message' },
      messages: []
    });
    expect(session?.branchOf).toBeNull();
  });
});

describe('initialization', () => {
  it('creates metadata and an empty index when nothing is stored', async () => {
    const state = getChromeState();
    const store = await ensureStore();

    expect(store).toEqual(createEmptyStore());
    expect(readMeta(state)).toEqual(createEmptyConfig());
    expect(readIndex(state)).toEqual([]);
  });

  it('reads back the persisted config when the schema matches', async () => {
    const state = getChromeState();
    const seeded = createEmptyConfig();
    seeded.providers.push(createProvider());
    state.seedStorage({ [META_KEY]: seeded, [CHAT_INDEX_KEY]: [] });

    const store = await getStore();
    expect(store.providers).toEqual(seeded.providers);
    expect(store.chatHistory).toEqual([]);
  });

  it('migrates a v4 store into config + per-chat keys and removes the legacy value', async () => {
    const state = getChromeState();
    const legacy = createEmptyStore();
    legacy.providers.push(createProvider({ id: 'p1' }));
    legacy.chatHistory.push(createChatSession({ chatId: 'c1', title: 'Chat 1' }));
    legacy.chatHistory.push(createChatSession({ chatId: 'c2', title: 'Chat 2' }));
    state.seedStorage({ [LEGACY_STORAGE_KEY]: legacy });

    const store = await ensureStore();

    expect(store.providers).toHaveLength(1);
    expect(state.storage[LEGACY_STORAGE_KEY]).toBeUndefined();
    expect(readChat(state, 'c1')?.title).toBe('Chat 1');
    expect(readChat(state, 'c2')?.title).toBe('Chat 2');

    const index = readIndex(state);
    expect(index.map((entry) => entry.chatId).sort()).toEqual(['c1', 'c2']);
    expect((state.storage[MIGRATION_KEY] as { status: string }).status).toBe('done');
  });

  it('serializes concurrent initialization so migration runs once', async () => {
    const state = getChromeState();
    const legacy = createEmptyStore();
    legacy.providers.push(createProvider({ id: 'p1' }));
    legacy.chatHistory.push(createChatSession({ chatId: 'c1', title: 'Chat 1' }));
    state.seedStorage({ [LEGACY_STORAGE_KEY]: legacy });

    const [first, second] = await Promise.all([ensureStore(), ensureStore()]);

    expect(first.providers).toHaveLength(1);
    expect(second.providers).toHaveLength(1);
    expect(state.storage[LEGACY_STORAGE_KEY]).toBeUndefined();
    expect(readIndex(state).map((entry) => entry.chatId)).toEqual(['c1']);
  });

  it('repairs fixed defaults and normalizes missing model/chat fields during migration', async () => {
    const state = getChromeState();
    const legacy = {
      schemaVersion: 4,
      providers: [
        {
          id: 'p1',
          name: 'P1',
          baseUrl: 'https://p.test/v1',
          apiKey: 'k',
          transport: 'chat_completions',
          defaultModel: 'm1',
          defaultGenerationParams: { temperature: null },
          headers: {},
          modelCatalog: [{ modelId: 'm1', displayName: 'M1', reasoningFormat: 'none' }],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      prompts: [],
      featureSettings: {
        defaultProviderId: 'p1',
        defaultPromptId: null,
        defaultStreaming: true,
        search: {
          tavilyApiKey: '',
          enabledByDefault: true,
          searchDepth: 'basic',
          timeRange: null,
          maxResults: 5,
          maxRounds: 1
        }
      },
      chatHistory: [
        {
          chatId: 'c1',
          title: 'C1',
          providerId: 'p1',
          promptId: null,
          mode: 'chat',
          messages: [],
          totalUsage: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    } as unknown as RootStore;

    state.seedStorage({ [LEGACY_STORAGE_KEY]: legacy });
    const store = await ensureStore();

    expect(store.featureSettings.defaultStreaming).toBe(false);
    expect(store.featureSettings.search.enabledByDefault).toBe(false);
    expect(store.providers[0].authMode).toBe('bearer');
    expect(store.providers[0].modelCatalog[0].supportsStreaming).toBe(true);
    expect(store.chatHistory[0].streamingOverride).toBeNull();

    // The repaired values must be written back, not only returned.
    expect(readMeta(state).featureSettings.defaultStreaming).toBe(false);
    expect(readChat(state, 'c1')?.streamingOverride).toBeNull();
  });

  it('coerces a non-array modelCatalog to an empty array', async () => {
    const state = getChromeState();
    const config = createEmptyConfig();
    config.providers.push(createProvider());
    (config.providers[0] as unknown as { modelCatalog: unknown }).modelCatalog = 'nope';
    state.seedStorage({ [META_KEY]: config, [CHAT_INDEX_KEY]: [] });

    const repaired = await ensureStore();
    expect(repaired.providers[0].modelCatalog).toEqual([]);
  });

  it('does not rewrite storage when nothing changed', async () => {
    const state = getChromeState();
    const config = createEmptyConfig();
    config.providers.push(createProvider({ modelCatalog: [createModel()] }));
    state.seedStorage({ [META_KEY]: config, [CHAT_INDEX_KEY]: [] });
    const before = JSON.stringify(state.storage[META_KEY]);

    await ensureStore();

    expect(JSON.stringify(state.storage[META_KEY])).toBe(before);
  });

  it('rebuilds the index from chat keys when the cache is missing', async () => {
    const state = getChromeState();
    state.seedStorage({
      [META_KEY]: createEmptyConfig(),
      [chatSessionKey('c1')]: createChatSession({ chatId: 'c1', title: 'Rebuilt' })
    });

    const summaries = await listChatSummaries();

    expect(summaries.map((entry) => entry.chatId)).toEqual(['c1']);
    expect(readIndex(state).map((entry) => entry.chatId)).toEqual(['c1']);
  });

  it('keeps legacy data and falls back to v4 when migration fails', async () => {
    const state = getChromeState();
    const legacy = createEmptyStore();
    legacy.chatHistory.push(createChatSession({ chatId: 'c1', title: 'Legacy chat' }));
    state.seedStorage({ [LEGACY_STORAGE_KEY]: legacy });
    state.failNextSetForKey(chatSessionKey('c1'));

    const store = await ensureStore();

    // The legacy blob must survive a partial migration.
    expect(state.storage[LEGACY_STORAGE_KEY]).toBeTruthy();
    expect(readChat(state, 'c1')).toBeUndefined();
    expect(store.chatHistory.map((session) => session.chatId)).toEqual(['c1']);
    expect(store.chatHistory[0].title).toBe('Legacy chat');
  });
});

describe('configuration writes', () => {
  it('saveConfig only touches metadata and leaves chat records intact', async () => {
    const state = getChromeState();
    await upsertChatSession(createChatSession({ chatId: 'c1' }));
    const chatBefore = JSON.stringify(readChat(state, 'c1'));

    const config = await getConfig();
    config.featureSettings.defaultProviderId = 'p1';
    await saveConfig(config);

    expect(readMeta(state).featureSettings.defaultProviderId).toBe('p1');
    expect(JSON.stringify(readChat(state, 'c1'))).toBe(chatBefore);
  });

  it('updateStore applies an updater against a clone', async () => {
    await ensureStore();

    const updated = await updateStore((config) => {
      config.prompts.push({
        id: 'prompt-1',
        name: 'P',
        content: 'c',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
    });

    expect(updated.prompts).toHaveLength(1);
    expect((await getConfig()).prompts).toHaveLength(1);
  });
});

describe('chat sessions', () => {
  it('retains image attachments across writes and reads and repairs missing attachment IDs', async () => {
    const attachments = [
      { id: 'image-1', name: 'one.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==', status: 'ready' as const },
      { name: 'two.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,Yg==' },
      { name: 'three.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,Yw==' },
      { name: 'invalid.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,YQ==' },
      { name: 'empty.png', mimeType: 'image/png', dataUrl: '' }
    ];
    const session = createChatSession({ messages: [createPersistedMessage({
      role: 'user', attachments: attachments as NonNullable<ChatSession['messages'][number]['attachments']>
    })] });
    await upsertChatSession(session);
    const restored = await getChatSession(session.chatId);
    expect(restored?.messages[0].attachments).toHaveLength(3);
    expect(restored?.messages[0].attachments?.[0]).toEqual(attachments[0]);
    expect(new Set(restored?.messages[0].attachments?.map(item => item.id)).size).toBe(3);
  });

  it('unshifts new sessions, replaces existing ones and keeps the index in sync', async () => {
    const state = getChromeState();
    await ensureStore();

    await upsertChatSession(createChatSession({ chatId: 'a', title: 'A' }));
    await upsertChatSession(createChatSession({ chatId: 'b', title: 'B' }));
    await upsertChatSession(createChatSession({ chatId: 'a', title: 'A2' }));

    expect(readIndex(state).map((entry) => entry.chatId)).toEqual(['b', 'a']);
    expect(readChat(state, 'a')?.title).toBe('A2');
  });

  it('rejects a stale write that would overwrite a newer session', async () => {
    const state = getChromeState();
    await ensureStore();
    await upsertChatSession(createChatSession({
      chatId: 'a',
      title: 'New',
      updatedAt: '2026-05-01T00:00:00.000Z'
    }));

    const result = await upsertChatSession(createChatSession({
      chatId: 'a',
      title: 'Old',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }));

    expect(result.title).toBe('New');
    expect(readChat(state, 'a')?.title).toBe('New');
  });

  it('updates an existing session in place', async () => {
    await ensureStore();
    await upsertChatSession(createChatSession({ chatId: 'a', title: 'A' }));

    const updated = await updateChatSession('a', (session) => {
      session.title = 'Renamed';
    });

    expect(updated?.title).toBe('Renamed');
    expect((await getChatSession('a'))?.title).toBe('Renamed');
  });

  it('returns null when updating a missing session', async () => {
    await ensureStore();
    await expect(updateChatSession('missing', () => undefined)).resolves.toBeNull();
  });

  it('deletes a single session and clears them all', async () => {
    const state = getChromeState();
    await ensureStore();
    await upsertChatSession(createChatSession({ chatId: 'a' }));
    await upsertChatSession(createChatSession({ chatId: 'b' }));

    await deleteChatSession('a');
    expect(readChat(state, 'a')).toBeUndefined();
    expect(readIndex(state).map((entry) => entry.chatId)).toEqual(['b']);

    await clearChatSessions();
    expect(readChat(state, 'b')).toBeUndefined();
    expect(readIndex(state)).toEqual([]);
    await expect(getAllChatSessions()).resolves.toEqual([]);
  });

  it('saveStore persists the provided store verbatim', async () => {
    const state = getChromeState();
    const store = createEmptyStore();
    store.featureSettings.defaultProviderId = 'p1';
    store.chatHistory.push(createChatSession({ chatId: 'a', title: 'A' }));

    await saveStore(store);

    expect(readMeta(state).featureSettings.defaultProviderId).toBe('p1');
    expect(readChat(state, 'a')?.title).toBe('A');
    expect(readIndex(state).map((entry) => entry.chatId)).toEqual(['a']);
  });
});

describe('storage usage', () => {
  it('does not treat the default 10 MB quota as a limit with unlimitedStorage', async () => {
    const manifest = vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({
      manifest_version: 3, name: 'Test', version: '1', permissions: ['unlimitedStorage']
    });
    try {
      getChromeState().seedStorage({ payload: 'x'.repeat(11 * 1024 * 1024) });
      const usage = await getStorageUsage();
      expect(usage.bytes).toBeGreaterThan(10 * 1024 * 1024);
      expect(usage.quotaBytes).toBeNull();
      expect(usage.ratio).toBeNull();
    } finally {
      manifest.mockRestore();
    }
  });

  it('reports bytes, quota and ratio', async () => {
    await ensureStore();
    const usage = await getStorageUsage();

    expect(usage.quotaBytes).toBeGreaterThan(0);
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.ratio).toBeGreaterThan(0);
    expect(usage.ratio).toBeLessThanOrEqual(1);
  });

  it('surfaces quota failures as StorageQuotaError', async () => {
    const state = getChromeState();
    await ensureStore();
    state.setStorageLimit(64);

    await expect(upsertChatSession(createChatSession({ chatId: 'big' })))
      .rejects.toBeInstanceOf(StorageQuotaError);
  });
});
