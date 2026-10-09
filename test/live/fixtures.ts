import { chromium, test as base, type BrowserContext, type Worker } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createEmptyConfig, META_KEY, CHAT_INDEX_KEY } from '../../src/shared/constants';
import type { ProviderConfig } from '../../src/shared/types';

export const modelId = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash';
export const providerId = 'live-deepseek';

export const test = base.extend<{
  context: BrowserContext;
  worker: Worker;
  hostUrl: string;
}>({
  context: async ({ headless }, use) => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error('Use npm run test:e2e:deepseek with DEEPSEEK_API_KEY in the environment or .env.');
    const extensionPath = resolve(__dirname, '../../release');
    // Chromium creates and removes its own isolated temporary profile.
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      const timestamp = new Date().toISOString();
      const provider: ProviderConfig = {
        id: providerId, name: 'DeepSeek (live test)',
        baseUrl: 'https://api.deepseek.com', apiKey,
        authMode: 'bearer', transport: 'chat_completions', defaultModel: modelId,
        defaultGenerationParams: { temperature: 0 }, headers: {},
        modelCatalog: [{ modelId, displayName: modelId, supportsStreaming: true, reasoningFormat: 'reasoning_content' }],
        createdAt: timestamp, updatedAt: timestamp
      };
      const config = createEmptyConfig();
      config.providers = [provider];
      config.featureSettings.defaultProviderId = providerId;
      await worker.evaluate(async ({ key, indexKey, config }) => {
        await chrome.storage.local.set({ [key]: config, [indexKey]: [] });
      }, { key: META_KEY, indexKey: CHAT_INDEX_KEY, config });
      await use(context);
    } finally {
      await context.close();
    }
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker'));
  },
  hostUrl: async ({}, use) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>Extension integration test</title></head><body><p>Playwright extension test page</p></body></html>');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  }
});

export { expect } from '@playwright/test';
