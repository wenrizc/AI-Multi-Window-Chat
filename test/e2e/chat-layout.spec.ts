import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('chat-window.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const css = readFileSync(resolve('ui/tokens.css'), 'utf8') + readFileSync(resolve('chat-window.css'), 'utf8');

for (const size of [{ width: 460, height: 560 }, { width: 320, height: 360 }, { width: 690, height: 830 }]) {
  test(`chat layout keeps context compact and messages scrollable at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.setContent(html);
    await page.addStyleTag({ content: css });
    for (const hasContext of [false, true]) {
      await page.locator('#sessionContext').evaluate((element, enabled) => {
        element.innerHTML = enabled ? '<span class="context-chip">deepseek-v4-flash</span><span class="context-chip">Prompt</span>' : '';
      }, hasContext);
      const bounds = await page.evaluate(() => {
        const rect = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        };
        return {
          context: rect('#sessionContext'), messages: rect('#messagesContainer'),
          welcome: rect('.welcome-message'), composer: rect('.input-container'),
          input: rect('#messageInput'), attach: rect('#attachmentBtn'), send: rect('#sendBtn'),
          hiddenTray: getComputedStyle(document.querySelector('#attachmentTray')!).display
        };
      });
      if (hasContext) {
        expect(bounds.context.height).toBeLessThan(40);
        expect(bounds.messages.top).toBeGreaterThanOrEqual(bounds.context.bottom);
      }
      expect(bounds.messages.height).toBeGreaterThan(size.height * 0.6);
      expect(bounds.welcome.height).toBeLessThanOrEqual(bounds.messages.height);
      expect(bounds.composer.top).toBeGreaterThanOrEqual(bounds.messages.bottom);
      expect(bounds.composer.bottom).toBeLessThanOrEqual(size.height);
      expect(bounds.hiddenTray).toBe('none');
      expect(bounds.attach.height).toBe(bounds.send.height);
      expect(Math.abs(bounds.input.bottom - bounds.send.bottom)).toBeLessThan(1);
    }
    await page.locator('#messagesContainer').evaluate(element => {
      element.innerHTML = Array.from({ length: 30 }, () => '<div class="message message-assistant"><div class="message-content">A long conversation message</div></div>').join('');
    });
    const scrolling = await page.locator('#messagesContainer').evaluate(element => {
      element.scrollTop = element.scrollHeight;
      return { scrollTop: element.scrollTop, height: element.clientHeight, total: element.scrollHeight };
    });
    expect(scrolling.total).toBeGreaterThan(scrolling.height);
    expect(scrolling.scrollTop).toBeGreaterThan(0);
    await expect(page.locator('#messageInput')).toBeInViewport();
  });
}
