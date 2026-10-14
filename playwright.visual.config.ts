import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/visual',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  expect: { toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.01 } },
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' }
});
