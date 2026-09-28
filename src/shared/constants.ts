import type { FeatureSettings, RootStore, SearchSettings, StorageConfig } from './types';

export const SCHEMA_VERSION = 5 as const;
export const LEGACY_STORAGE_KEY = 'app_state_v4';
/** @deprecated Legacy v4 key; kept so older tests/seeds keep working. */
export const STORAGE_KEY = LEGACY_STORAGE_KEY;

/** Schema v5 splits one monolithic value into metadata + per-chat records. */
export const META_KEY = 'app_meta_v5';
export const CHAT_INDEX_KEY = 'chat_index_v5';
export const CHAT_SESSION_PREFIX = 'chat_';
export const MIGRATION_KEY = 'app_migration_v5';
export const PORT_NAME = 'ai-multi-window-chat-v2';

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  tavilyApiKey: '',
  enabledByDefault: false,
  searchDepth: 'basic',
  timeRange: null,
  maxResults: 5,
  maxRounds: 1
};

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  defaultProviderId: null,
  defaultPromptId: null,
  defaultStreaming: false,
  search: DEFAULT_SEARCH_SETTINGS
};

export function createEmptyConfig(): StorageConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    providers: [],
    prompts: [],
    featureSettings: structuredClone(DEFAULT_FEATURE_SETTINGS)
  };
}

export function createEmptyStore(): RootStore {
  return {
    ...createEmptyConfig(),
    chatHistory: []
  };
}
