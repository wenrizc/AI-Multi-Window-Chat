import { expect, test } from '@playwright/test';
import { openPopupExtension } from '../helpers/popup-extension';

for (const locale of ['en-US', 'zh-CN']) {
  test(`settings appearance in ${locale}`, async () => {
    const extension = await openPopupExtension(locale);
    try {
      const page = await extension.context.newPage();
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
        for (const mode of ['popup', 'settings']) {
          await page.setViewportSize({ width: mode === 'popup' ? 568 : 1200, height: 1000 });
          await page.goto(extension.url + (mode === 'settings' ? '?view=settings' : ''));
          await expect(page.locator('#profileName')).toHaveValue('DeepSeek');
          await expect(page.locator('#storageUsage')).not.toHaveText('');
          await expect(page).toHaveScreenshot(`${locale}-${mode}-${theme}.png`, { fullPage: true });
        }
      }
    } finally {
      await extension.close();
    }
  });
}
