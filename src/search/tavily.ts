import type { SearchSettings, SearchSource } from '../shared/types';
import { buildSearchMeta, normalizeSources } from '../shared/parsers';
import { i18nMessage } from '../shared/utils';

export async function searchWithTavily(input: {
  query: string;
  settings: SearchSettings;
  signal: AbortSignal;
}) {
  if (!input.settings.tavilyApiKey) {
    throw new Error(i18nMessage('chat__statusConfigureTavilyFirst'));
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    signal: input.signal,
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
}
