import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/live',
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/deepseek',
  // A trace can capture the API key passed into chrome.storage.local.
  use: { trace: 'off', screenshot: 'off', video: 'off' }
});
