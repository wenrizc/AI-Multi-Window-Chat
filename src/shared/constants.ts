import type { FeatureSettings, RootStore, SearchSettings } from './types';

export const SCHEMA_VERSION = 4 as const;
export const STORAGE_KEY = 'app_state_v4';
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
  defaultStreaming: true,
  search: DEFAULT_SEARCH_SETTINGS
};

export function createEmptyStore(): RootStore {
  return {
    schemaVersion: SCHEMA_VERSION,
    providers: [],
    prompts: [],
    featureSettings: structuredClone(DEFAULT_FEATURE_SETTINGS),
    chatHistory: []
  };
}
