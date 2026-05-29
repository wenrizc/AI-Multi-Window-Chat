import type { SearchMeta, SearchSource, UsageMetrics } from './types';
import { createUsageMetrics, mergeUsage } from './utils';

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

export function normalizeUsagePayload(rawUsage: Record<string, unknown> | null | undefined): UsageMetrics | null {
  if (!rawUsage) {
    return null;
  }
  return createUsageMetrics({
    inputTokens: readNumber(rawUsage.prompt_tokens ?? rawUsage.input_tokens),
    outputTokens: readNumber(rawUsage.completion_tokens ?? rawUsage.output_tokens),
    reasoningTokens:
      readNumber(rawUsage.reasoning_tokens) ??
      (typeof rawUsage.output_tokens_details === 'object' && rawUsage.output_tokens_details
        ? readNumber((rawUsage.output_tokens_details as Record<string, unknown>).reasoning_tokens)
        : null),
    cacheReadTokens:
      typeof rawUsage.input_tokens_details === 'object' && rawUsage.input_tokens_details
        ? readNumber((rawUsage.input_tokens_details as Record<string, unknown>).cached_tokens)
        : null,
    totalTokens: readNumber(rawUsage.total_tokens)
  });
}

export function mergeUsagePayload(
  current: UsageMetrics | null,
  rawUsage: Record<string, unknown> | null | undefined
): UsageMetrics | null {
  return mergeUsage(current, normalizeUsagePayload(rawUsage));
}

export function normalizeSources(rawResults: unknown, query: string, credits: number | null): SearchSource[] {
  if (!Array.isArray(rawResults)) {
    return [];
  }
  return rawResults.map((item, index) => {
    const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      id: `source-${index + 1}`,
      title: String(entry.title ?? `Source ${index + 1}`),
      url: String(entry.url ?? ''),
      snippet: String(entry.content ?? entry.snippet ?? ''),
      score: typeof entry.score === 'number' ? entry.score : null,
      query,
      credits
    };
  });
}

export function buildSearchMeta(query: string, sources: SearchSource[], credits: number | null): SearchMeta {
  return {
    queries: [query],
    credits,
    sourceCount: sources.length,
    rounds: 1
  };
}
