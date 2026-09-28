import type { SearchSettings, SearchSource } from '../shared/types';
import { buildSearchMeta, normalizeSources } from '../shared/parsers';
import { i18nMessage } from '../shared/utils';
import { COMPLETE_TIMEOUTS, RequestGuard } from '../shared/timeout';

export async function searchWithTavily(input: {
  query: string;
  settings: SearchSettings;
  signal: AbortSignal;
}) {
  if (!input.settings.tavilyApiKey) {
    throw new Error(i18nMessage('chat__statusConfigureTavilyFirst'));
  }

  const guard = new RequestGuard({ budget: COMPLETE_TIMEOUTS, userSignal: input.signal });
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: guard.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: input.settings.tavilyApiKey,
        query: input.query,
        topic: 'general',
        search_depth: input.settings.searchDepth,
        max_results: input.settings.maxResults,
        ...(input.settings.timeRange && { time_range: input.settings.timeRange }),
        include_raw_content: false
      })
    });
    guard.markFirstByte();

    if (!response.ok) {
      throw new Error(i18nMessage('chat__statusTavilyReturned', String(response.status)));
    }

    const payload = await response.json() as Record<string, unknown>;
    const credits =
      typeof payload.credits === 'number'
        ? payload.credits
        : typeof payload.search_credit === 'number'
          ? payload.search_credit
          : null;
    const sources: SearchSource[] = normalizeSources(payload.results, input.query, credits);
    return {
      sources,
      searchMeta: buildSearchMeta(input.query, sources, credits)
    };
  } finally {
    guard.cleanup();
  }
}
