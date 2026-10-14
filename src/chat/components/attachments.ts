import type { ChatAttachment } from '../../shared/types';
import { escapeHtml } from '../../shared/utils';

export class AttachmentView {
  constructor(private readonly tray: HTMLElement) {}

  render(attachments: readonly ChatAttachment[], onRemove: (id: string) => void) {
    this.tray.hidden = attachments.length === 0;
    this.tray.innerHTML = attachments.map((attachment) => {
      const preview = attachment.mimeType.startsWith('image/') && attachment.dataUrl
        ? `<img src="${escapeHtml(attachment.dataUrl)}" alt="">`
        : '<span class="attachment-file">TXT</span>';
      const statusKey = attachment.status === 'ready'
        ? 'chat__attachmentReady'
        : attachment.status === 'error' ? 'chat__attachmentError' : 'chat__attachmentParsing';
      return `<div class="attachment-chip ${escapeHtml(attachment.status)}">${preview}`
        + `<span class="attachment-name">${escapeHtml(attachment.name)}</span>`
        + `<span class="attachment-status">${escapeHtml(t(statusKey))}</span>`
        + `<button type="button" data-remove-attachment="${escapeHtml(attachment.id)}" aria-label="${escapeHtml(t('chat__btnRemoveAttachment', attachment.name))}">×</button></div>`;
    }).join('');
    this.tray.querySelectorAll<HTMLButtonElement>('[data-remove-attachment]').forEach((button) => {
      button.addEventListener('click', () => onRemove(button.dataset.removeAttachment || ''));
    });
  }
}
