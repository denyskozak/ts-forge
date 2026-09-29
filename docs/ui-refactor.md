# Functional refactor and UI responsiveness

## Structure

- `src/state/run-view.ts`: pure reducer for run lifecycle, hydration, streamed text, approvals, messages and changes. Completion uses the saved session as the authoritative result. Duplicate message IDs are ignored.
- `src/hooks/useAgentEvents.ts`: IPC subscription and text batching, with cleanup. Tokens and training logs use a 50 ms one-shot timer, flushed before final events. Idle sessions have no periodic flush timer.
- `src/components/MessageHistory.tsx`: memoized history and rows with stable capture callback. New tokens do not reparse old Markdown. The initial view renders the last 60 messages; earlier messages can be revealed in batches. Collapsed tools do not mount their output.
- `src/components/Diff.tsx` / `src/diff.worker.ts`: memoized comparison with computation outside the renderer's main thread. A bounded comparison falls back to full snapshots on expensive input or worker failure. Changed inputs cancel the old worker.
- `src/TrainingPage.tsx` and `src/components/ui.tsx`: extracted page and shared presentation components. Training history displays the latest jobs first.
- `shared/project-map.ts`: pure ranking and formatting, separated from filesystem/model/cache operations. Each entry is scored once; fitting uses binary search over complete entry prefixes.

Streaming text is shown as plain text while generation runs, then formatted as Markdown when finalized. Automatic scrolling uses a single animation frame instead of repeatedly starting smooth-scroll animations. It still stops when the user scrolls away from the bottom.

This refactor targets UI state and pure transformations. Stateful database/process controllers and React's Error Boundary keep their existing lifecycle ownership.

## Validation

Run `npm test`, `npm run test:desktop`, and `npm run test:ui`.

The native stress fixture contains 600 messages, including large tool outputs. It checks a 60-row initial view, revealing 60 older rows, lazy tool expansion and typing during 500 streamed IPC chunks. One local run measured 12 ms for the Playwright typing round trip, a maximum frame gap of 18.5 ms, and no observed tasks above 50 ms during the short sampling interval. These are fixture observations, not a before/after benchmark or a guarantee for every project. A follow-up review found that this fixture sends tokens while the session is idle: it does not mount the visible streaming response. It also prints timing metrics without performance failure thresholds. Full active-stream rendering still needs a separate benchmark; see [the latest review](./next-improvements.md).

The desktop smoke additionally waits for the actual worker-rendered diff before approving a change, and checks reload, undo, TypeScript tools and training dataset UI. Async persistence assertions poll resolved state rather than treating a pending Promise as success.

Validation completed: 35/35 automated tests, TypeScript build, native stress fixture and desktop smoke in the packaged app at `release/v0.2-ui/mac-arm64/Forge.app`.
