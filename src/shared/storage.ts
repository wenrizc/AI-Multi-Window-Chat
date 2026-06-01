import { createEmptyStore, STORAGE_KEY } from './constants';
import type { ChatSession, RootStore } from './types';

type StoredRootStore = {
  schemaVersion?: number;
} & Partial<RootStore>;

async function readRawStore(): Promise<RootStore | null> {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const store = result[STORAGE_KEY] as StoredRootStore | undefined;
  if (!store || store.schemaVersion !== 4) {
    return null;
  }
  return store as RootStore;
}

export async function ensureStore(): Promise<RootStore> {
  const existing = await readRawStore();
  if (existing) {
    const normalized = normalizeFixedDefaults(existing);
    if (normalized.changed) {
      await chrome.storage.local.set({ [STORAGE_KEY]: normalized.store });
    }
    return normalized.store;
  }
  const store = createEmptyStore();
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  return store;
}

function normalizeFixedDefaults(store: RootStore): { store: RootStore; changed: boolean } {
  let changed = false;
  const normalized = structuredClone(store);

  if (normalized.featureSettings.defaultStreaming !== false) {
    normalized.featureSettings.defaultStreaming = false;
    changed = true;
  }

  if (normalized.featureSettings.search.enabledByDefault !== false) {
    normalized.featureSettings.search.enabledByDefault = false;
    changed = true;
  }

  for (const provider of normalized.providers) {
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

  for (const chat of normalized.chatHistory) {
    if (chat.streamingOverride === undefined) {
      chat.streamingOverride = null;
      changed = true;
    }
    if (chat.maxContextMessagesOverride === undefined) {
      chat.maxContextMessagesOverride = null;
      changed = true;
    }
  }

  return { store: normalized, changed };
}

export async function getStore(): Promise<RootStore> {
  return ensureStore();
}

export async function saveStore(store: RootStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

export async function updateStore(
  updater: (store: RootStore) => RootStore | void
): Promise<RootStore> {
  const current = await ensureStore();
  const draft = structuredClone(current);
  const updated = updater(draft) ?? draft;
  await saveStore(updated);
  return updated;
}

export async function upsertChatSession(session: ChatSession): Promise<RootStore> {
  return updateStore((store) => {
    const index = store.chatHistory.findIndex((item) => item.chatId === session.chatId);
    if (index >= 0) {
      store.chatHistory[index] = session;
    } else {
      store.chatHistory.unshift(session);
    }
    return store;
  });
}
