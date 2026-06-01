import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createEmptyStore } from '../src/shared/constants';
import {
  addUsage,
  clampSearchRounds,
  escapeHtml,
  formatUsageLabel,
  i18nMessage,
  normalizeMaxContextMessages,
  sliceMessageWindow,
  writeTextToClipboard
} from '../src/shared/utils';
import { normalizeUsagePayload } from '../src/shared/parsers';
import { completeProviderTurn } from '../src/providers/openai-compatible';
import type { ModelConfig, ProviderConfig } from '../src/shared/types';

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

export async function runSharedTests() {
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
  assert.equal(store.featureSettings.search.enabledByDefault, false);
  assert.equal(store.featureSettings.defaultStreaming, false);

  assert.equal(normalizeMaxContextMessages(''), null);
  assert.equal(normalizeMaxContextMessages(0), null);
  assert.equal(normalizeMaxContextMessages('6'), 6);
  assert.deepEqual(sliceMessageWindow([1, 2, 3, 4], null), [1, 2, 3, 4]);
  assert.deepEqual(sliceMessageWindow([1, 2, 3, 4], 2), [3, 4]);

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
    usage__reasoningTokens: 'Reason $1',
    config__statusImported: 'Added $1, updated $2 items'
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
  assert.equal(
    i18nMessage('config__statusImported', { addedCount: '2', updatedCount: '1' }),
    'Added 2, updated 1 items'
  );

  {
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
    assert.equal(copied, true);
    assert.equal(copiedText, 'assistant reply');
  }

  {
    const events: string[] = [];
    const body = {
      appendChild(node: unknown) {
        events.push(`append:${String(node === textarea)}`);
      },
      removeChild(node: unknown) {
        events.push(`remove:${String(node === textarea)}`);
      }
    };
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
          assert.equal(tagName, 'textarea');
          return textarea;
        },
        execCommand(command: string) {
          events.push(`exec:${command}`);
          return true;
        }
      }
    };

    const copied = await writeTextToClipboard('fallback copy', env as never);
    assert.equal(copied, true);
    assert.equal(textarea.value, 'fallback copy');
    assert.deepEqual(events, [
      'attr:readonly=',
      'append:true',
      'focus',
      'select',
      'exec:copy',
      'remove:true'
    ]);
  }

  {
    const originalFetch = globalThis.fetch;
    const provider: ProviderConfig = {
      id: 'provider-test',
      name: 'Provider Test',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      transport: 'chat_completions',
      defaultModel: 'test-model',
      defaultGenerationParams: { temperature: null },
      headers: {},
      modelCatalog: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const model: ModelConfig = {
      modelId: 'test-model',
      displayName: 'Test Model',
      supportsStreaming: false,
      maxContextMessages: null,
      reasoningFormat: 'none'
    };
    const dsml = '<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="web_search"> <｜｜DSML｜｜parameter name="query" string="true">北京天气预报 2025年1月30日</｜｜DSML｜｜parameter> </｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>';

    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: dsml
            }
          }
        ]
      })
    })) as typeof fetch;

    try {
      const turn = await completeProviderTurn({
        provider,
        model,
        messages: [{ role: 'user', content: '查北京天气' }],
        generationParams: { temperature: null },
        signal: new AbortController().signal,
        tools: [{
          type: 'function',
          name: 'web_search',
          description: 'Search the web',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            },
            required: ['query']
          }
        }],
        toolChoice: 'auto'
      });

      assert.equal(turn.content, '');
      assert.deepEqual(turn.toolCalls, [
        {
          id: 'dsml_call_1',
          name: 'web_search',
          arguments: JSON.stringify({ query: '北京天气预报 2025年1月30日' })
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
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
    'chat__statusStopping',
    'chat__statusStopped',
    'chat__statusModelNoStreaming',
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
    'chat__inputPlaceholder',
    'chat__reasoningSummary',
    'chat__settingsModel',
    'chat__settingsPrompt',
    'chat__settingsSearch',
    'chat__settingsStreaming',
    'chat__settingsContextWindow',
    'chat__streamingToggle',
    'chat__maxContextMessagesPlaceholder',
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
    'popup__labelMaxContextMessages',
    'popup__labelDefaultTemperature',
    'popup__reasoningFormatHelp',
    'popup__reasoningFormatHelpAriaLabel',
    'popup__maxContextMessagesPlaceholder',
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

  for (const key of requiredKeys) {
    assert.ok(en[key], `Missing en key: ${key}`);
    assert.ok(zh[key], `Missing zh key: ${key}`);
  }

  for (const key of ['chat__statusSearchingFor', 'chat__statusTavilyReturned', 'chat__errorServiceStatus']) {
    assert.match(en[key].message, /\$1/, `Missing en placeholder in ${key}`);
    assert.match(zh[key].message, /\$1/, `Missing zh placeholder in ${key}`);
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

  const i18nScript = fs.readFileSync(path.join(process.cwd(), 'i18n.js'), 'utf8');
  const scriptContext = {
    window: {} as Record<string, unknown>,
    chrome: {
      i18n: {
        getUILanguage() {
          return 'en';
        },
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
  vm.runInNewContext(i18nScript, scriptContext);
  const translate = (scriptContext.window as { t?: (key: string, substitutions?: Record<string, string>) => string }).t;
  assert.equal(
    translate?.('config__statusImported', { addedCount: '2', updatedCount: '1' }),
    'Added 2, updated 1 items',
    'Extension-page translations should preserve named placeholder values instead of dropping them.'
  );
}

function runChatWindowLayoutTests() {
  const html = fs.readFileSync(path.join(process.cwd(), 'chat-window.html'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'chat-window.css'), 'utf8');
  const chatTs = fs.readFileSync(path.join(process.cwd(), 'src/chat/index.ts'), 'utf8');

  assert.match(
    html,
    /<div class="chat-settings-panel chat-settings-popover"[^>]*id="settingsPanel"[^>]*hidden>/,
    'Chat settings should render as a floating popover panel.'
  );
  assert.match(
    css,
    /\.chat-container\s*\{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);[^}]*grid-auto-rows:\s*min-content;/s,
    'Chat layout should give only the messages area remaining height and auto-size bottom controls.'
  );
  assert.match(
    css,
    /\.chat-settings-popover\s*\{[^}]*position:\s*absolute;/s,
    'Chat settings panel should be positioned independently from the bottom composer.'
  );
  assert.match(
    css,
    /#messageInput\s*\{[^}]*min-height:\s*40px;/s,
    'Message input should use the compact single-line height.'
  );
  assert.match(
    css,
    /\.send-btn\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/s,
    'Send button should match the compact composer height.'
  );
  assert.equal(
    html.includes('class="chat-status-bar"'),
    false,
    'Idle/status bar should not reserve space above the composer.'
  );
  assert.equal(html.includes('id="statusText"'), false, 'Hidden status text should be removed entirely.');
  assert.match(
    html,
    /<div id="composerStatus" class="composer-status" role="status" aria-live="polite" hidden>/,
    'Composer status should live inside the input composer and stay hidden while idle.'
  );
  assert.match(html, /id="composerStatusText"/, 'Composer status should have a dedicated visible text node.');
  assert.match(
    html,
    /<input id="maxContextMessagesInput"[^>]*data-i18n-placeholder="chat__maxContextMessagesPlaceholder"/,
    'Chat settings should expose a session-level context window input.'
  );
  assert.match(
    css,
    /\.message-footer\s*\{[^}]*justify-content:\s*space-between;/s,
    'Assistant message footers should separate usage text from footer actions.'
  );
  assert.match(
    css,
    /\.message-copy-btn\s*\{[^}]*border-radius:\s*999px;[^}]*cursor:\s*pointer;[^}]*justify-content:\s*center;/s,
    'Assistant message footers should style the copy action as a pill-shaped icon button.'
  );
  assert.match(
    chatTs,
    /chat__btnCopyMessage/,
    'Chat logic should render a localized copy button for assistant messages.'
  );
  assert.match(
    chatTs,
    /message-copy-icon/,
    'Chat logic should render an icon inside the assistant message copy button.'
  );
  assert.match(
    chatTs,
    /writeTextToClipboard\(/,
    'Copying an assistant response should use the shared clipboard helper so fallback copy paths work.'
  );
  assert.match(
    chatTs,
    /chat__btnCopiedMessage/,
    'Chat logic should expose a copied state for the assistant message copy button.'
  );
  assert.equal(css.includes('.sr-only'), false, 'No hidden status-only utility should remain in chat CSS.');
  assert.match(css, /\.composer-status\[hidden\]\s*\{[^}]*display:\s*none;/s, 'Composer status should not reserve space while idle.');
  assert.match(css, /\.composer-status\[data-variant="busy"\]/, 'Composer status should style active running state.');
  assert.match(css, /\.composer-status\[data-variant="warning"\]/, 'Composer status should style configuration warnings.');
  assert.match(css, /\.composer-status\[data-variant="error"\]/, 'Composer status should style request failures.');
  assert.equal(chatTs.includes('statusText'), false, 'Chat logic should not depend on a removed status element.');
  assert.equal(chatTs.includes('setStatus('), false, 'Chat logic should not write hidden status text.');
  assert.match(chatTs, /setComposerStatus\(/, 'Chat logic should render visible inline composer statuses.');
  assert.match(chatTs, /clearComposerStatus\(/, 'Chat logic should be able to hide idle composer statuses.');
  assert.match(chatTs, /COMPOSER_STATUS_AUTO_HIDE_MS\s*=\s*1000/, 'Completed and stopped statuses should auto-hide after 1 second.');
  assert.match(chatTs, /case 'statusUpdate':[\s\S]*this\.setComposerStatus\(event\.message, 'busy'\)/, 'Stream status updates should be shown inline.');
  assert.match(chatTs, /case 'completed':[\s\S]*chat__statusCompleted[\s\S]*COMPOSER_STATUS_AUTO_HIDE_MS/, 'Completed status should be shown briefly.');
  assert.match(chatTs, /case 'aborted':[\s\S]*chat__statusStopped[\s\S]*COMPOSER_STATUS_AUTO_HIDE_MS/, 'Stopped status should be shown briefly.');
  assert.match(chatTs, /formatChatFailure\(/, 'Request failures should be mapped to localized messages.');
  assert.equal(html.includes('id="stopBtn"'), false, 'Stop should be handled by the primary send button.');
  assert.match(html, /class="send-icon"/, 'Send button should include a send icon state.');
  assert.match(html, /class="stop-icon"/, 'Send button should include a stop icon state.');
  assert.match(css, /\.send-btn\.is-loading\s*\{[^}]*background:\s*var\(--danger\);/s, 'Send button should visibly become the stop control while loading.');
  assert.match(chatTs, /handlePrimaryAction\(\)/, 'Primary button should route between send and stop actions.');
  assert.match(chatTs, /sendBtn\.classList\.toggle\('is-loading', active\)/, 'Loading state should be reflected on the primary button.');
  assert.match(
    chatTs,
    /try\s*\{[\s\S]*this\.port\.postMessage\(/,
    'Chat sends should guard request setup and dispatch after entering loading state.'
  );
  assert.match(
    chatTs,
    /catch \(error\)\s*\{[\s\S]*this\.resetLoadingState\(\);[\s\S]*this\.setComposerStatus\(this\.formatChatFailure\(getErrorMessage\(error\)\), 'error'\);[\s\S]*\}/,
    'Chat sends should recover from synchronous send failures instead of leaving the UI generating forever.'
  );
  assert.match(chatTs, /private streamingOverride: boolean \| null = null;/, 'Chat state should track per-session streaming overrides.');
  assert.match(chatTs, /private maxContextMessagesOverride: number \| null = null;/, 'Chat state should track per-session message-window overrides.');
  assert.match(chatTs, /this\.elements\.streamingToggle\.addEventListener\('change'/, 'Chat settings should allow session-level streaming overrides.');
  assert.match(chatTs, /this\.elements\.maxContextMessagesInput\.addEventListener\('change'/, 'Chat settings should allow session-level context window overrides.');
  assert.match(chatTs, /sliceMessageWindow\(/, 'Chat requests should apply a sliding message window before sending.');
  assert.match(chatTs, /streamingOverride:\s*this\.streamingOverride/, 'Chat requests should persist the per-session streaming override.');
  assert.match(chatTs, /maxContextMessagesOverride:\s*this\.maxContextMessagesOverride/, 'Chat requests should persist the per-session context window override.');
  assert.match(
    css,
    /\.message-assistant\s+\.message-content\s*\{[^}]*white-space:\s*normal;[^}]*display:\s*flow-root;/s,
    'Assistant markdown output should not render parser whitespace as visible top gaps.'
  );
  assert.match(
    css,
    /\.message-user\s+\.message-content\s*\{[^}]*white-space:\s*pre-wrap;/s,
    'User messages should still preserve typed line breaks.'
  );
  assert.match(
    css,
    /\.message-content\s*>\s*:first-child\s*\{[^}]*margin-top:\s*0;/s,
    'Rendered message blocks should not create a top edge gap.'
  );
  assert.match(
    css,
    /\.message-content\s+(ul|ol),\s*\.message-content\s+(ul|ol)\s*\{[^}]*padding-left:\s*1\.2em;/s,
    'Rendered markdown lists should keep readable indentation after the global reset.'
  );
}

function runSettingsSurfaceLayoutTests() {
  const popupHtml = fs.readFileSync(path.join(process.cwd(), 'popup.html'), 'utf8');
  const popupTs = fs.readFileSync(path.join(process.cwd(), 'src/popup/index.ts'), 'utf8');
  const chatTs = fs.readFileSync(path.join(process.cwd(), 'src/chat/index.ts'), 'utf8');
  const contentTs = fs.readFileSync(path.join(process.cwd(), 'src/content/index.ts'), 'utf8');
  const backgroundTs = fs.readFileSync(path.join(process.cwd(), 'src/background/index.ts'), 'utf8');
  const providerTs = fs.readFileSync(path.join(process.cwd(), 'src/providers/openai-compatible.ts'), 'utf8');

  assert.match(
    popupHtml,
    /body\s*\{[^}]*width:\s*568px;[^}]*min-width:\s*568px;/s,
    'Extension settings popup should keep a stable width instead of collapsing to a narrow strip.'
  );
  assert.match(popupHtml, /id="onboardingModal"/, 'First-run setup should render a dedicated onboarding modal.');
  assert.match(
    popupHtml,
    /data-onboarding-preset="openai"[\s\S]*data-onboarding-preset="deepseek"[\s\S]*data-onboarding-preset="qwen"/,
    'Onboarding should offer OpenAI, DeepSeek, and Qwen provider presets.'
  );
  assert.match(popupHtml, /id="onboardingApiKey"/, 'Onboarding should collect the API key in the wizard.');
  assert.match(popupHtml, /id="onboardingModelName"/, 'Onboarding should collect or confirm the model name in the wizard.');
  assert.match(popupHtml, /id="onboardingSaveTestBtn"/, 'Onboarding should expose a save, test, and launch action.');
  assert.match(
    popupTs,
    /maybeShowOnboarding\(\)/,
    'Popup logic should decide whether to show onboarding when no provider exists.'
  );
  assert.match(
    popupTs,
    /completeOnboarding\(\)/,
    'Popup logic should save the onboarding provider and run the completion flow.'
  );
  assert.match(
    popupTs,
    /type:\s*'OPEN_CHAT_WINDOW'[\s\S]*initialMessage:/,
    'Completing onboarding should open a sample chat on the active page.'
  );
  assert.match(popupHtml, /id="historySearchInput"/, 'History should include a search input.');
  assert.match(
    popupTs,
    /private historySearchTerm = '';/,
    'Popup logic should track the current history search query.'
  );
  assert.match(
    popupTs,
    /historySearchInput\.addEventListener\('input'/,
    'History search should filter as the user types.'
  );
  assert.match(
    popupTs,
    /filteredHistory\s*=/,
    'History rendering should use a filtered chat list rather than always showing all chats.'
  );
  assert.match(
    popupHtml,
    /html,\s*body\s*\{[^}]*height:\s*auto;/s,
    'Settings popup should use natural height so footer cannot overlap overflowing tab content.'
  );
  assert.match(
    popupHtml,
    /--panel-list-height:\s*360px;/,
    'Settings panels should use compact, shared panel height.'
  );
  assert.match(
    popupHtml,
    /\.tab-content\.active\s*\{[^}]*display:\s*block;/s,
    'Active settings tab should use natural block flow instead of a compressed flex column.'
  );
  assert.match(
    popupHtml,
    /\.field-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    'LLM settings fields should use one control per row.'
  );
  assert.match(
    popupHtml,
    /\.search-grid\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    'Search settings fields should use one control per row.'
  );
  assert.match(
    popupHtml,
    /id="supportsStreamingCheckbox"[\s\S]*data-i18n="popup__supportsStreaming"/,
    'LLM settings should expose a per-model streaming option.'
  );
  assert.match(
    popupHtml,
    /id="maxContextMessagesInput"[\s\S]*data-i18n-placeholder="popup__maxContextMessagesPlaceholder"/,
    'LLM settings should expose a per-model context window input.'
  );
  assert.equal(popupHtml.includes('id="searchEnabledByDefaultCheckbox"'), false, 'Search settings should not expose default search toggle.');
  assert.equal(popupHtml.includes('id="defaultStreamingCheckbox"'), false, 'Search settings should not expose default streaming toggle.');
  assert.match(
    popupTs,
    /supportsStreamingCheckbox:[\s\S]*getElementById\('supportsStreamingCheckbox'\)/,
    'Popup logic should bind the per-model streaming checkbox.'
  );
  assert.match(
    popupTs,
    /supportsStreaming:\s*elements\.supportsStreamingCheckbox\.checked/,
    'Saving a provider should persist the per-model streaming setting.'
  );
  assert.match(
    popupTs,
    /maxContextMessagesInput:[\s\S]*getElementById\('maxContextMessagesInput'\)/,
    'Popup logic should bind the per-model context window input.'
  );
  assert.match(
    popupTs,
    /maxContextMessages:\s*normalizeMaxContextMessages\(elements\.maxContextMessagesInput\.value\)/,
    'Saving a provider should persist the per-model context window setting.'
  );
  assert.match(
    chatTs,
    /model\?\.supportsStreaming/,
    'Chat settings should still default session streaming from the model configuration.'
  );
  assert.doesNotMatch(
    chatTs,
    /this\.elements\.streamingToggle\.disabled\s*=\s*true;/,
    'Chat settings should no longer lock streaming to the model setting.'
  );
  assert.match(
    providerTs,
    /const shouldStream = input\.streamingEnabled !== false;/,
    'Provider requests should respect the resolved session streaming setting.'
  );
  assert.match(
    popupHtml,
    /class="[^"]*transport-help[^"]*"[\s\S]*data-i18n-aria-label="popup__transportHelpAriaLabel"[\s\S]*data-i18n-html="popup__transportHelp"/,
    'Transport should include a hover help popover.'
  );
  assert.match(
    popupHtml,
    /\.transport-help:hover\s+\.transport-tooltip/s,
    'Transport help should show the popover on hover.'
  );
  assert.match(
    popupHtml,
    /class="[^"]*reasoning-help[^"]*"[\s\S]*data-i18n-aria-label="popup__reasoningFormatHelpAriaLabel"[\s\S]*data-i18n-html="popup__reasoningFormatHelp"/,
    'Reasoning format should include a hover help popover.'
  );
  assert.match(
    fs.readFileSync(path.join(process.cwd(), 'i18n.js'), 'utf8'),
    /querySelectorAll\('\[data-i18n-aria-label\]'\)/,
    'Shared i18n should translate aria-label attributes.'
  );
  assert.match(
    popupHtml,
    /\.reasoning-help:hover\s+\.reasoning-tooltip/s,
    'Reasoning help should show the popover on hover.'
  );
  assert.match(
    popupHtml,
    /\.footer\s*\{[^}]*background:\s*transparent;[^}]*border:\s*none;[^}]*box-shadow:\s*none;/s,
    'Footer version text should sit directly on the popup background, not inside a card.'
  );
  assert.equal(popupHtml.includes('data-format="text"'), false, 'Text export format should be removed.');
  assert.match(popupHtml, /data-format="json"/, 'Exports should offer JSON format.');
  assert.match(popupHtml, /data-format="markdown"/, 'Exports should offer Markdown format.');
  assert.match(popupHtml, /accept="\.json,\s*\.md,\s*\.markdown"/, 'Config imports should accept JSON and Markdown files.');
  assert.doesNotMatch(
    popupHtml,
    /\.tab-content\s*\{[^}]*flex:\s*1 1 auto;/s,
    'Settings tabs should not flex-shrink around fixed-height inner panels.'
  );
  assert.doesNotMatch(
    popupHtml,
    /\.config-grid\s*\{[^}]*flex:\s*1 1 auto;/s,
    'Settings grids should not use flex sizing inside the popup.'
  );
  assert.doesNotMatch(
    popupHtml,
    /\.footer\s*\{[^}]*position:\s*(fixed|absolute|sticky)/s,
    'Settings footer should remain in normal document flow.'
  );
  assert.doesNotMatch(
    popupHtml,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?body\s*\{[\s\S]*?width:\s*100%;/s,
    'The desktop-sized extension popup breakpoint should not override body width to 100%.'
  );
  assert.match(
    contentTs,
    /DEFAULT_WINDOW_WIDTH\s*=\s*460/,
    'Injected chat windows should define an explicit default width in script, not only CSS.'
  );
  assert.match(
    contentTs,
    /wrapper\.style\.width\s*=\s*`\$\{AIMultiWindow\.DEFAULT_WINDOW_WIDTH\}px`;/,
    'Injected chat windows should set their initial width inline to resist host-page CSS.'
  );
  assert.match(
    contentTs,
    /ensureSettingsPanelSpace\(wrapper\);[\s\S]*TOGGLE_SETTINGS_PANEL/,
    'Opening settings should first ensure enough window width for the settings panel.'
  );
  assert.match(
    contentTs,
    /event\.key\.toLowerCase\(\)\s*===\s*'m'/,
    'Injected page shortcuts should close the latest chat window with Alt+M.'
  );
  assert.match(
    contentTs,
    /private nextFreshWindowNumber = 1;/,
    'Fresh chat windows should use a page-local incremental title counter.'
  );
  assert.match(
    contentTs,
    /private windowTitles = new Map<string, string>\(\);/,
    'Injected chat windows should track editable titles per window.'
  );
  assert.match(
    contentTs,
    /private createDefaultWindowTitle\(\)/,
    'Injected chat windows should centralize default title generation.'
  );
  assert.match(
    contentTs,
    /private beginTitleEdit\(windowId: string\)/,
    'Injected chat windows should expose an inline title edit flow.'
  );
  assert.match(
    contentTs,
    /private commitWindowTitle\(windowId: string, nextTitle: string\)/,
    'Edited window titles should be committed through a dedicated helper.'
  );
  assert.match(
    contentTs,
    /chat\?\.title\s*\|\|\s*this\.createDefaultWindowTitle\(\)/,
    'Restored windows should preserve their stored title while fresh windows get a generated one.'
  );
  assert.match(
    contentTs,
    /windowTitle:\s*this\.windowTitles\.get\(windowId\)/,
    'Injected page shells should pass the current visible title into chat iframe initialization.'
  );
  assert.match(
    chatTs,
    /private windowTitle = '';/,
    'Chat iframe state should track the current shell title.'
  );
  assert.match(
    chatTs,
    /windowTitle\?: string;/,
    'Chat initialization payload should include the shell title.'
  );
  assert.match(
    chatTs,
    /if \(event\.data\?\.type === 'WINDOW_TITLE_CHANGED'\)/,
    'Chat iframe should accept title-change messages from the page shell.'
  );
  assert.match(
    chatTs,
    /windowTitle:\s*this\.windowTitle/,
    'Chat requests should send the current visible window title to persistence.'
  );
  assert.match(
    contentTs,
    /addEventListener\('click'/,
    'Window titles should be editable from the page shell.'
  );
  assert.match(
    backgroundTs,
    /title:\s*existing\?\.title\s*\|\|\s*input\.request\.windowTitle\s*\|\|/s,
    'Persisted chats should prefer the edited shell title before deriving one from message text.'
  );
  assert.doesNotMatch(
    backgroundTs,
    /title:\s*existing\?\.title\s*\|\|\s*compactText\(input\.request\.userMessage\)/,
    'Chat persistence should no longer fall back directly to the first user message when no custom title was provided.'
  );
  assert.match(
    contentTs,
    /private windowStack: string\[\] = \[\];/,
    'Injected chat windows should maintain a per-page stack of window ids.'
  );
  assert.match(
    contentTs,
    /private activateWindow\(windowId: string\)/,
    'Injected chat windows should expose a helper to move a window to the top of the page stack.'
  );
  assert.match(
    contentTs,
    /wrapper\.addEventListener\('pointerdown', \(\) => \{\s*this\.activateWindow\(windowId\);/s,
    'Interacting with a chat window should promote it to the top of the page stack.'
  );
  assert.match(
    contentTs,
    /const lastWindowId = this\.windowStack\.pop\(\);[\s\S]*this\.closeWindow\(lastWindowId\);/s,
    'Alt+M should close the current stack-top chat window instead of the last-created map entry.'
  );
  assert.match(
    contentTs,
    /this\.windowStack = this\.windowStack\.filter\(\(id\) => id !== windowId\);[\s\S]*this\.windowStack\.push\(windowId\);[\s\S]*this\.syncWindowStack\(\);/s,
    'Activating a chat window should reorder the page stack and refresh z-index layering.'
  );
  assert.doesNotMatch(
    contentTs,
    /event\.key\.toLowerCase\(\)\s*===\s*'w'/,
    'Injected page shortcuts should no longer close chat windows with Alt+W.'
  );
  assert.match(contentTs, /document\.addEventListener\('pointerup'/, 'Selection toolbar should use pointer events for mouse and touch.');
  assert.match(contentTs, /header\.addEventListener\('pointerdown'/, 'Injected windows should start dragging with pointer events.');
  assert.match(contentTs, /setPointerCapture\(event\.pointerId\)/, 'Drag and resize interactions should capture the active pointer.');
  assert.match(contentTs, /SNAP_THRESHOLD/, 'Injected windows should support edge snapping for small screens and touch use.');
  assert.match(contentTs, /class="ai-window-btn ai-dock-toggle-btn"/, 'Injected windows should expose one dynamic dock toggle button.');
  assert.doesNotMatch(contentTs, /ai-dock-left-btn/, 'Injected windows should not render a separate left dock button.');
  assert.doesNotMatch(contentTs, /ai-dock-right-btn/, 'Injected windows should not render a separate right dock button.');
  assert.match(contentTs, /private dockWindow\(windowId: string, mode: 'left' \| 'right'\)/, 'Injected windows should support half-screen docking.');
  assert.match(contentTs, /private updateDockToggle\(windowId: string\)/, 'Injected windows should dynamically switch the dock icon.');
  assert.match(contentTs, /private getDockModeForWindow\(wrapper: HTMLElement\): 'left' \| 'right'/, 'Dock toggle should derive its next side from current window state.');
  assert.match(contentTs, /private toggleFullscreen\(windowId: string\)/, 'Injected windows should support a fullscreen toggle.');
  assert.doesNotMatch(contentTs, /addEventListener\('mousedown'/, 'Injected window controls should not depend on mouse-only drag or resize events.');
  assert.doesNotMatch(contentTs, /addEventListener\('mousemove'/, 'Injected window controls should not depend on mouse-only move events.');
  assert.doesNotMatch(contentTs, /addEventListener\('mouseup'/, 'Injected window controls should not depend on mouse-only release events.');
}

function runContentToolbarLayoutTests() {
  const css = fs.readFileSync(path.join(process.cwd(), 'styles.css'), 'utf8');

  assert.match(
    css,
    /\.ai-selection-toolbar\s*\{[^}]*padding:\s*0;[^}]*border:\s*none;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    'Selection toolbar container should not draw an outer frame around the AI chat button.'
  );
  assert.match(
    css,
    /\.ai-toolbar-btn:hover\s*\{[^}]*border-color:\s*#bfdbfe;/s,
    'The AI chat button should keep its own highlighted hover border.'
  );
  assert.match(
    css,
    /\.ai-multi-window\s*\{[^}]*touch-action:\s*none;/s,
    'Injected chat windows should opt into direct pointer handling for touch drag and resize.'
  );
  assert.match(
    css,
    /\.ai-resize-handle\s*\{[^}]*touch-action:\s*none;/s,
    'Resize handles should expose touch-friendly pointer behavior.'
  );
  assert.match(
    css,
    /\.ai-window-btn\s*\{[^}]*min-width:\s*34px;[^}]*min-height:\s*34px;/s,
    'Window control buttons should have a larger touch target.'
  );
}

export async function runAllTests() {
  await runSharedTests();
  runI18nTests();
  runChatWindowLayoutTests();
  runSettingsSurfaceLayoutTests();
  runContentToolbarLayoutTests();
}
