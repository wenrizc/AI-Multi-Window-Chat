import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readJson(relativePath: string): Record<string, { message: string }> {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function collectI18nKeysFromHtml(filePath: string): string[] {
  const html = fs.readFileSync(filePath, 'utf8');
  const regex = /data-i18n(?:-html|-placeholder|-title|-aria-label|-document-title)?="([^"]+)"/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    keys.add(match[1]);
  }
  return [...keys];
}

const requiredKeys = [
  'chat__windowPageTitle',
  'popup__tabLLM',
  'popup__tabSearch',
  'chat__searchToggle',
  'chat__statusInitFailed',
  'chat__statusCreateProviderFirst',
  'chat__statusProviderNotFound',
  'chat__statusCompleted',
  'chat__statusGenerating',
  'chat__statusDecidingSearch',
  'chat__statusSearchingFor',
  'chat__statusStopping',
  'chat__statusStopped',
  'chat__statusPromptUnavailable',
  'chat__statusConfigureTavilyFirst',
  'chat__statusTavilyReturned',
  'chat__errorRequestFailed',
  'chat__errorAuthFailed',
  'chat__errorModelUnavailable',
  'chat__errorTimeout',
  'chat__errorNetwork',
  'chat__errorServiceStatus',
  'chat__errorParseFailed',
  'chat__btnStop',
  'chat__btnCopyMessage',
  'chat__btnCopiedMessage',
  'chat__btnEdit',
  'chat__btnSaveEdit',
  'chat__btnCancelEdit',
  'chat__btnRegenerate',
  'chat__btnRegenerateWithModel',
  'chat__btnBranch',
  'chat__branchSuffix',
  'chat__versionPrev',
  'chat__versionNext',
  'chat__statusBranchOpened',
  'chat__statusBranchFailed',
  'chat__statusRegenerateUnavailable',
  'chat__inputPlaceholder',
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
  'popup__transportHelp',
  'popup__transportHelpAriaLabel',
  'popup__labelReasoningFormat',
  'popup__supportsStreaming',
  'popup__labelDefaultTemperature',
  'popup__reasoningFormatHelp',
  'popup__reasoningFormatHelpAriaLabel',
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
  'popup__emptyProviders',
  'prompt__emptyState',
  'history__searchPlaceholder',
  'history__searchNoResults',
  'onboarding__kicker',
  'onboarding__title',
  'onboarding__intro',
  'onboarding__stepProvider',
  'onboarding__stepCredentials',
  'onboarding__stepLaunch',
  'onboarding__launchCopy',
  'onboarding__skip',
  'onboarding__saveTestLaunch',
  'onboarding__statusMissingFields',
  'onboarding__statusTesting',
  'onboarding__statusReady',
  'onboarding__statusSavedOpenFailed',
  'onboarding__samplePrompt',
  'popup__untitledProvider',
  'prompt__untitled',
  'common__none',
  'common__unknownError',
  'export__updatedAt',
  'export__sources',
  'history__exportFormatJson',
  'content__btnSettings',
  'content__btnDockLeft',
  'content__btnDockRight',
  'content__btnFullscreen',
  'content__btnMinimize',
  'content__btnClose',
  'usage__unavailable',
  'usage__inputTokens',
  'usage__outputTokens',
  'usage__reasoningTokens'
];

describe('locale parity', () => {
  const en = readJson('_locales/en/messages.json');
  const zh = readJson('_locales/zh_CN/messages.json');

  it('defines every required key in both locales', () => {
    for (const key of requiredKeys) {
      expect(en[key], `Missing en key: ${key}`).toBeTruthy();
      expect(zh[key], `Missing zh key: ${key}`).toBeTruthy();
    }
  });

  it('keeps $1 placeholders where the UI substitutes values', () => {
    for (const key of ['chat__statusSearchingFor', 'chat__statusTavilyReturned', 'chat__errorServiceStatus']) {
      expect(en[key].message, `Missing en placeholder in ${key}`).toMatch(/\$1/);
      expect(zh[key].message, `Missing zh placeholder in ${key}`).toMatch(/\$1/);
    }
  });

  it('removes retired keys', () => {
    const retired = [
      'prompt__empty',
      'chat__statusIdle',
      'chat__statusModelNoStreaming',
      'chat__thinking',
      'popup__defaultStreamingEnabled',
      'popup__searchEnabledByDefault'
    ];
    for (const key of retired) {
      expect(key in en, `Retired en key should be removed: ${key}`).toBe(false);
      expect(key in zh, `Retired zh key should be removed: ${key}`).toBe(false);
    }
  });
});

describe('website markers', () => {
  it('resolves every data-i18n key used in website pages', () => {
    const en = readJson('_locales/en/messages.json');
    const zh = readJson('_locales/zh_CN/messages.json');
    const files = [
      path.join(root, 'website/index.html'),
      path.join(root, 'website/privacy-policy.html')
    ];
    for (const filePath of files) {
      for (const key of collectI18nKeysFromHtml(filePath)) {
        expect(en[key], `Missing en website key: ${key}`).toBeTruthy();
        expect(zh[key], `Missing zh website key: ${key}`).toBeTruthy();
      }
    }
  });

  it('keeps website-dist in sync with the source assets', () => {
    const pairs = [
      ['i18n.js', 'website-dist/i18n.js'],
      ['_locales/en/messages.json', 'website-dist/_locales/en/messages.json'],
      ['_locales/zh_CN/messages.json', 'website-dist/_locales/zh_CN/messages.json'],
      ['website/index.html', 'website-dist/index.html'],
      ['website/site-i18n-init.js', 'website-dist/site-i18n-init.js'],
      ['website/privacy-policy.html', 'website-dist/privacy-policy.html']
    ];
    for (const [sourceRel, distRel] of pairs) {
      expect(
        fs.readFileSync(path.join(root, distRel), 'utf8'),
        `${distRel} should match ${sourceRel}. Run npm run build:website.`
      ).toBe(fs.readFileSync(path.join(root, sourceRel), 'utf8'));
    }
  });
});

describe('i18n.js runtime', () => {
  const i18nScript = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');

  it('preserves named placeholder values for extension pages', () => {
    const context = {
      window: {} as Record<string, unknown>,
      chrome: {
        i18n: {
          getUILanguage: () => 'en',
          getMessage(key: string, substitutions?: string | Array<string | number>) {
            if (key !== 'config__statusImported') {
              return key;
            }
            if (!substitutions) {
              return 'Added , updated  items';
            }
            const values = Array.isArray(substitutions) ? substitutions : [substitutions];
            return `Added ${values[0] ?? ''}, updated ${values[1] ?? ''} items`;
          }
        }
      },
      document: {
        documentElement: {
          lang: 'en',
          getAttribute() {
            return null;
          }
        },
        querySelectorAll() {
          return [];
        },
        title: ''
      },
      navigator: { language: 'en' },
      console
    };
    vm.runInNewContext(i18nScript, context);
    const translate = (context.window as { t?: (key: string, substitutions?: Record<string, string>) => string }).t;
    assert.equal(
      translate?.('config__statusImported', { addedCount: '2', updatedCount: '1' }),
      'Added 2, updated 1 items',
      'Named placeholder values should be preserved instead of dropped.'
    );
  });

  it('resolves positional placeholders for the website without chrome.i18n', async () => {
    const context = {
      window: {
        location: { search: '' },
        navigator: { language: 'en' }
      } as Record<string, unknown>,
      document: {
        documentElement: {
          lang: 'en',
          getAttribute() {
            return null;
          }
        },
        querySelectorAll() {
          return [];
        },
        title: ''
      },
      fetch: async () => ({
        ok: true,
        json: async () => ({
          popup__footerVersion: { message: 'Version $1' }
        })
      }),
      URLSearchParams,
      navigator: { language: 'en' },
      console
    };
    vm.runInNewContext(i18nScript, context);
    await (context.window as { initPageTranslations: () => Promise<void> }).initPageTranslations();
    const translate = (context.window as { t?: (key: string, substitutions?: string) => string }).t;
    expect(translate?.('popup__footerVersion', '2.0.0')).toBe('Version 2.0.0');
  });
});
