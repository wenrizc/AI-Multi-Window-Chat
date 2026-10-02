import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { LLMock } from '@copilotkit/aimock/jest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end test against the real built extension in `release/`.
 *
 * Chromium loads the packaged MV3 extension, the background service worker
 * talks to a local aimock OpenAI-compatible server, and the chat window page
 * renders the streamed answer.
 */

const STORAGE_KEY = 'app_state_v4';

let mock: LLMock;
let context: BrowserContext;
let serviceWorker: Worker;
let extensionId: string;

function buildStore(baseUrl: string) {
  return {
    schemaVersion: 4,
    providers: [
      {
        id: 'e2e-provider',
        name: 'Aimock',
        baseUrl: `${baseUrl}/v1`,
        apiKey: 'test-key',
        transport: 'chat_completions',
        defaultModel: 'aimock-model',
        defaultGenerationParams: { temperature: null },
        headers: {},
        modelCatalog: [
          {
            modelId: 'aimock-model',
            displayName: 'Aimock Model',
            supportsStreaming: false,
            reasoningFormat: 'none'
          }
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    prompts: [],
    featureSettings: {
      defaultProviderId: 'e2e-provider',
      defaultPromptId: null,
      defaultStreaming: false,
      search: {
        tavilyApiKey: '',
        enabledByDefault: false,
        searchDepth: 'basic',
        timeRange: null,
        maxResults: 5,
        maxRounds: 1
      }
    },
    chatHistory: []
  };
}

test.beforeAll(async () => {
  mock = new LLMock({ port: 0, logLevel: 'silent' });
  mock.onMessage('e2e hello', { content: 'E2E reply from aimock.' });
  await mock.start();

  const extensionPath = resolve(process.cwd(), 'release');
  const userDataDir = mkdtempSync(join(tmpdir(), 'aimw-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker');
  }
  serviceWorker = worker;
  extensionId = new URL(worker.url()).host;

  await worker.evaluate(async (store) => {
    await chrome.storage.local.set({ app_state_v4: store });
  }, buildStore(mock.url));
});

test.afterAll(async () => {
  await context?.close();
  await mock?.stop();
});

test('completes a chat round trip through the real extension', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/chat-window.html`);
  await expect(page.locator('#messageInput')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({ type: 'INIT_CHAT', chatId: 'e2e-chat', initialMessage: 'e2e hello' }, '*');
  });

  await expect(page.locator('#messageInput')).toHaveValue('e2e hello');
  await page.click('#sendBtn');

  await expect(page.locator('.message-assistant .message-content')).toContainText(
    'E2E reply from aimock.'
  );

  await expect
    .poll(async () => {
      const history = await serviceWorker.evaluate(async () => {
        const result = await chrome.storage.local.get('chat_index_v5');
        return (result.chat_index_v5 as unknown[] | undefined) ?? [];
      });
      return history.length;
    })
    .toBe(1);

  const requests = mock.getRequests();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests[requests.length - 1].path).toBe('/v1/chat/completions');
});
