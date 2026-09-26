# Testing

This project uses a four-layer test system. Each layer runs in the environment
where the code actually executes, from pure functions up to the packaged Chrome
extension talking to a fake LLM.

| Layer | Runner | Environment | Location |
| --- | --- | --- | --- |
| Unit | Vitest | Node | `test/unit/**/*.test.ts` |
| Integration | Vitest | Node + MSW + aimock | `test/integration/**/*.test.ts` |
| Component | Vitest Browser Mode | Chromium (Playwright) | `test/component/**/*.test.ts` |
| End-to-end | Playwright Test | Chromium + loaded extension | `test/e2e/**/*.spec.ts` |

## Commands

```bash
npm run typecheck        # tsc --noEmit
npm run test             # unit + integration + component
npm run test:unit        # test/unit
npm run test:integration # test/integration
npm run test:browser     # test/component (launches Chromium)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # V8 coverage (text, html, lcov)
npm run test:e2e         # builds nothing; expects release/ to exist
```

`npm run test:e2e` loads the built extension from `release/`, so run
`npm run build` first. On a fresh machine, install the browser once:

```bash
npx playwright install chromium
```

## Configuration

- `vitest.config.mts` declares three Vitest projects (`unit`, `integration`,
  `browser`) and the V8 coverage options. Run one with
  `npx vitest run --project browser`.
- `playwright.config.ts` points Playwright Test at `test/e2e` and runs one
  worker at a time so the shared `release/` build is loaded once.

## Shared helpers

All helpers live in `test/helpers/`.

- `chrome-mock.ts` — an environment-agnostic `chrome.*` mock covering
  `storage.local`, `runtime` (messaging, ports, `getURL`, `getManifest`),
  `tabs`, `i18n` and `runtime.onConnect`. It is installed by both setups:
  - `test/setup/node.ts` reads the real `_locales/en/messages.json` from disk
    (including `placeholders`) so message substitution matches production.
  - `test/setup/browser.ts` evaluates the real `i18n.js` so the pages under
    test use the same `t` / `updatePageTranslations` globals as the extension.
  Each test starts from a clean mock via the setup file's `beforeEach`. The
  mock exposes `getChromeState()` for seeding storage, dispatching runtime
  messages, injecting port messages and inspecting outbound messages.
- `factories.ts` — builders for `ProviderConfig`, `ModelConfig`, `ChatSession`,
  `PersistedMessage`, `RootStore`, tool definitions and a `TEST_BASE_URL`
  (`https://llm.test/v1`).
- `sse.ts` — helpers for building Server-Sent Events streams.
- `dom.ts` — browser-mode helpers: `mountExtensionHtml` mounts a real extension
  HTML file, `bootModule` imports an entry point with a cache-busting query so
  its top-level self-instantiation runs against the current DOM, and `waitFor`
  polls a condition.

## Unit tests

Pure logic with no network or DOM: shared utilities, parsers, storage,
markdown rendering, and locale/i18n parity checks (including verifying
`website-dist/` stays in sync with the source assets).

## Integration tests

HTTP is intercepted with [MSW](https://mswjs.io/) so request/response handling
can be asserted precisely.

- `providers.test.ts` covers chat-completions and responses transports,
  tool-call parsing (including the DSML fallback), streaming, and the search
  tool session.
- `background.test.ts` boots the real background service worker. `beforeAll`
  imports `src/background/index` once to register its listeners, then tests
  open a `chrome.runtime.connect` port named `PORT_NAME`, emit `start_chat`,
  and read the posted `StreamEvent`s. This verifies streaming, persistence,
  abort handling, provider connection testing, and `RENAME_CHAT`.
- `aimock.test.ts` runs a real local OpenAI-compatible server
  ([aimock](https://github.com/CopilotKit/aimock)) instead of MSW handlers to
  validate the wire contract:

  ```ts
  const mock = new LLMock({ port: 0, logLevel: 'silent' });
  mock.onMessage('aimock hello', { content: 'Hello from aimock.' });
  await mock.start();
  // ... call completeProviderTurn({ baseUrl: `${mock.url}/v1`, ... })
  await mock.stop();
  ```

  Use `mock.onToolCall(name, { toolCalls: [...] })` to return tool calls and
  `mock.getRequests()` / `mock.getLastRequest()` to inspect what the provider
  sent. Keep aimock tests in their own file: MSW is configured with
  `onUnhandledRequest: 'error'`, so isolating them avoids false failures.

## Component tests

These run the real extension pages in Chromium. Each test mounts the real HTML
and imports the TypeScript entry point, which self-instantiates:

```ts
resetDocument();
mountExtensionHtml(popupHtml);
state.seedStorage({ app_state_v4: createRootStore({ providers: [createProvider()] }) });
await bootModule('../../src/popup/index.ts');
```

Coverage by page:

- `popup.test.ts` — provider list and default selection, onboarding presets,
  creating/saving providers, connection testing status, history search, and
  prompt editing.
- `chat-window.test.ts` — sending a request over the port, streamed deltas,
  search gating without a Tavily key, the streaming override, the settings
  panel, auth failures, aborts, and `INIT_CHAT` history restoration.
- `content.test.ts` — `OPEN_CHAT_WINDOW` windows, titles, close/minimize/
  fullscreen controls, renaming (which posts `RENAME_CHAT` to the background),
  and the `Alt+N` / `Alt+M` shortcuts.

Prefer asserting observable behaviour (DOM, storage, posted messages) over
implementation details.

## End-to-end test

`test/e2e/extension.spec.ts` launches a persistent Chromium context with the
built `release/` extension loaded, starts an aimock server, seeds a provider
that points at it, opens the real `chat-window.html` page, sends a message, and
asserts the answer renders and the conversation is persisted to
`chrome.storage.local`.

If the extension needs a specific Chromium, Playwright is pinned to a version
whose bundled browser is available in the environment. Do not upgrade
Playwright without verifying a browser install succeeds.

## Adding tests

1. Pick the lowest layer that can exercise the code: pure logic in `unit`,
   provider/background behaviour in `integration`, page behaviour in
   `component`, and only full extension wiring in `e2e`.
2. Reuse the factories and, for HTTP, either an MSW handler or aimock — not
   both in the same file.
3. Keep tests deterministic: `waitFor` / `expect.poll` for async work, no fixed
   sleeps, and no reliance on real network or external APIs.
4. Run `npm run typecheck` and the affected project before opening a PR.
