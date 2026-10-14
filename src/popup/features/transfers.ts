import type { FeatureSettings, PromptConfig, ProviderConfig, RootStore, SearchSettings } from '../../shared/types';
import { clampSearchRounds, toNullableInt } from '../../shared/utils';

export type ProviderImportPayload = {
  providers?: ProviderConfig[];
  defaultProviderId?: string | null;
  search?: Partial<SearchSettings> | null;
  featureSettings?: Partial<FeatureSettings> | null;
};

export function parseImportPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  const fencedJson = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson) {
    return JSON.parse(fencedJson[1].trim());
  }

  throw new Error(t('popup__errorUnsupportedImport'));
}

export function resolveImportedDefaultProviderId(
  parsed: ProviderImportPayload,
  providers: ProviderConfig[],
  fallbackProviderId: string | null
): string | null {
  const importedDefaultProviderId = parsed.defaultProviderId ?? parsed.featureSettings?.defaultProviderId ?? null;
  if (importedDefaultProviderId && providers.some((provider) => provider.id === importedDefaultProviderId)) {
    return importedDefaultProviderId;
  }
  if (fallbackProviderId && providers.some((provider) => provider.id === fallbackProviderId)) {
    return fallbackProviderId;
  }
  return providers[0]?.id ?? null;
}

export function resolveImportedPromptId(
  importedPromptId: string | null,
  prompts: PromptConfig[],
  fallbackPromptId: string | null
): string | null {
  if (importedPromptId && prompts.some((prompt) => prompt.id === importedPromptId)) {
    return importedPromptId;
  }
  if (fallbackPromptId && prompts.some((prompt) => prompt.id === fallbackPromptId)) {
    return fallbackPromptId;
  }
  return prompts[0]?.id ?? null;
}

export function normalizeImportedSearchSettings(
  input: Partial<SearchSettings> | null | undefined,
  fallback: SearchSettings
): SearchSettings {
  const candidate = isRecord(input) ? input : {};
  const timeRange = candidate.timeRange;
  const normalizedTimeRange = timeRange === 'day' || timeRange === 'week' || timeRange === 'month' || timeRange === 'year'
    ? timeRange
    : fallback.timeRange;

  return {
    tavilyApiKey: typeof candidate.tavilyApiKey === 'string' ? candidate.tavilyApiKey.trim() : fallback.tavilyApiKey,
    enabledByDefault: false,
    searchDepth: candidate.searchDepth === 'advanced' || candidate.searchDepth === 'basic'
      ? candidate.searchDepth
      : fallback.searchDepth,
    timeRange: normalizedTimeRange,
    maxResults: Math.max(1, toNullableInt(candidate.maxResults) ?? fallback.maxResults),
    maxRounds: clampSearchRounds(toNullableInt(candidate.maxRounds) ?? fallback.maxRounds)
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function getErrorText(error: unknown): string {
  if (error instanceof SyntaxError) return t('popup__errorInvalidImportJson');
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || t('common__unknownError'));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPayloadMarkdown(title: string, payload: unknown): string {
  return [
    `# ${title}`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    ''
  ].join('\n');
}

export function exportAsMarkdown(chats: RootStore['chatHistory']) {
  return chats.map((chat) => {
    const lines = [`# ${chat.title}`, '', `${t('export__updatedAt')}: ${chat.updatedAt}`, ''];
    for (const message of chat.messages) {
      lines.push(`## ${message.role === 'user' ? t('chat__roleUser') : t('chat__roleAI')}`);
      lines.push('');
      lines.push(message.content);
      lines.push('');
      if (message.sources.length > 0) {
        lines.push(`${t('export__sources')}:`);
        message.sources.forEach((source, index) => lines.push(`${index + 1}. ${source.title} - ${source.url}`));
        lines.push('');
      }
    }
    return lines.join('\n');
  }).join('\n\n---\n\n');
}

export function exportPayload(format: string, basename: string, payload: unknown) {
  if (format === 'json') {
    downloadFile(`${basename}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    return;
  }
  downloadFile(`${basename}.md`, formatPayloadMarkdown(basename, payload), 'text/markdown;charset=utf-8');
}

export function downloadFile(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
