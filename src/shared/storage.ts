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
    return existing;
  }
  const store = createEmptyStore();
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
  return store;
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
