import { normalizeCustomReasoningEfforts } from '../../shared/reasoning';
import type { ModelConfig, PromptConfig, ProviderConfig } from '../../shared/types';
import { escapeHtml } from '../../shared/utils';

export type SelectorElements = {
  profileSelect: HTMLSelectElement;
  promptSelect: HTMLSelectElement;
  reasoningEffortSelect: HTMLSelectElement;
  streamingToggle: HTMLInputElement;
  sessionContext: HTMLElement;
  searchToggle: HTMLInputElement;
};

export type SelectorState = {
  providers: readonly ProviderConfig[];
  prompts: readonly PromptConfig[];
  profileId: string | null;
  promptId: string | null;
  model: ModelConfig | null;
  reasoningEffort: string;
  streamingOverride: boolean | null;
};

/** Renders the compact chat settings surface without owning request state. */
export class SelectorView {
  constructor(private readonly elements: SelectorElements) {}

  render(state: SelectorState): string {
    const { providers, prompts, profileId, promptId } = state;
    this.elements.profileSelect.innerHTML = providers.length
      ? providers.map((provider) =>
        `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('')
      : `<option value="">${escapeHtml(t('chat__noProvider'))}</option>`;

    this.elements.promptSelect.innerHTML = [
      `<option value="">${escapeHtml(t('prompt__noPrompt'))}</option>`,
      ...(promptId && !prompts.some(prompt => prompt.id === promptId)
        ? [`<option value="${escapeHtml(promptId)}">${escapeHtml(t('chat__statusPromptUnavailable'))}</option>`]
        : []),
      ...prompts.map((prompt) =>
        `<option value="${escapeHtml(prompt.id)}">${escapeHtml(prompt.name)}</option>`)
    ].join('');

    this.elements.profileSelect.value = profileId ?? '';
    this.elements.promptSelect.value = promptId ?? '';
    this.renderReasoning(state);
    this.renderContext(state);
    return this.elements.reasoningEffortSelect.value || 'default';
  }

  renderReasoning(state: Pick<SelectorState, 'model' | 'reasoningEffort' | 'streamingOverride'>): string {
    const select = this.elements.reasoningEffortSelect;
    select.querySelectorAll('[data-custom-effort]').forEach((option) => option.remove());
    for (const value of normalizeCustomReasoningEfforts(state.model?.customReasoningEfforts)) {
      const option = new Option(value, value);
      option.dataset.customEffort = 'true';
      select.add(option);
    }
    const nextEffort = Array.from(select.options).some((option) => option.value === state.reasoningEffort)
      ? state.reasoningEffort
      : 'default';
    select.value = nextEffort;
    const streaming = state.streamingOverride ?? state.model?.supportsStreaming ?? true;
    this.elements.streamingToggle.checked = streaming;
    return nextEffort;
  }

  renderContext(state: Pick<SelectorState, 'providers' | 'prompts' | 'profileId' | 'promptId' | 'model'> & { searchEnabled?: boolean }) {
    const provider = state.providers.find((item) => item.id === state.profileId);
    const model = state.model;
    const prompt = state.prompts.find((item) => item.id === state.promptId);
    const chips = [provider?.name || t('chat__noProvider'), model?.displayName || model?.modelId]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .map((value) => `<span class="context-chip">${escapeHtml(String(value))}</span>`);
    if (prompt) chips.push(`<span class="context-chip">${escapeHtml(prompt.name)}</span>`);
    if (state.searchEnabled) chips.push(`<span class="context-chip">${escapeHtml(t('chat__searchToggle'))}</span>`);
    this.elements.sessionContext.innerHTML = chips.join('');
  }
}
