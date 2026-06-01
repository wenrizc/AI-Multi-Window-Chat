import type {
  ModelConfig,
  ProviderConfig,
  ReasoningFormat,
  UsageMetrics
} from './types';

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(prefix: string): string {
  const tail = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${tail}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

export function toNullableInt(value: unknown): number | null {
  const parsed = toNullableNumber(value);
  if (parsed === null) {
    return null;
  }
  const normalized = Math.floor(parsed);
  return normalized >= 0 ? normalized : null;
}

export function normalizeMaxContextMessages(value: unknown): number | null {
  const parsed = toNullableInt(value);
  if (parsed === null || parsed === 0) {
    return null;
  }
  return parsed;
}

export function compactText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\r/g, '').trim();
  return normalized ? normalized : null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function i18nMessage(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions as string | string[]) || key;
}

export function createUsageMetrics(partial?: Partial<UsageMetrics> | null): UsageMetrics | null {
  if (!partial) {
    return null;
  }
  const usage: UsageMetrics = {
    inputTokens: toNullableInt(partial.inputTokens),
    outputTokens: toNullableInt(partial.outputTokens),
    reasoningTokens: toNullableInt(partial.reasoningTokens),
    cacheReadTokens: toNullableInt(partial.cacheReadTokens),
    totalTokens: toNullableInt(partial.totalTokens)
  };

  const hasValue = Object.values(usage).some((value) => value !== null);
  return hasValue ? usage : null;
}

export function mergeUsage(base: UsageMetrics | null, next: UsageMetrics | null): UsageMetrics | null {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  return createUsageMetrics({
    inputTokens: next.inputTokens ?? base.inputTokens,
    outputTokens: next.outputTokens ?? base.outputTokens,
    reasoningTokens: next.reasoningTokens ?? base.reasoningTokens,
    cacheReadTokens: next.cacheReadTokens ?? base.cacheReadTokens,
    totalTokens: next.totalTokens ?? base.totalTokens
  });
}

export function addUsage(base: UsageMetrics | null, next: UsageMetrics | null): UsageMetrics | null {
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  const sumValue = (left: number | null, right: number | null) => {
    if (left === null && right === null) {
      return null;
    }
    return (left ?? 0) + (right ?? 0);
  };

  return createUsageMetrics({
    inputTokens: sumValue(base.inputTokens, next.inputTokens),
    outputTokens: sumValue(base.outputTokens, next.outputTokens),
    reasoningTokens: sumValue(base.reasoningTokens, next.reasoningTokens),
    cacheReadTokens: sumValue(base.cacheReadTokens, next.cacheReadTokens),
    totalTokens: sumValue(base.totalTokens, next.totalTokens)
  });
}

export function getModel(provider: ProviderConfig, modelId?: string | null): ModelConfig {
  const targetId = modelId || provider.defaultModel;
  return (
    provider.modelCatalog.find((item) => item.modelId === targetId) ??
    provider.modelCatalog[0]
  );
}

export function sliceMessageWindow<T>(messages: T[], maxContextMessages: number | null | undefined): T[] {
  const limit = normalizeMaxContextMessages(maxContextMessages);
  if (limit === null) {
    return [...messages];
  }
  return messages.slice(-limit);
}

export function clampSearchRounds(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(2, Math.max(1, Math.floor(value as number)));
}

export function resolveReasoningFormat(value: string): ReasoningFormat {
  if (value === 'openai_summary' || value === 'reasoning_content') {
    return value;
  }
  return 'none';
}

export function formatUsageLabel(usage: UsageMetrics | null): string {
  if (!usage) {
    return i18nMessage('usage__unavailable');
  }

  const parts: string[] = [];
  if (usage.inputTokens !== null) {
    parts.push(i18nMessage('usage__inputTokens', String(usage.inputTokens)));
  }
  if (usage.outputTokens !== null) {
    parts.push(i18nMessage('usage__outputTokens', String(usage.outputTokens)));
  }
  if (usage.reasoningTokens !== null) {
    parts.push(i18nMessage('usage__reasoningTokens', String(usage.reasoningTokens)));
  }
  return parts.join(' | ') || i18nMessage('usage__unavailable');
}

type ClipboardEnvironment = {
  navigator?: Pick<Navigator, 'clipboard'>;
  document?: Pick<Document, 'body' | 'createElement' | 'execCommand'>;
};

export async function writeTextToClipboard(value: string, env: ClipboardEnvironment = globalThis as ClipboardEnvironment): Promise<boolean> {
  try {
    await env.navigator?.clipboard?.writeText(value);
    return true;
  } catch {
    // Fallback to execCommand for embedded extension iframes where Clipboard API can be unavailable.
  }

  const doc = env.document;
  if (!doc?.body) {
    return false;
  }

  const textarea = doc.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  doc.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    doc.body.removeChild(textarea);
  }
}
