import { describe, expect, it } from 'vitest';
import { createEmptyStore, STORAGE_KEY } from '../../src/shared/constants';
import { ensureStore, getStore, saveStore, updateStore, upsertChatSession } from '../../src/shared/storage';
import type { RootStore } from '../../src/shared/types';
import { getChromeState } from '../helpers/chrome-mock';
import { createChatSession, createModel, createProvider } from '../helpers/factories';

function readStoredStore(state: ReturnType<typeof getChromeState>): RootStore {
  return state.storage[STORAGE_KEY] as RootStore;
}

describe('createEmptyStore', () => {
  it('ships the fixed defaults (streaming/search disabled)', () => {
    const store = createEmptyStore();
    expect(store.schemaVersion).toBe(4);
    expect(store.providers).toEqual([]);
    expect(store.prompts).toEqual([]);
    expect(store.chatHistory).toEqual([]);
    expect(store.featureSettings.defaultStreaming).toBe(false);
    expect(store.featureSettings.search.enabledByDefault).toBe(false);
  });
});

describe('ensureStore', () => {
  it('creates and persists an empty store when none exists', async () => {
    const state = getChromeState();
    const store = await ensureStore();

    expect(store).toEqual(createEmptyStore());
    expect(readStoredStore(state)).toEqual(createEmptyStore());
  });

  it('returns the persisted store when the schema matches', async () => {
    const state = getChromeState();
    const seeded = createEmptyStore();
    seeded.providers.push(createProvider());
    state.seedStorage({ [STORAGE_KEY]: seeded });

    await expect(getStore()).resolves.toEqual(seeded);
  });

  it('resets storage written by an older schema version', async () => {
    const state = getChromeState();
    state.seedStorage({ [STORAGE_KEY]: { schemaVersion: 3, providers: [createProvider()] } });

    const store = await ensureStore();

    expect(store.schemaVersion).toBe(4);
    expect(store.providers).toEqual([]);
    expect(readStoredStore(state).providers).toEqual([]);
  });

  it('repairs fixed defaults and normalizes missing model/chat fields', async () => {
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

    state.seedStorage({ [STORAGE_KEY]: legacy });
    const store = await ensureStore();

    expect(store.featureSettings.defaultStreaming).toBe(false);
    expect(store.featureSettings.search.enabledByDefault).toBe(false);
    expect(store.providers[0].modelCatalog[0].supportsStreaming).toBe(true);
    expect(store.providers[0].modelCatalog[0].maxContextMessages).toBeNull();
    expect(store.chatHistory[0].streamingOverride).toBeNull();
    expect(store.chatHistory[0].maxContextMessagesOverride).toBeNull();

    // The repaired store must be written back, not only returned.
    const persisted = readStoredStore(state);
    expect(persisted.featureSettings.defaultStreaming).toBe(false);
    expect(persisted.chatHistory[0].streamingOverride).toBeNull();
  });

  it('coerces a non-array modelCatalog to an empty array', async () => {
    const state = getChromeState();
    const store = createEmptyStore();
    store.providers.push(createProvider());
    (store.providers[0] as unknown as { modelCatalog: unknown }).modelCatalog = 'nope';
    state.seedStorage({ [STORAGE_KEY]: store });

    const repaired = await ensureStore();
    expect(repaired.providers[0].modelCatalog).toEqual([]);
  });

  it('does not rewrite storage when nothing changed', async () => {
    const state = getChromeState();
    const store = createEmptyStore();
    store.providers.push(createProvider({ modelCatalog: [createModel()] }));
    state.seedStorage({ [STORAGE_KEY]: store });
    const before = JSON.stringify(state.storage[STORAGE_KEY]);

    await ensureStore();

    expect(JSON.stringify(state.storage[STORAGE_KEY])).toBe(before);
  });
});

describe('saveStore / updateStore', () => {
  it('persists the provided store verbatim', async () => {
    const state = getChromeState();
    const store = createEmptyStore();
    store.featureSettings.defaultProviderId = 'p1';
    await saveStore(store);

    expect(readStoredStore(state).featureSettings.defaultProviderId).toBe('p1');
  });

  it('applies an updater against a clone and returns the result', async () => {
    const state = getChromeState();
    await ensureStore();

    const updated = await updateStore((store) => {
      store.prompts.push({
        id: 'prompt-1',
        name: 'P',
        content: 'c',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      });
    });

    expect(updated.prompts).toHaveLength(1);
    expect(readStoredStore(state).prompts).toHaveLength(1);
  });
});

describe('upsertChatSession', () => {
  it('unshifts new sessions and replaces existing ones by chatId', async () => {
    const state = getChromeState();
    await ensureStore();

    await upsertChatSession(createChatSession({ chatId: 'a', title: 'A' }));
    await upsertChatSession(createChatSession({ chatId: 'b', title: 'B' }));
    await upsertChatSession(createChatSession({ chatId: 'a', title: 'A2' }));

    const history = readStoredStore(state).chatHistory;
    expect(history.map((chat) => chat.chatId)).toEqual(['b', 'a']);
    expect(history.find((chat) => chat.chatId === 'a')?.title).toBe('A2');
  });
});
