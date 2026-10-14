import type { ProviderConfig } from '../../shared/types';
import { isValidHeaderName, nowIso } from '../../shared/utils';
import type { PopupElements } from '../dom';

export type ProviderDraft = {
  profileName: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  authMode: string;
  headers: Array<{ name: string; value: string }>;
  transport: string;
  reasoningFormat: string;
  customEfforts: string;
  supportsStreaming: boolean;
  temperature: string;
  updatedAt: string;
};

/** Owns form rendering and draft collection; persistence belongs to the app. */
export class ProviderForm {
  constructor(private readonly elements: PopupElements) {}

  fill(provider: ProviderConfig | undefined, draft?: ProviderDraft) {
    if (!provider) {
      this.clear();
      return;
    }
    const model = provider.modelCatalog?.[0];
    this.elements.profileName.value = draft?.profileName ?? provider.name;
    this.elements.apiUrl.value = draft?.apiUrl ?? provider.baseUrl;
    this.elements.apiKey.value = draft?.apiKey ?? provider.apiKey;
    this.elements.modelName.value = draft?.modelName ?? model?.modelId ?? provider.defaultModel;
    this.elements.authModeSelect.value = draft?.authMode ?? provider.authMode ?? 'bearer';
    this.renderHeaderRows(draft?.headers ?? provider.headers);
    this.elements.transportSelect.value = draft?.transport ?? provider.transport;
    this.elements.reasoningFormatSelect.value = draft?.reasoningFormat ?? model?.reasoningFormat ?? 'none';
    this.elements.customEffortsInput.value = draft?.customEfforts ?? (model?.customReasoningEfforts ?? []).join(', ');
    this.elements.supportsStreamingCheckbox.checked = draft?.supportsStreaming ?? model?.supportsStreaming ?? true;
    this.elements.temperatureInput.value = draft?.temperature ?? provider.defaultGenerationParams.temperature?.toString() ?? '';
  }

  captureDraft(): ProviderDraft {
    return {
      profileName: this.elements.profileName.value,
      apiUrl: this.elements.apiUrl.value,
      apiKey: this.elements.apiKey.value,
      modelName: this.elements.modelName.value,
      authMode: this.elements.authModeSelect.value,
      headers: Array.from(this.elements.headerRows.querySelectorAll('.header-row')).map((row) => ({
        name: (row.querySelector('.header-name') as HTMLInputElement | null)?.value ?? '',
        value: (row.querySelector('.header-value') as HTMLInputElement | null)?.value ?? ''
      })),
      transport: this.elements.transportSelect.value,
      reasoningFormat: this.elements.reasoningFormatSelect.value,
      customEfforts: this.elements.customEffortsInput.value,
      supportsStreaming: this.elements.supportsStreamingCheckbox.checked,
      temperature: this.elements.temperatureInput.value,
      updatedAt: nowIso()
    };
  }

  clear() {
    [
      this.elements.profileName,
      this.elements.apiUrl,
      this.elements.apiKey,
      this.elements.modelName,
      this.elements.temperatureInput
    ].forEach((input) => { input.value = ''; });
    this.elements.customEffortsInput.value = '';
    this.elements.transportSelect.value = 'chat_completions';
    this.elements.reasoningFormatSelect.value = 'none';
    this.elements.supportsStreamingCheckbox.checked = true;
    this.elements.authModeSelect.value = 'bearer';
    this.renderHeaderRows({});
  }

  renderHeaderRows(headers: Record<string, string> | Array<{ name: string; value: string }> | undefined) {
    this.elements.headerRows.innerHTML = '';
    const entries: Array<[string, string]> = Array.isArray(headers)
      ? headers.map((header) => [header.name, header.value])
      : Object.entries(headers ?? {});
    if (entries.length === 0) {
      this.appendHeaderRow('', '');
      return;
    }
    entries.forEach(([name, value]) => this.appendHeaderRow(name, value));
  }

  appendHeaderRow(name: string, value: string) {
    const row = document.createElement('div');
    row.className = 'header-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'header-name';
    nameInput.placeholder = t('popup__headerNamePlaceholder');
    nameInput.setAttribute('aria-label', t('popup__headerNamePlaceholder'));
    nameInput.value = name;

    const valueInput = document.createElement('input');
    valueInput.type = 'password';
    valueInput.className = 'header-value';
    valueInput.placeholder = t('popup__headerValuePlaceholder');
    valueInput.setAttribute('aria-label', t('popup__headerValuePlaceholder'));
    valueInput.value = value;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-secondary btn-inline';
    toggle.dataset.headerAction = 'toggle';
    toggle.textContent = t('popup__btnShowKey');

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-danger btn-inline';
    remove.dataset.headerAction = 'remove';
    remove.setAttribute('aria-label', t('popup__btnRemoveHeader'));
    remove.textContent = '×';

    row.append(nameInput, valueInput, toggle, remove);
    this.elements.headerRows.appendChild(row);
  }

  collectHeaders(): { headers: Record<string, string>; error: string | null } {
    const headers: Record<string, string> = {};
    const rows = Array.from(this.elements.headerRows.querySelectorAll('.header-row'));
    for (const row of rows) {
      const name = (row.querySelector('.header-name') as HTMLInputElement | null)?.value.trim() ?? '';
      const value = (row.querySelector('.header-value') as HTMLInputElement | null)?.value ?? '';
      if (!name) {
        continue;
      }
      if (!isValidHeaderName(name)) {
        return { headers, error: t('popup__statusInvalidHeaderName', name) };
      }
      if (name in headers) {
        return { headers, error: t('popup__statusDuplicateHeaderName', name) };
      }
      headers[name] = value;
    }
    return { headers, error: null };
  }
}
