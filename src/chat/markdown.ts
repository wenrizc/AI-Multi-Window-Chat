import { marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { escapeHtml } from '../shared/utils';

const SAFE_URL_PROTOCOL = /^(https?:|mailto:)/i;

export function safeLinkHref(value: unknown): string | null {
  const url = String(value ?? '').trim();
  if (!url) {
    return null;
  }
  if (
    url.startsWith('#') ||
    (url.startsWith('/') && !url.startsWith('//')) ||
    url.startsWith('./') ||
    url.startsWith('../')
  ) {
    return url;
  }
  return SAFE_URL_PROTOCOL.test(url) ? url : null;
}

marked.use(markedKatex({ throwOnError: false }));
marked.use({
  renderer: {
    html(token) {
      return escapeHtml(String(token.text));
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const href = safeLinkHref(token.href);
      if (!href) {
        return label;
      }
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noreferrer">${label}</a>`;
    },
    image(token) {
      const alt = escapeHtml(String(token.text ?? ''));
      const src = safeLinkHref(token.href);
      if (!src) {
        return alt;
      }
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${alt}"${title}>`;
    }
  }
});

export async function renderMarkdown(content: string): Promise<string> {
  return marked.parse(content);
}
