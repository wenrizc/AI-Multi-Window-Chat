import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { LLMock } from '@copilotkit/aimock/jest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createChatSession, createPersistedMessage } from '../helpers/factories';

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

test('opens embedded settings when the host suppresses the referrer', async () => {
  const page = await context.newPage();
  const hostUrl = `${mock.url}/settings-host`;
  await page.route(hostUrl, route => route.fulfill({
    contentType: 'text/html',
    headers: { 'Referrer-Policy': 'no-referrer' },
    body: '<!doctype html><html><body><p>Settings test host</p></body></html>'
  }));
  await page.goto(hostUrl);
  await page.keyboard.press('Alt+n');
  const chat = page.frameLocator('.ai-chat-iframe');
  await expect(chat.locator('#messageInput')).toBeVisible();
  expect(await chat.locator('body').evaluate(() => document.referrer)).toBe('');
  await page.locator('.ai-settings-btn').click();
  await expect(chat.locator('#settingsPanel')).toBeVisible();
  await expect(chat.locator('#profileSelect')).toHaveValue('e2e-provider');
  await chat.locator('#settingsCloseBtn').click();
  await expect(chat.locator('#settingsPanel')).toBeHidden();
  await page.locator('.ai-settings-btn').click();
  await expect(chat.locator('#settingsPanel')).toBeVisible();
  await page.locator('.ai-settings-btn').click();
  await expect(chat.locator('#settingsPanel')).toBeHidden();
  await page.close();
});

test('branches an embedded conversation with its history and continues independently', async () => {
  const page = await context.newPage();
  const hostUrl = `${mock.url}/branch-host`;
  await page.route(hostUrl, route => route.fulfill({
    contentType: 'text/html', headers: { 'Referrer-Policy': 'no-referrer' },
    body: '<!doctype html><html><body><p>Branch test host</p></body></html>'
  }));
  await page.goto(hostUrl);
  const session = createChatSession({
    chatId: 'branch-source', title: 'Source conversation', providerId: 'e2e-provider',
    activeLeafId: 'source-a2',
    messages: [
      createPersistedMessage({ id: 'source-u1', parentId: null, role: 'user', content: 'First question' }),
      createPersistedMessage({ id: 'source-a1', parentId: 'source-u1', content: 'First answer' }),
      createPersistedMessage({ id: 'source-u2', parentId: 'source-a1', role: 'user', content: 'Second question' }),
      createPersistedMessage({ id: 'source-a2', parentId: 'source-u2', content: 'Second answer' })
    ]
  });
  await serviceWorker.evaluate(async ({ url, session }) => {
    await chrome.storage.local.set({ [`chat_${session.chatId}`]: session });
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (tab?.id === undefined) throw new Error('Host tab missing');
    await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_CHAT_WINDOW', chat: session });
  }, { url: hostUrl, session });
  const source = page.frameLocator('.ai-chat-iframe').first();
  await expect(source.locator('.message')).toHaveCount(4);
  await source.locator('.message-action-branch').nth(1).click();
  await expect(page.locator('.ai-chat-iframe')).toHaveCount(2);
  const branch = page.frameLocator('.ai-chat-iframe').last();
  await expect(branch.locator('.message')).toHaveCount(2);
  await expect(branch.locator('.message-content')).toHaveText(['First question', 'First answer']);
  await expect(branch.locator('.welcome-message')).toHaveCount(0);
  await branch.locator('#messageInput').fill('e2e hello');
  await branch.locator('#sendBtn').click();
  await expect(branch.locator('.message-assistant .message-content').last()).toContainText('E2E reply from aimock.');
  await expect(source.locator('.message')).toHaveCount(4);
  const requests = mock.getRequests();
  const request = requests[requests.length - 1];
  expect(JSON.stringify(request)).toContain('First question');
  expect(JSON.stringify(request)).toContain('First answer');
  expect(JSON.stringify(request)).not.toContain('Second question');
  await expect.poll(async () => serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get(null);
    const branch = Object.entries(stored)
      .filter(([key]) => key.startsWith('chat_') && key !== 'chat_index_v5')
      .map(([, value]) => value as typeof session)
      .find(chat => chat.branchOf?.chatId === 'branch-source');
    return branch?.messages.map(message => message.content);
  })).toEqual(['First question', 'First answer', 'e2e hello', 'E2E reply from aimock.']);
  const original = await serviceWorker.evaluate(async () => {
    const stored = await chrome.storage.local.get('chat_branch-source');
    return stored['chat_branch-source'];
  });
  expect(original).toEqual(session);
  await page.close();
});
