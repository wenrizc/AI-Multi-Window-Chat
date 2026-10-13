import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const out = resolve(root, 'test-results/live-import');
await mkdir(out, { recursive: true });
const extensionPath = resolve(root, 'release');
const userDataDir = mkdtempSync(join(tmpdir(), 'aimw-live-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});
try {
const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const extensionId = new URL(worker.url()).host;
const page = await context.newPage();
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.setViewportSize({ width: 1000, height: 900 });
await page.goto(`chrome-extension://${extensionId}/popup.html?view=settings`);
await page.waitForTimeout(300);
const onboardingSkip = page.locator('#onboardingSkipBtn');
if (await onboardingSkip.isVisible()) await onboardingSkip.click();
await page.screenshot({ path: join(out, '01-before-import.png'), fullPage: true });

const importFile = async (buttonId, inputId, filePath) => {
  await page.locator(`#${buttonId}`).click();
  await page.locator(`#${inputId}`).setInputFiles(filePath);
  const confirm = page.locator('#confirmModal');
  await confirm.locator('#confirmBtn').click();
  await page.waitForTimeout(250);
};
await importFile('importProfilesBtn', 'importProfilesInput', 'C:/Users/13506/Downloads/providers-v2.json');
await page.locator('#promptsTabButton').click();
await importFile('importPromptsBtn', 'importPromptsInput', 'C:/Users/13506/Downloads/prompts-v2.json');
await page.screenshot({ path: join(out, '02-after-import.png'), fullPage: true });

const imported = await worker.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return { state: all.app_state_v4, meta: all.app_meta_v5 };
});
await writeFile(join(out, `imported-state-summary-${Date.now()}.json`), JSON.stringify({
  providerNames: imported.meta?.providers?.map(p => p.name),
  defaultProviderId: imported.meta?.featureSettings?.defaultProviderId,
  promptNames: imported.meta?.prompts?.map(p => p.name),
  defaultPromptId: imported.meta?.featureSettings?.defaultPromptId,
  searchEnabledByDefault: imported.meta?.featureSettings?.search?.enabledByDefault
}, null, 2));
if (imported.meta?.providers?.[0]?.name !== 'deepseek-flash') throw new Error('Provider import failed');
if (imported.meta?.prompts?.[0]?.name !== '破甲词') throw new Error('Prompt import failed');

await page.locator('#configTabButton').click();
await page.locator('#testBtn').click();
await expect(page.locator('#testBtn')).toBeEnabled({ timeout: 60000 });
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: join(out, '03-provider-test.png'), fullPage: true });
await expect(page.locator('#status')).not.toHaveClass(/error/);
console.log('Connection status:', await page.locator('#status').innerText());
const overlaps = await page.evaluate(() => {
  const status = document.querySelector('#status').getBoundingClientRect();
  const grid = document.querySelector('#configTab .config-grid').getBoundingClientRect();
  return status.bottom > grid.top;
});
if (overlaps) throw new Error('Connection status overlaps provider form');
await page.setViewportSize({ width: 360, height: 640 });
for (const [tab, filename] of [
  ['configTabButton', '06-narrow-settings.png'],
  ['searchTabButton', '07-search-settings.png'],
  ['promptsTabButton', '08-prompt-settings.png'],
  ['historyTabButton', '09-history-settings.png']
]) {
  await page.locator(`#${tab}`).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    throw new Error(`Horizontal overflow on ${tab}`);
  }
  await page.screenshot({ path: join(out, filename), fullPage: true });
}
await page.setViewportSize({ width: 1000, height: 900 });

await page.goto(`chrome-extension://${extensionId}/chat-window.html`);
await page.reload();
await page.locator('#messageInput').fill('请只回复：集成测试成功');
await page.locator('#sendBtn').click();
const deadline = Date.now() + 90000;
let reply = '';
while (Date.now() < deadline) {
  reply = ((await page.locator('.message-assistant .message-content').first().textContent({ timeout: 1000 }).catch(() => '')) ?? '').trim();
  const status = await page.locator('#composerStatus').getAttribute('data-variant');
  if (reply && status !== 'busy') break;
  if (status === 'error') break;
  await page.waitForTimeout(500);
}
const finalStatus = await page.locator('#composerStatus').getAttribute('data-variant');
await page.screenshot({ path: join(out, '04-real-chat.png'), fullPage: true });
const statusText = await page.locator('#composerStatus').innerText();
const bodyText = await page.locator('body').innerText();
await writeFile(join(out, `04-real-chat-debug-${Date.now()}.txt`), `status=${finalStatus}\nstatusText=${statusText}\nbody=${bodyText}`);
if (!reply) throw new Error(`Real chat returned no assistant content (status=${finalStatus}: ${statusText})`);
if (finalStatus === 'error') throw new Error(`Real chat failed: ${statusText}`);
if (finalStatus === 'busy') throw new Error('Real chat did not finish before timeout');
const readSaved = () => worker.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).find(([key, value]) => key.startsWith('chat_') && value?.messages?.length)?.[1];
});
await expect.poll(async () => (await readSaved())?.messages?.length ?? 0).toBe(2);
await page.evaluate(() => window.postMessage({ type: 'TOGGLE_SETTINGS_PANEL' }, window.location.origin));
await page.locator('#streamingToggle').uncheck();
await page.locator('#settingsCloseBtn').click();
await page.locator('#messageInput').fill('上一条用户消息要求回复什么？请只回复那句话。');
await page.locator('#sendBtn').click();
await expect.poll(async () => (await readSaved())?.messages?.length ?? 0, { timeout: 90000 }).toBe(4);
await expect(page.locator('.message-assistant .message-content').last()).toContainText('集成测试成功');
await page.screenshot({ path: join(out, '10-nonstream-followup.png'), fullPage: true });
const saved = await readSaved();
await page.reload();
await expect(page.locator('#messageInput')).toBeVisible();
await page.evaluate(session => window.postMessage({
  type: 'INIT_CHAT', chatId: session.chatId, profileId: session.profileId,
  promptId: session.promptId, historyMessages: session.messages,
  activeLeafId: session.activeLeafId, streamingOverride: session.streamingOverride
}, window.location.origin), saved);
await expect(page.locator('.message-assistant .message-content')).toHaveCount(2);
await expect(page.locator('.message-assistant .message-content').first()).toContainText(reply, { timeout: 10000 });
await page.screenshot({ path: join(out, '05-reloaded-chat.png'), fullPage: true });
await page.setViewportSize({ width: 360, height: 640 });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: join(out, '11-dark-narrow-chat.png'), fullPage: true });

const result = { extensionId, provider: imported.meta.providers[0].name, prompt: imported.meta.prompts[0].name,
  defaultProviderId: imported.meta.featureSettings.defaultProviderId,
  defaultPromptId: imported.meta.featureSettings.defaultPromptId,
  replyPreview: reply.slice(0, 120),
  screenshots: ['01-before-import.png', '02-after-import.png', '03-provider-test.png', '04-real-chat.png',
    '05-reloaded-chat.png', '06-narrow-settings.png', '07-search-settings.png', '08-prompt-settings.png',
    '09-history-settings.png', '10-nonstream-followup.png', '11-dark-narrow-chat.png'] };
console.log(JSON.stringify(result, null, 2));
} finally {
await context.close();
}
