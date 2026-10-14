import { expect, test } from '@playwright/test';
import { openPopupExtension } from '../helpers/popup-extension';

for (const locale of ['en-US', 'zh-CN']) {
  test(`popup controls align and themes remain readable in ${locale}`, async () => {
    const extension = await openPopupExtension(locale);
    try {
      const page = await extension.context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      for (const mode of ['popup', 'settings']) {
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
          for (const width of [360, 485, 568, 720, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(extension.url + (mode === 'settings' ? '?view=settings' : ''));
            await expect(page.locator('body')).toHaveAttribute('data-view', mode);
            await expect(page.locator('#profileName')).toHaveValue('DeepSeek');
            await page.locator('#historyTabButton').click();
            await expect(page.locator('#storageUsage')).toBeVisible();
            await expect(page.locator('#storageUsage')).toHaveAttribute('data-level', 'normal');
            await expect(page.locator('#storageUsage')).not.toContainText('%');
            await page.locator('#configTabButton').click();
            if (mode === 'popup') {
              await expect(page.locator('#openSettingsBtn')).toBeVisible();
            } else {
              await expect(page.locator('#openSettingsBtn')).toBeHidden();
              await expect(page.locator('#transportSelect')).toBeVisible();
            }

            const layout = await page.evaluate(() => {
              const buttons = [...document.querySelectorAll<HTMLElement>('.btn')]
                .filter(button => button.getClientRects().length > 0);
              return {
                overflow: document.documentElement.scrollWidth > innerWidth,
                centers: buttons.map(button => {
                  const range = document.createRange();
                  range.selectNodeContents(button);
                  const text = range.getBoundingClientRect();
                  const box = button.getBoundingClientRect();
                  return { id: button.id, offset: Math.abs((text.top + text.height / 2) - (box.top + box.height / 2)) };
                }),
                actions: ['testBtn', 'setActiveBtn', 'saveBtn', 'deleteBtn'].map(id =>
                  document.getElementById(id)!.getBoundingClientRect().top)
              };
            });
            expect(layout.overflow, `${mode} ${theme} ${width}px`).toBe(false);
            for (const button of layout.centers) {
              expect(button.offset, `${button.id} ${mode} ${theme} ${width}px`).toBeLessThanOrEqual(2);
            }
            if (width >= 485) expect(new Set(layout.actions).size).toBe(1);

            // WCAG contrast on the actual surfaces catches light backgrounds left in dark mode.
            const contrasts = await page.evaluate(() => {
              const rgb = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
              const luminance = (color: number[]) => color.map(n => {
                const c = n / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
              return ['#apiKey', '.profile-details', '#saveBtn', '#testBtn', '#deleteBtn'].map(selector => {
                const style = getComputedStyle(document.querySelector(selector)!);
                const foreground = luminance(rgb(style.color));
                const background = luminance(rgb(style.backgroundColor));
                return { selector, ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
              });
            });
            for (const contrast of contrasts) expect(contrast.ratio, `${contrast.selector} ${theme}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await extension.close();
    }
  });
}

test('settings tabs support keyboard navigation after modularization', async () => {
  const extension = await openPopupExtension('en-US');
  try {
    const page = await extension.context.newPage();
    await page.goto(extension.url + '?view=settings');
    await page.locator('#configTabButton').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#searchTabButton')).toBeFocused();
    await expect(page.locator('#searchTabButton')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#searchTab')).toBeVisible();
    await expect(page.locator('#configTab')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('#historyTabButton')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(page.locator('#configTabButton')).toBeFocused();
  } finally {
    await extension.close();
  }
});
