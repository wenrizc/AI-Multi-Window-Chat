import { describe, expect, it } from 'vitest';
import { mergePromptsForImport, mergeProvidersForImport } from '../../src/shared/imports';
import {
  addUsage,
  clampSearchRounds,
  compactText,
  createUsageMetrics,
  escapeHtml,
  formatUsageLabel,
  getModel,
  i18nMessage,
  isDeepSeekModelId,
  mergeUsage,
  normalizeBaseUrl,
  resolveReasoningFormat,
  toNullableInt,
  toNullableNumber,
  uid,
  writeTextToClipboard
} from '../../src/shared/utils';
import type { PromptConfig, ProviderConfig, UsageMetrics } from '../../src/shared/types';
import { createModel, createPrompt, createProvider } from '../helpers/factories';

function providerFixture(id: string, name: string): ProviderConfig {
  return createProvider({
    id,
    name,
    baseUrl: `https://${id}.example/v1`,
    apiKey: `${id}-key`,
    defaultModel: `${id}-model`,
    modelCatalog: [createModel({ modelId: `${id}-model`, displayName: `${id}-model` })]
  });
}

function promptFixture(id: string, name: string): PromptConfig {
  return createPrompt({ id, name, content: `${name} content` });
}

describe('numeric normalization', () => {
  it('coerces nullable numbers and rejects blanks/garbage', () => {
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
    expect(toNullableNumber('')).toBeNull();
    expect(toNullableNumber('  ')).toBe(0);
    expect(toNullableNumber('abc')).toBeNull();
    expect(toNullableNumber('12.5')).toBe(12.5);
    expect(toNullableNumber(Infinity)).toBeNull();
  });

  it('floors non-negative integers and rejects negatives', () => {
    expect(toNullableInt('6.9')).toBe(6);
    expect(toNullableInt(-3)).toBeNull();
    expect(toNullableInt('')).toBeNull();
  });

});

describe('clampSearchRounds', () => {
  it('clamps to the 1..2 range', () => {
    expect(clampSearchRounds(0)).toBe(1);
    expect(clampSearchRounds(1)).toBe(1);
    expect(clampSearchRounds(2)).toBe(2);
    expect(clampSearchRounds(999)).toBe(2);
  });

  it('falls back to 1 for non-finite input', () => {
    expect(clampSearchRounds(Number.NaN)).toBe(1);
    expect(clampSearchRounds(null)).toBe(1);
    expect(clampSearchRounds(undefined)).toBe(1);
  });
});

describe('escapeHtml', () => {
  it('escapes every dangerous character', () => {
    expect(escapeHtml(`"<tag>" & 'quote'`)).toBe('&quot;&lt;tag&gt;&quot; &amp; &#39;quote&#39;');
  });
});

describe('usage metrics', () => {
  it('returns null when no numeric field is present', () => {
    expect(createUsageMetrics(null)).toBeNull();
    expect(createUsageMetrics({})).toBeNull();
    expect(createUsageMetrics({ inputTokens: null, outputTokens: null })).toBeNull();
  });

  it('adds usage field-by-field, treating null as zero when the other side has a value', () => {
    expect(
      addUsage(
        { inputTokens: 10, outputTokens: 5, reasoningTokens: null, cacheReadTokens: 2, totalTokens: 15 },
        { inputTokens: 4, outputTokens: 8, reasoningTokens: 3, cacheReadTokens: null, totalTokens: 12 }
      )
    ).toEqual({
      inputTokens: 14,
      outputTokens: 13,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      totalTokens: 27
    });
  });

  it('returns the non-null side when one operand is missing', () => {
    const usage: UsageMetrics = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: null,
      cacheReadTokens: null,
      totalTokens: 3
    };
    expect(addUsage(null, usage)).toEqual(usage);
    expect(addUsage(usage, null)).toEqual(usage);
  });

  it('merges usage preferring the next non-null values', () => {
    const base: UsageMetrics = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 5
    };
    expect(mergeUsage(base, { ...base, outputTokens: 9, reasoningTokens: null })).toEqual({
      inputTokens: 1,
      outputTokens: 9,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 5
    });
  });
});

describe('imports merge', () => {
  it('updates providers by id and appends new ones', () => {
    const existing = providerFixture('provider-existing', 'Old Provider');
    const imported = providerFixture('provider-existing', 'Updated Provider');
    const added = providerFixture('provider-new', 'New Provider');

    const result = mergeProvidersForImport([existing], [imported, added]);

    expect(result.providers.map((provider) => provider.id)).toEqual(['provider-existing', 'provider-new']);
    expect(result.providers[0].name).toBe('Updated Provider');
    expect(result.addedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
  });

  it('updates prompts by id and appends new ones', () => {
    const existing = promptFixture('prompt-existing', 'Old Prompt');
    const imported = promptFixture('prompt-existing', 'Updated Prompt');
    const added = promptFixture('prompt-new', 'New Prompt');

    const result = mergePromptsForImport([existing], [imported, added]);

    expect(result.prompts.map((prompt) => prompt.id)).toEqual(['prompt-existing', 'prompt-new']);
    expect(result.prompts[0].name).toBe('Updated Prompt');
    expect(result.addedCount).toBe(1);
    expect(result.updatedCount).toBe(1);
  });
});

describe('getModel', () => {
  it('prefers the requested model id', () => {
    const provider = createProvider({
      defaultModel: 'a',
      modelCatalog: [createModel({ modelId: 'a' }), createModel({ modelId: 'b' })]
    });
    expect(getModel(provider, 'b')?.modelId).toBe('b');
  });

  it('falls back to the default model', () => {
    const provider = createProvider({
      defaultModel: 'b',
      modelCatalog: [createModel({ modelId: 'a' }), createModel({ modelId: 'b' })]
    });
    expect(getModel(provider)?.modelId).toBe('b');
  });

  it('falls back to the first catalog entry for unknown ids', () => {
    const provider = createProvider({
      defaultModel: 'missing',
      modelCatalog: [createModel({ modelId: 'first' })]
    });
    expect(getModel(provider, 'nope')?.modelId).toBe('first');
  });

  it('returns null when the catalog is empty', () => {
    const provider = createProvider({ modelCatalog: [] });
    expect(getModel(provider, 'anything')).toBeNull();
  });
});

describe('i18n formatting', () => {
  it('formats usage labels with the shipped locale', () => {
    expect(formatUsageLabel(null)).toBe('Usage unavailable');
    expect(
      formatUsageLabel({
        inputTokens: 120,
        outputTokens: 80,
        reasoningTokens: 15,
        cacheReadTokens: null,
        totalTokens: 215
      })
    ).toBe('In 120 | Out 80 | Reason 15');
  });

  it('omits null usage fields', () => {
    expect(
      formatUsageLabel({
        inputTokens: 120,
        outputTokens: null,
        reasoningTokens: null,
        cacheReadTokens: null,
        totalTokens: null
      })
    ).toBe('In 120');
  });

  it('substitutes named placeholders through chrome.i18n', () => {
    expect(i18nMessage('config__statusImported', { addedCount: '2', updatedCount: '1' })).toBe(
      'Added 2, updated 1 items'
    );
  });

  it('falls back to the key when a message is missing', () => {
    expect(i18nMessage('definitely__missing__key')).toBe('definitely__missing__key');
  });
});

describe('small utilities', () => {
  it('normalizes base urls', () => {
    expect(normalizeBaseUrl(' https://api.test/v1/ ')).toBe('https://api.test/v1');
  });

  it('compacts text', () => {
    expect(compactText('  a\r\nb  ')).toBe('a\nb');
    expect(compactText('   ')).toBeNull();
    expect(compactText(null)).toBeNull();
  });

  it('detects deepseek model ids case-insensitively', () => {
    expect(isDeepSeekModelId('DeepSeek-V4')).toBe(true);
    expect(isDeepSeekModelId('qwen-plus')).toBe(false);
  });

  it('resolves reasoning formats against the allow-list', () => {
    expect(resolveReasoningFormat('openai_summary')).toBe('openai_summary');
    expect(resolveReasoningFormat('reasoning_content')).toBe('reasoning_content');
    expect(resolveReasoningFormat('anything-else')).toBe('none');
  });

  it('generates unique prefixed ids', () => {
    const first = uid('chat');
    const second = uid('chat');
    expect(first.startsWith('chat-')).toBe(true);
    expect(first).not.toBe(second);
  });
});

describe('writeTextToClipboard', () => {
  it('uses the async clipboard API when available', async () => {
    let copiedText = '';
    const env = {
      navigator: {
        clipboard: {
          async writeText(value: string) {
            copiedText = value;
          }
        }
      }
    };

    const copied = await writeTextToClipboard('assistant reply', env as never);
    expect(copied).toBe(true);
    expect(copiedText).toBe('assistant reply');
  });

  it('falls back to execCommand when the clipboard API rejects', async () => {
    const events: string[] = [];
    const textarea = {
      value: '',
      style: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        events.push(`attr:${name}=${value}`);
      },
      focus() {
        events.push('focus');
      },
      select() {
        events.push('select');
      }
    };
    const body = {
      appendChild(node: unknown) {
        events.push(`append:${String(node === textarea)}`);
      },
      removeChild(node: unknown) {
        events.push(`remove:${String(node === textarea)}`);
      }
    };
    const env = {
      navigator: {
        clipboard: {
          async writeText() {
            throw new Error('clipboard denied');
          }
        }
      },
      document: {
        body,
        createElement(tagName: string) {
          expect(tagName).toBe('textarea');
          return textarea;
        },
        execCommand(command: string) {
          events.push(`exec:${command}`);
          return true;
        }
      }
    };

    const copied = await writeTextToClipboard('fallback copy', env as never);
    expect(copied).toBe(true);
    expect(textarea.value).toBe('fallback copy');
    expect(events).toEqual([
      'attr:readonly=',
      'append:true',
      'focus',
      'select',
      'exec:copy',
      'remove:true'
    ]);
  });

  it('reports failure when the clipboard API throws and no fallback document exists', async () => {
    const copied = await writeTextToClipboard('x', {
      navigator: {
        clipboard: {
          async writeText() {
            throw new Error('denied');
          }
        }
      }
    } as never);
    expect(copied).toBe(false);
  });
});
