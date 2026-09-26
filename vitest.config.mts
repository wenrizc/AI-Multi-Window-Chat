import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  optimizeDeps: {
    // Pre-bundle the chat renderer's dependencies so the browser project does
    // not trigger a mid-run Vite reload when it first loads them.
    include: ['marked', 'marked-katex-extension']
  },
  test: {
    globals: false,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
          setupFiles: ['./test/setup/node.ts'],
          testTimeout: 15000,
          hookTimeout: 15000
        }
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['./test/setup/node.ts'],
          testTimeout: 30000,
          hookTimeout: 30000
        }
      },
      {
        test: {
          name: 'browser',
          include: ['test/component/**/*.test.ts'],
          setupFiles: ['./test/setup/browser.ts'],
          testTimeout: 30000,
          hookTimeout: 30000,
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }]
          }
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/types.ts'],
      thresholds: {
        statements: 60,
        branches: 45,
        functions: 60,
        lines: 60
      }
    }
  }
});
