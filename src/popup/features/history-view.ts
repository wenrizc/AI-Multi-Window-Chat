import type { RootStore } from '../../shared/types';
import { compactText, escapeHtml } from '../../shared/utils';

export class HistoryView {
  constructor(private readonly list: HTMLElement) {}

  render(chats: RootStore['chatHistory'], query: string) {
    if (chats.length === 0) {
      this.list.innerHTML = `<div class="history-empty"><div class="history-empty-icon">💬</div><div>${escapeHtml(t('history__empty'))}</div></div>`;
      return;
    }
    const filteredHistory = this.filter(chats, query);
    if (filteredHistory.length === 0) {
      this.list.innerHTML = `<div class="history-empty"><div class="history-empty-icon">🔎</div><div>${escapeHtml(t('history__searchNoResults'))}</div></div>`;
      return;
    }
    this.list.innerHTML = filteredHistory.map((chat) => `
      <div class="history-item" data-id="${escapeHtml(chat.chatId)}">
        <div class="history-item-header">
          <div class="history-item-icon">💬</div>
          <div class="history-item-title">${escapeHtml(chat.title)}</div>
        </div>
        <div class="history-item-meta">${new Date(chat.updatedAt).toLocaleString(document.documentElement.lang)} · ${escapeHtml(t(chat.messages.length === 1 ? 'history__messageCountOne' : 'history__messageCount', chat.messages.length))}</div>
        <div class="history-item-summary">${escapeHtml(this.summary(chat))}</div>
        <div class="history-item-actions">
          <button class="btn btn-secondary btn-small" data-action="resume" data-id="${escapeHtml(chat.chatId)}">${escapeHtml(t('history__btnResume'))}</button>
          <button class="btn btn-secondary btn-small" data-action="export" data-id="${escapeHtml(chat.chatId)}">${escapeHtml(t('history__btnExport'))}</button>
          <button class="btn btn-danger btn-small" data-action="delete" data-id="${escapeHtml(chat.chatId)}">${escapeHtml(t('history__btnDelete'))}</button>
        </div>
      </div>
    `).join('');
  }

  filter(chats: RootStore['chatHistory'], searchTerm: string) {
    const query = compactText(searchTerm)?.toLowerCase();
    if (!query) {
      return chats;
    }

    return chats.filter((chat) => {
      const haystack = [
        chat.title,
        chat.providerId ?? '',
        chat.promptId ?? '',
        this.summary(chat),
        ...chat.messages.flatMap((message) => [
          message.content,
          message.modelId ?? ''
        ])
      ].join('\n').toLowerCase();
      return haystack.includes(query);
    });
  }

  summary(chat: RootStore['chatHistory'][number]) {
    const candidate = [...chat.messages].reverse().find((message) => compactText(message.content));
    return compactText(candidate?.content)?.replace(/\s+/g, ' ').slice(0, 120) || chat.title;
  }
}
