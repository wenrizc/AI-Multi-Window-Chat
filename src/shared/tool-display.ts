import type { ToolCallRecord } from './types';
import { i18nMessage } from './utils';

/** Format UI text without modifying the tool response replayed to the model. */
export function formatToolDisplay(record: ToolCallRecord): string {
  if (record.display?.kind === 'unsupported_tool'
    || record.output === `Unsupported tool: ${record.name}`) {
    return i18nMessage('chat__toolUnsupported', record.name);
  }
  if (record.display?.kind === 'invalid_query'
    || record.output === 'Expected a non-empty query string.') {
    return i18nMessage('chat__toolInvalidQuery');
  }
  if (record.display?.kind === 'search') {
    const { query, sources, credits } = record.display;
    const lines = [i18nMessage('chat__toolQuery', query)];
    sources.forEach((source, index) => {
      lines.push('', `${index + 1}. ${source.title}`, i18nMessage('chat__toolUrl', source.url));
      if (source.snippet) lines.push(i18nMessage('chat__toolSummary', source.snippet));
    });
    if (credits !== null) lines.push('', i18nMessage('chat__toolCredits', credits));
    return lines.join('\n');
  }
  // Older sessions only stored the protocol text. Translate its known labels
  // in the view, while preserving all stored content and unknown tool output.
  if (record.name === 'web_search' && record.output?.startsWith('Query: ')) {
    const keys: Record<string, string> = {
      Query: 'chat__toolQuery', URL: 'chat__toolUrl', Summary: 'chat__toolSummary', Credits: 'chat__toolCredits'
    };
    return record.output.replace(/^(Query|URL|Summary|Credits): (.*)$/gm,
      (_line, label: string, value: string) => i18nMessage(keys[label], value));
  }
  return record.output || i18nMessage('chat__toolWaiting');
}
