# TS Forge roadmap

TS Forge should cover the complete life of a TypeScript product: create it, understand it, change it, verify it, operate it, and keep it healthy. The product remains local-first and keeps every mutation behind a reviewable action.

## Available now

- Project analysis and a reusable mental model for TypeScript, React, Next.js, React Native, Expo and React Three Fiber.
- Reviewed multi-file changes, impact analysis, isolated checks and acceptance criteria.
- pnpm-first scaffolding recipes for React/Vite, Next.js, Expo, React Three Fiber, Hono API and T3.
- Managed package scripts with bounded logs and detected loopback URLs.
- Dependency add/remove operations with lifecycle scripts disabled.
- A local interactive browser that can inspect, click, fill, press keys and capture screenshots.
- Git status, diff, log, branch creation, explicit staging, commit and non-force push.
- SSH profile testing, remote directory inspection and reviewed file upload.
- Focused tool groups, schema-aware context budgeting, concise runtime skills and on-demand full runbooks.
- Durable task checkpoints and explicit resume after stop, restart or a step limit.
- Browser selectors, waits, assertions, responsive viewports and expandable screenshot artifacts.
- Bundled product starters with source files and tested domain/HTTP/browser behavior.
- Disposable SQLite migration copies, isolated seed execution and transactional PostgreSQL migration rehearsal.
- Maintenance/security triage, registry reports, semantic rename proposals and release-readiness evidence.
- An opt-in MCP client for stdio and Streamable HTTP with schema validation, exact tool grants and audited calls.

Foundations below are implemented in part. Checked items describe available behavior; unchecked items retain the release work and deeper product integrations.

## 0.3 — Visible build loop

- [x] Processes panel with bounded logs, ports, HTTP readiness and stop/restart controls.
- [x] Separate Build preview and shared agent browser with responsive viewports.
- [x] Browser actions, expandable screenshots, test evidence and package artifacts.
- [x] Persist process identity and reject reused PIDs during recovery/stop.
- [ ] Embed the same agent browser session beside chat.
- [ ] Complete real-model Electron coverage for scaffold → install → edit → test → browser → local commit.

## 0.4 — T3 and product applications

- [x] Static tRPC procedure/caller and Prisma/Drizzle schema/index/migration evidence.
- [x] Disposable SQLite/PostgreSQL services and isolated SQLite package-script seeds.
- [x] Reviewed SQL migration rehearsal separate from source changes.
- [x] Local HTTP request/response assertions and bundled API contract tests.
- [x] Runnable SaaS, storefront, dashboard, API and monorepo development starters.
- [ ] Semantic tRPC/React Query graph, generated-client compatibility and OpenAPI schema diffing.
- [ ] Production identity, persistence, checkout/webhooks and background jobs in product starters.
- [ ] Isolated PostgreSQL package-script seeds and representative-data migration suites.

## 0.5 — Maintenance as a first-class workflow

- Dependency health, duplicate-package and abandoned-package reports.
- Framework upgrade plans with official codemods and reversible checkpoints.
- Security review for trust boundaries, auth, authorization, secrets and supply chain.
- Performance budgets for bundles, server routes, React rendering and R3F frames.
- Flaky-test replay, failure clustering and regression bisect assistance.
- Scheduled local maintenance reports that remain quiet when nothing changed.

## 0.6 — MCP product studio

- [x] MCP client with stdio/Streamable HTTP, negotiation, per-tool grants and connection UI.
- [x] Real stdio/HTTP protocol tests, input validation, credential redaction and bounded audited calls.
- An MCP server TypeScript recipe with tools, resources, prompts, tests and inspector configuration.
- Schema and contract tests for tool inputs, structured outputs, pagination, cancellation and error behavior.
- OAuth and API-key credential references backed by the operating-system keychain.
- Local MCP registry, connection diagnostics and audit history.
- Packaging and publishing workflows for npm, Docker and hosted MCP servers.
- Usage metering hooks, plan limits and billing-provider adapters for teams that sell MCP services.

## 0.7 — Mobile and 3D verification

- Expo process management, simulator discovery, Metro logs and device screenshots.
- React Native interaction and accessibility scenarios.
- R3F scene snapshots, WebGL errors, draw calls, asset lifecycle and frame-time budgets.
- Keyboard, pointer and gamepad scenarios for browser games.

## 0.8 — Local model improvement

- Curated task trajectories with failure labels and human corrections.
- Repeatable evaluations for project understanding, implementation, browser use and tool reliability.
- Base-model comparison and hardware-aware recommendations.
- LoRA training recipes with held-out evaluation, provenance and rollback.
- Optional local vision models for screenshot understanding and visual regression review.

## Release bar

Every capability must provide a clear permission boundary, bounded output, cancellation, honest failure reporting, durable evidence and an end-to-end test. Remote commands, production databases, credentials and billing operations require narrower policies than local source edits.
