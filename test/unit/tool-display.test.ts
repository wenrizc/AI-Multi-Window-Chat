import { afterEach, describe, expect, it, vi } from 'vitest';
import zh from '../../_locales/zh_CN/messages.json';
import { formatToolDisplay } from '../../src/shared/tool-display';
import { getChatSession, upsertChatSession } from '../../src/shared/storage';
import { createChromeMock } from '../helpers/chrome-mock';
import { createChatSession, createPersistedMessage } from '../helpers/factories';
import type { SearchSource, ToolCallRecord } from '../../src/shared/types';

afterEach(() => vi.restoreAllMocks());

describe('localized tool display', () => {
  const source: SearchSource = {
    id: 'source', title: 'Forecast', url: 'https://weather.test', snippet: 'Sunny',
    score: null, query: 'weather', credits: 1
  };
  const record: ToolCallRecord = {
    id: 'tool', name: 'web_search', arguments: '{"query":"weather"}', status: 'completed',
    output: 'Query: weather\n\n1. Forecast\nURL: https://weather.test\nSummary: Sunny\n\nCredits: 1',
    display: { kind: 'search', query: 'weather', credits: 1, sources: [source] }
  };

  function useChinese() {
    const mock = createChromeMock({ messages: zh });
    const i18n = mock.chrome.i18n as typeof chrome.i18n;
    vi.spyOn(chrome.i18n, 'getMessage').mockImplementation(i18n.getMessage);
  }

  it('persists UI metadata and translates a restored tool result without altering the protocol', async () => {
    await upsertChatSession(createChatSession({ messages: [createPersistedMessage({ toolCalls: [record] })] }));
    const restored = (await getChatSession('chat-test'))!.messages[0].toolCalls[0];
    expect(restored).toEqual(record);
    useChinese();
    expect(formatToolDisplay(restored)).toBe('查询：weather\n\n1. Forecast\n链接：https://weather.test\n摘要：Sunny\n\n消耗点数：1');
    expect(restored.output).toBe(record.output);
    expect(restored.arguments).toBe(record.arguments);
  });

  it('preserves literal user values and multiline snippets', () => {
    useChinese();
    const custom: ToolCallRecord = { ...record, display: {
      kind: 'search', query: '$& $$ $1', credits: null, sources: [{
        ...source,
        snippet: 'First line\nQuery: verbatim source text'
      }]
    } };
    expect(formatToolDisplay(custom)).toContain('查询：$& $$ $1');
    expect(formatToolDisplay(custom)).toContain('摘要：First line\nQuery: verbatim source text');
  });

  it('localizes both new and legacy tool errors', () => {
    useChinese();
    expect(formatToolDisplay({ ...record, name: 'delete_file', display: { kind: 'unsupported_tool' } })).toBe('不支持的工具：delete_file');
    expect(formatToolDisplay({ ...record, display: { kind: 'invalid_query' } })).toBe('搜索查询不能为空。');
    expect(formatToolDisplay({ ...record, display: undefined, output: 'Expected a non-empty query string.' })).toBe('搜索查询不能为空。');
    expect(formatToolDisplay({ ...record, display: undefined })).toContain('消耗点数：1');
  });

  it('leaves unknown outputs intact and localizes the pending state', () => {
    useChinese();
    expect(formatToolDisplay({ ...record, display: undefined, name: 'other_tool', output: 'Query: raw result' })).toBe('Query: raw result');
    expect(formatToolDisplay({ ...record, display: undefined, status: 'pending', output: null })).toBe('等待工具返回结果...');
  });
});
