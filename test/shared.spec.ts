import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyStore } from '../src/shared/constants';
import {
  addUsage,
  clampSearchRounds,
  escapeHtml,
  formatUsageLabel
} from '../src/shared/utils';
import { normalizeUsagePayload } from '../src/shared/parsers';

function collectI18nKeysFromHtml(filePath: string): string[] {
  const html = fs.readFileSync(filePath, 'utf8');
  const regex = /data-i18n(?:-html|-placeholder|-title|-document-title)?="([^"]+)"/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    keys.add(match[1]);
  }

  return [...keys];
}

export function runSharedTests() {
  const usage = normalizeUsagePayload({
    prompt_tokens: 120,
    completion_tokens: 80,
    total_tokens: 200,
    output_tokens_details: {
      reasoning_tokens: 15
    },
    input_tokens_details: {
      cached_tokens: 12
    }
  });

  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 80,
    reasoningTokens: 15,
    cacheReadTokens: 12,
    totalTokens: 200
  });


  const store = createEmptyStore();
  assert.equal(store.featureSettings.defaultStreaming, true);

  assert.equal(clampSearchRounds(0), 1);
  assert.equal(clampSearchRounds(1), 1);
  assert.equal(clampSearchRounds(2), 2);
  assert.equal(clampSearchRounds(999), 2);
  assert.equal(escapeHtml(`"<tag>" & 'quote'`), '&quot;&lt;tag&gt;&quot; &amp; &#39;quote&#39;');
  assert.deepEqual(
    addUsage(
      {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: null,
        cacheReadTokens: 2,
        totalTokens: 15
      },
      {
        inputTokens: 4,
        outputTokens: 8,
        reasoningTokens: 3,
        cacheReadTokens: null,
        totalTokens: 12
      }
    ),
    {
      inputTokens: 14,
      outputTokens: 13,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      totalTokens: 27
    }
  );

  const messages: Record<string, string> = {
    usage__unavailable: 'Usage unavailable',
    usage__inputTokens: 'In $1',
    usage__outputTokens: 'Out $1',
    usage__reasoningTokens: 'Reason $1'
  };
  const chromeMock = {
    i18n: {
      getMessage(key: string, substitutions?: string | Array<string | number>) {
        const template = messages[key as keyof typeof messages] ?? key;
        const values: Array<string | number> = Array.isArray(substitutions) ? substitutions : substitutions ? [substitutions] : [];
        let result = template;
        values.forEach((value, index) => {
          result = result.replace(`$${index + 1}`, String(value));
        });
        return result;
      },
      getAcceptLanguages(callback?: (languages: string[]) => void) {
        const languages = ['en'];
        callback?.(languages);
        return Promise.resolve(languages);
      },
      getUILanguage() {
        return 'en';
      },
      detectLanguage(_text: string, callback?: (result: chrome.i18n.LanguageDetectionResult) => void) {
        const result = { isReliable: true, languages: [{ language: 'en', percentage: 100 }] };
        callback?.(result);
        return Promise.resolve(result);
      }
    }
  };
  (globalThis as { chrome?: typeof chrome }).chrome = chromeMock as unknown as typeof chrome;

  assert.equal(formatUsageLabel(null), 'Usage unavailable');
  assert.equal(
    formatUsageLabel({
      inputTokens: 120,
      outputTokens: 80,
      reasoningTokens: 15,
      cacheReadTokens: null,
      totalTokens: 215
    }),
    'In 120 | Out 80 | Reason 15'
  );
}

function runI18nTests() {
  const en = JSON.parse(fs.readFileSync(path.join(process.cwd(), '_locales/en/messages.json'), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(path.join(process.cwd(), '_locales/zh_CN/messages.json'), 'utf8'));
  const requiredKeys = [
    'chat__windowPageTitle',
    'popup__tabLLM',
    'popup__tabSearch',
    'chat__searchToggle',
    'chat__statusIdle',
    'chat__statusInitFailed',
    'chat__statusCreateProviderFirst',
    'chat__statusProviderNotFound',
    'chat__statusCompleted',
    'chat__statusGenerating',
    'chat__statusDecidingSearch',
    'chat__statusSearchingFor',
    'chat__statusConfigureTavilyFirst',
    'chat__statusTavilyReturned',
    'chat__btnStop',
    'chat__reasoningSummary',
    'chat__settingsModel',
    'chat__settingsPrompt',
    'chat__settingsSearch',
    'chat__settingsStreaming',
    'chat__streamingToggle',
    'chat__toolCalls',
    'chat__toolStatusPending',
    'chat__toolStatusDone',
    'chat__toolStatusCompleted',
    'chat__toolStatusFailed',
    'chat__toolWaiting',
    'chat__noProvider',
    'popup__labelTransport',
    'popup__labelReasoningFormat',
    'popup__supportsStreaming',
    'popup__labelDefaultTemperature',
    'popup__labelTavilyApiKey',
    'popup__labelSearchDepth',
    'popup__labelMaxSearchResults',
    'popup__labelMaxSearchRounds',
    'popup__labelTimeRange',
    'popup__timeRangeDay',
    'popup__timeRangeWeek',
    'popup__timeRangeMonth',
    'popup__timeRangeYear',
    'popup__timeRangeAll',
    'popup__searchEnabledByDefault',
    'popup__defaultStreamingEnabled',
    'popup__emptyProviders',
    'prompt__emptyState',
    'popup__untitledProvider',
    'prompt__untitled',
    'common__none',
    'common__unknownError',
    'export__updatedAt',
    'export__sources',
    'content__btnSettings',
    'content__btnMinimize',
    'content__btnClose',
    'usage__unavailable',
    'usage__inputTokens',
    'usage__outputTokens',
    'usage__reasoningTokens'
  ];

  for (const key of requiredKeys) {
    assert.ok(en[key], `Missing en key: ${key}`);
    assert.ok(zh[key], `Missing zh key: ${key}`);
  }

  assert.equal('prompt__empty' in en, false);
  assert.equal('prompt__empty' in zh, false);

  const websiteFiles = [
    path.join(process.cwd(), 'website/index.html'),
    path.join(process.cwd(), 'website/privacy-policy.html')
  ];

  for (const filePath of websiteFiles) {
    for (const key of collectI18nKeysFromHtml(filePath)) {
      assert.ok(en[key], `Missing en website key: ${key}`);
      assert.ok(zh[key], `Missing zh website key: ${key}`);
    }
  }
}

export function runAllTests() {
  runSharedTests();
  runI18nTests();
}
