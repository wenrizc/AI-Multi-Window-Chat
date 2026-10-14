import type { SearchSettings } from '../../shared/types';
import { clampSearchRounds, toNullableInt } from '../../shared/utils';
import type { PopupElements } from '../dom';

export class SearchSettingsForm {
  constructor(private readonly elements: PopupElements) {}

  fill(search: SearchSettings) {
    this.elements.tavilyApiKey.value = search.tavilyApiKey;
    this.elements.searchDepthSelect.value = search.searchDepth;
    this.elements.timeRangeSelect.value = search.timeRange ?? '';
    this.elements.maxResultsInput.value = String(search.maxResults);
    this.elements.maxRoundsInput.value = String(search.maxRounds);
  }

  read(): SearchSettings {
    return {
      tavilyApiKey: this.elements.tavilyApiKey.value.trim(),
      enabledByDefault: false,
      searchDepth: this.elements.searchDepthSelect.value as 'basic' | 'advanced',
      timeRange: (this.elements.timeRangeSelect.value || null) as 'day' | 'week' | 'month' | 'year' | null,
      maxResults: Math.max(1, toNullableInt(this.elements.maxResultsInput.value) ?? 5),
      maxRounds: clampSearchRounds(toNullableInt(this.elements.maxRoundsInput.value))
    };
  }
}
