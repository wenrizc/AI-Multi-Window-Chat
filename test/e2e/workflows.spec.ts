import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProvider, createRootStore } from '../helpers/factories';
import type { ChatSession } from '../../src/shared/types';

let context: BrowserContext;
let worker: Worker;
let server: Server;
let origin: string;
let extensionId: string;
let mode: 'ok' | 'auth' | 'retry' | 'slow';
let requests: Record<string, any>[];
const screenshots = resolve('test-results/workflow-audit');
const imageFile = { name: 'audit.svg', mimeType: 'image/svg+xml',
  buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#2563eb"/><text x="8" y="38" fill="white">AUDIT</text></svg>') };

async function capture(page: Page, name: string) {
  await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true, animations: 'disabled' });
}

async function open(path: string) {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`chrome-extension://${extensionId}/${path}`);
  return page;
}

async function send(page: Page, text: string) {
  await page.locator('#messageInput').fill(text);
  await page.locator('#sendBtn').click();
}

async function saved(chatId: string) {
  return worker.evaluate(async id => (await chrome.storage.local.get(`chat_${id}`))[`chat_${id}`] as ChatSession | undefined, chatId);
}

async function chat(chatId: string) {
  const page = await open('chat-window.html');
  await expect(page.locator('#profileSelect')).toHaveValue('audit-provider');
  await page.evaluate(id => window.postMessage({ type: 'INIT_CHAT', chatId: id }, window.location.origin), chatId);
  return page;
}

test.beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    requests.push(body);
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'auth' || mode === 'retry') {
      res.statusCode = mode === 'auth' ? 401 : 500;
      res.end(JSON.stringify({ error: { message: 'Audit simulated failure' } }));
      if (mode === 'retry') mode = 'ok';
      return;
    }
    const respond = () => res.end(JSON.stringify({ id: 'audit-answer', choices: [{ message: {
      role: 'assistant', content: `Audit answer ${requests.length}: **verified**\n\n| Item | State |\n| --- | --- |\n| Test | OK |`
    } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    if (mode === 'slow') {
      const timer = setTimeout(respond, 30000);
      res.on('close', () => clearTimeout(timer));
    } else respond();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const extensionPath = resolve('release');
  context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'aimw-audit-')), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
});

test.beforeEach(async () => {
  mode = 'ok';
  requests = [];
  const provider = createProvider({ id: 'audit-provider', name: 'Audit model', baseUrl: origin,
    modelCatalog: [{ modelId: 'test-model', displayName: 'Audit model', supportsStreaming: false, reasoningFormat: 'none' }] });
  const store = createRootStore({ providers: [provider] });
  store.featureSettings.defaultProviderId = provider.id;
  store.featureSettings.search.tavilyApiKey = '';
  await worker.evaluate(async store => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ app_meta_v5: store, chat_index_v5: [] });
  }, store);
});

test.afterEach(async () => {
  for (const page of context.pages()) await page.close();
});
test.afterAll(async () => {
  await context?.close();
  server?.closeAllConnections();
  await new Promise<void>(done => server?.close(() => done()));
});

test('attachments, markdown, edit and regenerate preserve conversation versions', async () => {
  const page = await chat('audit-tree');
  await page.locator('#attachmentInput').setInputFiles(imageFile);
  await expect(page.locator('.attachment-chip.ready')).toBeVisible();
  await expect(page.locator('.attachment-chip img')).toHaveJSProperty('naturalWidth', 96);
  await capture(page, '01-attachment-ready');
  await page.locator('[data-remove-attachment]').click();
  await expect(page.locator('#attachmentTray')).toBeHidden();
  await page.locator('#attachmentInput').setInputFiles(imageFile);
  await expect(page.locator('.attachment-chip.ready')).toBeVisible();
  await send(page, 'Read the attached text');
  await expect.poll(async () => (await saved('audit-tree'))?.messages.length).toBe(2);
  expect(JSON.stringify(requests[0].messages)).toContain('image_url');
  await expect(page.locator('.message-assistant table')).toBeVisible();
  expect(await page.locator('.message-assistant th').first().evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThan(0);
  await capture(page, '02-attachment-answer');
  await page.locator('.message-action-regenerate').click();
  await expect.poll(async () => (await saved('audit-tree'))?.messages.length).toBe(3);
  expect((await saved('audit-tree'))!.messages.filter(m => m.role === 'user')).toHaveLength(1);
  await expect(page.locator('.message-version-label')).toHaveText('2/2');
  await page.locator('.message-version-btn[data-version-dir="-1"]').click();
  await expect(page.locator('.message-assistant .message-content')).toContainText('Audit answer 1');
  await capture(page, '03-regenerate-version');
  await page.locator('.message-action-edit').click();
  await page.locator('.message-edit-input').fill('Edited attachment question');
  await page.locator('.message-edit-cancel').click();
  await expect(page.locator('.message-user .message-content')).toContainText('Read the attached text');
  await page.locator('.message-action-edit').click();
  await page.locator('.message-edit-input').fill('Edited attachment question');
  await page.locator('.message-edit-save').click();
  await expect.poll(async () => (await saved('audit-tree'))?.messages.length).toBe(5);
  expect(JSON.stringify(requests[2].messages)).toContain('image_url');
  await expect(page.locator('.message-user .message-content')).toContainText('Edited attachment question');
  await capture(page, '04-edited-branch');
});

test('auth failure, retry, cancellation and missing search key recover correctly', async () => {
  const page = await chat('audit-errors');
  mode = 'auth';
  await send(page, 'Auth failure');
  await expect(page.locator('#composerStatus')).toHaveAttribute('data-variant', 'error');
  await expect(page.locator('#composerRetryBtn')).toBeHidden();
  await capture(page, '05-auth-error');
  mode = 'retry';
  await send(page, 'Retry question');
  await expect(page.locator('#composerRetryBtn')).toBeVisible();
  await capture(page, '06-retry-error');
  await page.locator('#composerRetryBtn').click();
  await expect(page.locator('.message-assistant .message-content')).toContainText('verified');
  await expect.poll(async () => (await saved('audit-errors'))?.messages.filter((m: any) => m.role === 'user').length).toBe(2);
  mode = 'slow';
  await send(page, 'Cancel question');
  await expect(page.locator('#sendBtn')).toHaveClass(/is-loading/);
  await expect.poll(() => requests.length).toBe(4);
  await page.locator('#sendBtn').click();
  await expect(page.locator('#sendBtn')).not.toHaveClass(/is-loading/);
  await capture(page, '07-cancelled-request');
  const count = requests.length;
  await page.evaluate(() => window.postMessage({ type: 'TOGGLE_SETTINGS_PANEL' }, window.location.origin));
  await page.locator('#searchToggle').check();
  await page.locator('#settingsCloseBtn').click();
  await send(page, 'Search question');
  await expect(page.locator('#composerStatus')).toHaveAttribute('data-variant', 'warning');
  expect(requests).toHaveLength(count);
  await capture(page, '08-search-key-warning');
});

test('settings CRUD, export and malformed import retain saved configuration', async () => {
  const page = await open('popup.html?view=settings');
  await expect(page.locator('#profileName')).toHaveValue('Audit model');
  const temperature = page.locator('#temperatureInput');
  const streaming = page.locator('#supportsStreamingCheckbox');
  await expect(temperature).toBeVisible();
  await expect(streaming).toBeVisible();
  expect(await temperature.evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('#supportsStreamingCheckbox')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const streamingBox = await streaming.locator('..').boundingBox();
  const settingsBox = await page.locator('#configTab .profile-details').boundingBox();
  expect(streamingBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(streamingBox!.width).toBeLessThan(settingsBox!.width * 0.75);
  await page.locator('#profileName').fill('Renamed audit model');
  await page.locator('#saveBtn').click();
  await page.reload();
  await expect(page.locator('#profileName')).toHaveValue('Renamed audit model');
  await page.locator('#testBtn').click();
  await expect(page.locator('#testBtn')).toBeEnabled();
  await expect(page.locator('#status')).toHaveClass(/success/);
  await capture(page, '09-settings-connection');
  await page.locator('#importProfilesBtn').click();
  await page.locator('#importProfilesInput').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(page.locator('#status')).toHaveClass(/error/);
  await expect(page.locator('#profileName')).toHaveValue('Renamed audit model');
  await capture(page, '10-invalid-import');
  await page.locator('#promptsTabButton').click();
  await page.locator('#addPromptBtn').click();
  await page.locator('#promptName').fill('Audit prompt');
  await page.locator('#promptContent').fill('Use concise answers.');
  await page.locator('#savePromptBtn').click();
  await page.reload();
  await page.locator('#promptsTabButton').click();
  await expect(page.locator('#promptName')).toHaveValue('Audit prompt');
  await page.locator('#exportPromptsBtn').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportModal [data-format="json"]').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(JSON.stringify(exported)).toContain('Use concise answers.');
  await page.setViewportSize({ width: 360, height: 640 });
  await capture(page, '11-narrow-prompt');
  await page.locator('#deletePromptBtn').click();
  await page.locator('#confirmCancelBtn').click();
  await expect(page.locator('#promptName')).toHaveValue('Audit prompt');
  await page.locator('#deletePromptBtn').click();
  await page.locator('#confirmBtn').click();
  await expect(page.locator('#promptName')).toHaveValue('');
});

test('host windows, selection toolbar, history resume and deletion', async () => {
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route(`${origin}/audit-host`, route => route.fulfill({ contentType: 'text/html', body: '<html><body><h1>Integration test host</h1><p>Select this text to ask a question.</p></body></html>' }));
  await page.goto(`${origin}/audit-host`);
  await page.locator('p').evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await expect(page.locator('.ai-selection-toolbar')).toBeVisible();
  await capture(page, '12-selection-toolbar');
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await page.keyboard.press('Alt+n');
  const frame = page.frameLocator('.ai-chat-iframe');
  await expect(frame.locator('#messageInput')).toBeVisible();
  await frame.locator('#messageInput').fill('Host history question');
  await frame.locator('#sendBtn').click();
  await expect(frame.locator('.message-assistant .message-content')).toContainText('verified');
  await capture(page, '13-embedded-answer');
  await page.locator('.ai-fullscreen-btn').click();
  await expect(page.locator('.ai-multi-window')).toHaveClass(/fullscreen/);
  await capture(page, '16-fullscreen-window');
  await page.locator('.ai-fullscreen-btn').click();
  await page.locator('.ai-minimize-btn').click();
  await expect(page.locator('.ai-multi-window')).toHaveClass(/minimized/);
  await capture(page, '17-minimized-window');
  await page.locator('.ai-minimize-btn').click();
  const settings = await open('popup.html?view=settings');
  await settings.locator('#historyTabButton').click();
  await expect(settings.locator('.history-item')).toHaveCount(1);
  await settings.locator('#historySearchInput').fill('no matching history');
  await expect(settings.locator('.history-item')).toHaveCount(0);
  await settings.locator('#historySearchInput').fill('Host history');
  await expect(settings.locator('.history-item')).toHaveCount(1);
  await capture(settings, '14-history-filter');
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    await chrome.tabs.update(tab!.id!, { active: true });
  }, `${origin}/audit-host`);
  await settings.locator('[data-action="resume"]').click();
  await expect(page.locator('.ai-chat-iframe')).toHaveCount(2);
  await expect(page.frameLocator('.ai-chat-iframe').last().locator('.message-assistant .message-content')).toContainText('verified');
  await capture(page, '18-history-resumed');
  await page.locator('.ai-multi-window').last().locator('.ai-close-btn').click();
  await settings.locator('[data-action="export"]').click();
  const downloadPromise = settings.waitForEvent('download');
  await settings.locator('#exportModal [data-format="json"]').click();
  const download = await downloadPromise;
  expect(await readFile((await download.path())!, 'utf8')).toContain('Host history question');
  await settings.locator('[data-action="delete"]').click();
  await settings.locator('#confirmCancelBtn').click();
  await expect(settings.locator('.history-item')).toHaveCount(1);
  await settings.locator('[data-action="delete"]').click();
  await settings.locator('#confirmBtn').click();
  await expect(settings.locator('.history-item')).toHaveCount(0);
  await capture(settings, '15-history-deleted');
  await page.locator('.ai-close-btn').click();
  await expect(page.locator('.ai-chat-iframe')).toHaveCount(0);
});
