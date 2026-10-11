import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const cases = [
  ['en-US', 'en', 'Send'], ['zh-CN', 'zh-CN', '发送'], ['zh-SG', 'zh-CN', '发送'],
  ['zh-Hans', 'zh-CN', '发送'], ['zh-TW', 'en', 'Send'], ['fr-FR', 'en', 'Send']
] as const;

async function serveWebsite(page: Page) {
  const root = resolve('website-dist');
  await page.route('http://i18n.test/**', async route => {
    const file = resolve(root, `.${new URL(route.request().url()).pathname}`);
    if (!file.startsWith(root + sep)) return route.fulfill({ status: 404 });
    try {
      const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[extname(file)];
      await route.fulfill({ contentType, body: readFileSync(file) });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
}

for (const [locale, language, send] of cases) {
  test(`extension and website resolve ${locale} to ${language}`, async () => {
    const extension = resolve('release');
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'aimw-i18n-')), {
      channel: 'chromium', headless: true, locale,
      args: [`--lang=${locale}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
      const page = await context.newPage();
      await page.goto(`${extensionOrigin}/chat-window.html`);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('#sendBtn')).toHaveAttribute('aria-label', send);
      expect(await page.evaluate(() => t('config__statusImported', [2, 9]))).toBe(
        language === 'en' ? 'Added 2, updated 9 items' : '已添加 2 项，更新 9 项'
      );
      expect(await page.evaluate(() => t('content__aiChatTitle', '$& $1 $$'))).toBe(
        language === 'en' ? 'AI Chat $& $1 $$' : 'AI 对话 $& $1 $$'
      );
      await page.locator('#attachmentInput').setInputFiles({
        name: 'sample $1.txt', mimeType: 'text/plain', buffer: Buffer.from('sample')
      });
      await expect(page.locator('[data-remove-attachment]')).toHaveAttribute('aria-label',
        language === 'en' ? 'Remove attachment: sample $1.txt' : '删除附件：sample $1.txt');

      await page.goto(`${extensionOrigin}/popup.html?view=settings`);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.locator('#setActiveBtn')).toHaveText(language === 'en' ? 'Set as default' : '设为默认');
      expect(await page.evaluate(() => t('history__messageCountOne', 1))).toBe(language === 'en' ? '1 message' : '1 条消息');

      await serveWebsite(page);
      await page.goto('http://i18n.test/index.html');
      await expect(page.locator('[data-i18n="website__homeSubtitle"]')).toHaveText(language === 'en'
        ? 'Browser extension for multi-window AI conversations' : '多窗口 AI 对话浏览器扩展');
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      expect(await page.evaluate(() => t('content__aiChatTitle', '$& $1 $$'))).toBe(
        language === 'en' ? 'AI Chat $& $1 $$' : 'AI 对话 $& $1 $$'
      );
      await page.keyboard.press('Alt+n');
      await expect(page.locator('.ai-multi-window')).toHaveAttribute('lang', language);
    } finally {
      await context.close();
    }
  });
}

test('website preserves an explicit language across navigation in both directions', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'zh-CN' });
  try {
    const page = await context.newPage();
    await serveWebsite(page);
    await page.goto('http://i18n.test/index.html?lang=en');
    await expect(page.locator('[data-i18n="website__linkPrivacyPolicy"]')).toHaveText('Privacy Policy');
    await page.locator('[data-i18n="website__linkPrivacyPolicy"]').click();
    await expect(page).toHaveURL('http://i18n.test/privacy-policy.html?lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('Privacy Policy - AI Multi-Window Chat');
    await page.locator('[data-i18n="website__backHome"]').click();
    await expect(page).toHaveURL('http://i18n.test/index.html?lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('[data-i18n="website__linkPrivacyPolicy"]')).toHaveText('Privacy Policy');
  } finally {
    await context.close();
  }
});
