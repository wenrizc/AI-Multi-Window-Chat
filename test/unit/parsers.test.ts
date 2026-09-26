import { describe, expect, it } from 'vitest';
import {
  buildSearchMeta,
  mergeUsagePayload,
  normalizeSources,
  normalizeUsagePayload
} from '../../src/shared/parsers';

describe('normalizeUsagePayload', () => {
  it('maps chat-completions usage fields, including nested details', () => {
    const usage = normalizeUsagePayload({
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
      output_tokens_details: { reasoning_tokens: 15 },
      input_tokens_details: { cached_tokens: 12 }
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      reasoningTokens: 15,
      cacheReadTokens: 12,
      totalTokens: 200
    });
  });

  it('supports responses-style token names', () => {
    expect(normalizeUsagePayload({ input_tokens: 5, output_tokens: 3, total_tokens: 8 })).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      reasoningTokens: null,
      cacheReadTokens: null,
      totalTokens: 8
    });
  });

  it('returns null for empty or missing payloads', () => {
    expect(normalizeUsagePayload(null)).toBeNull();
    expect(normalizeUsagePayload(undefined)).toBeNull();
    expect(normalizeUsagePayload({})).toBeNull();
  });

  it('ignores non-numeric values', () => {
    expect(normalizeUsagePayload({ prompt_tokens: 'many' })).toBeNull();
  });
});

describe('mergeUsagePayload', () => {
  it('prefers newly provided values over the existing metrics', () => {
    const current = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheReadTokens: null,
      totalTokens: 5
    };
    expect(mergeUsagePayload(current, { completion_tokens: 9 })).toEqual({
      inputTokens: 1,
      outputTokens: 9,
      reasoningTokens: 3,
      cacheReadTokens: null,
      totalTokens: 5
    });
  });

  it('returns the current metrics when the payload has no usage', () => {
    const current = {
      inputTokens: 1,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      totalTokens: null
    };
    expect(mergeUsagePayload(current, null)).toEqual(current);
  });
});

describe('normalizeSources', () => {
  it('maps raw results to typed sources with stable ids', () => {
    const sources = normalizeSources(
      [
        { title: 'A', url: 'https://a.test', content: 'snippet a', score: 0.9 },
        { url: 'https://b.test' }
      ],
      'weather',
      2
    );

    expect(sources).toEqual([
      {
        id: 'source-1',
        title: 'A',
        url: 'https://a.test',
        snippet: 'snippet a',
        score: 0.9,
        query: 'weather',
        credits: 2
      },
      {
        id: 'source-2',
        title: 'Source 2',
        url: 'https://b.test',
        snippet: '',
        score: null,
        query: 'weather',
        credits: 2
      }
    ]);
  });

  it('prefers snippet over content when content is absent', () => {
    const [source] = normalizeSources([{ snippet: 'from snippet' }], 'q', null);
    expect(source.snippet).toBe('from snippet');
    expect(source.credits).toBeNull();
  });

  it('returns an empty list for non-array input', () => {
    expect(normalizeSources(null, 'q', null)).toEqual([]);
    expect(normalizeSources({ results: [] }, 'q', null)).toEqual([]);
  });
});

describe('buildSearchMeta', () => {
  it('summarizes the search round', () => {
    const sources = normalizeSources([{ title: 'A', url: 'https://a.test' }], 'q', 1);
    expect(buildSearchMeta('q', sources, 1)).toEqual({
      queries: ['q'],
      credits: 1,
      sourceCount: 1,
      rounds: 1
    });
  });
});
