import { chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEGACY_STORAGE_KEY } from '../../src/shared/constants';
import { createProvider, createRootStore } from './factories';

/** A real packaged page with stable data, including usage above the old 10 MB limit. */
export async function openPopupExtension(locale: string) {
  const extension = resolve('release');
  const userData = mkdtempSync(join(tmpdir(), 'aimw-popup-'));
  const context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium', headless: true, locale,
    args: [`--lang=${locale}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const provider = createProvider({ id: 'layout-provider', name: 'DeepSeek', defaultModel: 'deepseek-v4-flash' });
    provider.modelCatalog[0].modelId = 'deepseek-v4-flash';
    const store = createRootStore({ providers: [provider] });
    store.featureSettings.defaultProviderId = provider.id;
    await worker.evaluate(async ({ key, store }) => {
      await chrome.storage.local.set({ [key]: store, layoutUsageFixture: 'x'.repeat(11 * 1024 * 1024) });
    }, { key: LEGACY_STORAGE_KEY, store });
    return {
      context,
      url: `chrome-extension://${new URL(worker.url()).host}/popup.html`,
      async close() {
        await context.close();
        rmSync(userData, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await context.close();
    rmSync(userData, { recursive: true, force: true });
    throw error;
  }
}
