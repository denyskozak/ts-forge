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

## 0.3 — Visible build loop

- Add a Processes panel with live logs, ports, health and stop/restart controls.
- Embed the local browser preview beside chat with desktop, tablet and phone viewports.
- Render browser actions, screenshots, test evidence and package changes as structured artifacts.
- Add restart-safe process ownership and stale-process recovery.
- Add complete Electron E2E coverage for scaffold → install → edit → test → preview → browser check → commit.

## 0.4 — T3 and product applications

- Understand tRPC routers, procedures, callers and React Query boundaries.
- Map Drizzle and Prisma schemas, migrations, indexes and generated clients.
- Add disposable PostgreSQL/SQLite development services and seed workflows.
- Validate destructive migrations separately from ordinary source changes.
- Add API contract tools for OpenAPI, tRPC and local HTTP endpoints.
- Provide project recipes for SaaS, storefront, dashboard, API and monorepo products.

## 0.5 — Maintenance as a first-class workflow

- Dependency health, duplicate-package and abandoned-package reports.
- Framework upgrade plans with official codemods and reversible checkpoints.
- Security review for trust boundaries, auth, authorization, secrets and supply chain.
- Performance budgets for bundles, server routes, React rendering and R3F frames.
- Flaky-test replay, failure clustering and regression bisect assistance.
- Scheduled local maintenance reports that remain quiet when nothing changed.

## 0.6 — MCP product studio

- A real MCP client with stdio and streamable HTTP transports, capability negotiation and per-server permissions.
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
