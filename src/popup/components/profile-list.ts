import { escapeHtml } from '../../shared/utils';

export function renderProfileList(
  list: HTMLElement,
  select: HTMLSelectElement,
  items: readonly { id: string; name: string }[],
  selectedId: string | null,
  defaultId: string | null,
  emptyMessage: string,
  emptyOption: string,
  allowEmpty: boolean
) {
  list.innerHTML = items.length ? items.map(item => `
    <button class="profile-item ${item.id === selectedId ? 'active' : ''} ${item.id === defaultId ? 'current' : ''}" data-id="${escapeHtml(item.id)}">
      <span class="profile-dot"></span><span class="profile-name">${escapeHtml(item.name)}</span>
    </button>`).join('') : `<div class="history-empty">${escapeHtml(emptyMessage)}</div>`;
  const none = `<option value="">${escapeHtml(emptyOption)}</option>`;
  select.innerHTML = (allowEmpty || !items.length ? none : '') + items.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  select.value = defaultId ?? '';
}
