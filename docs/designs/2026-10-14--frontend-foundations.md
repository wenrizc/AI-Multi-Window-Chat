# Frontend foundations

The settings UI had inconsistent button alignment, duplicated theme values,
and page behavior tied to both the URL and viewport size. A 34px Full settings
button rendered its text 8px above center. Dark settings controls could retain
white backgrounds after dark text colors were applied.

## Confirmed decisions

- Keep native TypeScript and esbuild for this iteration.
- Share semantic theme and control tokens through `ui/tokens.css`.
- Define button, input, select, focus and disabled states in `ui/controls.css`.
- Keep settings-specific presentation in `popup.css`, separate from HTML.
- Determine page mode from `?view=settings`, exposed as `body[data-view]`.
  Viewport rules adjust layout; they never change page identity. The existing
  `settings-page` class remains for compatibility with consumers and tests.
- Share form and list components between popup and full settings layouts.
  Card-width container queries determine compact action controls. On widths
  too small for readable controls, wrapping is allowed instead of clipping.
- Keep DOM references and timers scoped to an app instance. Dispose pending
  timers on unmount; flush pending provider drafts when the page is hidden.
- Represent unlimited storage quota and ratio as `null`. Show the used size
  without a percentage; warn only when there is an actual fixed quota.

## Module boundaries

- `src/popup/index.ts`: mount the application.
- `src/popup/app.ts`: coordinate selection, persistence and user actions.
- `src/popup/dom.ts`: create DOM references per mount.
- `src/popup/components/`: reusable lists, tabs and feedback lifecycle.
- `src/popup/features/`: provider/search forms, history view and transfers.
- `src/shared/storage.ts`: storage capabilities and persistence, without DOM.
- `src/chat/components/selectors.ts`: model, prompt, reasoning and session context view.
- `src/chat/components/attachments.ts`: attachment tray rendering and remove actions.

Views collect and render data; the app controls persistence. Feature modules
must not import the application coordinator. Avoid module-level DOM queries:
they become stale when a page is remounted in browser tests.

## Verification

Functional tests run against the built extension. Layout checks cover English
and Simplified Chinese, both themes, both page modes, and widths 360, 485, 568,
720 and 1280px. They assert button text centering, single-row actions at normal
widths, no horizontal overflow, keyboard tab navigation, readable control
contrast, and neutral storage usage with unlimitedStorage above 10 MB.

Visual baselines cover English/Chinese popup and full settings in both themes.
They are platform-specific because system font rasterization differs. The
visual CI job uses Windows, matching the committed Windows baselines. A new
platform needs reviewed baselines before running the visual suite there.
Release validation includes the CSS and scripts referenced by extension HTML.

## Deferred work

- A React/Vue migration: reconsider when form composition or state sharing
  becomes substantially more complex. Existing modules provide migration seams.
- Breaking down the chat coordinator: handle separately with dedicated
  streaming, branching and cancellation regression coverage.
- Separate physical HTML entry points: current explicit page modes share the
  same forms without duplicating markup. Split shells if navigation diverges.

No framework migration is required for the current layout fixes. Remaining
business workflows continue to live in the coordinator and can move into
feature controllers as those workflows evolve.

The chat coordinator remains the next larger boundary. Its request lifecycle
and conversation tree should stay together until a dedicated state machine is
introduced; extracting those methods piecemeal would make streaming races
harder to reason about. The selector and attachment views are safe seams
because they render from explicit state and expose callbacks only.
