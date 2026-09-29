<p align="center">
  <img src="docs/assets/forge-llama-hero.png" alt="A friendly llama in graphite and copper armor guarding a local coding workspace" width="100%" />
</p>

<h1 align="center">TS Forge</h1>

<p align="center">
  <strong>A private, local-first coding agent built for TypeScript.</strong><br />
  Understand the project, discuss critical choices, review every change, and keep the entire workflow on your Mac.
</p>

<p align="center">
  Electron · React · TypeScript · Ollama · SQLite · MIT
</p>

---

TS Forge is an open-source desktop coding harness for local language models. It specializes in TypeScript projects and includes focused support for React, React Native, Expo, and Next.js.

It builds a compact mental model of each workspace before a task, gives the model controlled inspection tools, pauses for important product decisions, and requires human review before changing files or running the compiler.

## What is already working

| Area | Capability |
| --- | --- |
| **Local inference** | Connects to a tool-capable model through a loopback-only Ollama endpoint. |
| **Project understanding** | Detects frameworks, entrypoints, routes, screens, state, navigation, data boundaries, and internal import relationships. |
| **TypeScript intelligence** | Provides diagnostics, definitions, references, quick info, project configuration analysis, and an isolated full compiler check. |
| **Agent workflow** | Runs a bounded model/tool loop with streaming output, context compaction, stop handling, and persistent sessions. |
| **Critical questions** | Lets the model pause with 2–4 answer choices when a missing decision can materially change the implementation. |
| **Reviewed changes** | Uses exact source replacements, visible diffs, explicit approval, atomic writes, checkpoints, and guarded undo. |
| **Multiple workspaces** | Saves local projects, switches between them, and refreshes analysis when a workspace opens. |
| **Voice drafts** | Performs on-device speech recognition, shows a live waveform, and inserts the transcript without sending it. |
| **Training lab** | Builds reviewed datasets and launches experimental MLX LoRA jobs in a separate local workspace. |

## Why this harness exists

Small local models need more structure than a chat box. TS Forge supplies that structure:

- A project map gives the model the useful parts of the repository without sending every file on every turn.
- Read tools expose bounded source ranges with hashes and explicit completeness information.
- TypeScript tools answer semantic questions without granting a general shell.
- A critical-question gate prevents the agent from guessing about architecture, behavior, scope, or destructive choices.
- File edits and compiler runs wait for the user.
- SQLite records sessions, tool trajectories, checkpoints, and recovery state locally.

## Quick start

### Requirements

- macOS on Apple Silicon
- Node.js 22.23.1
- An installed [Ollama](https://ollama.com/) runtime
- A local Ollama model with tool-calling support

### Run from source

```sh
git clone git@github.com:denyskozak/ts-forge.git
cd ts-forge
npm ci
npm run dev
```

In **Settings**, enter the Ollama endpoint and local model name, then select **Test connection**. The check validates discovery, local/tool capability, and real generation before you save the settings.

The endpoint must be an HTTP loopback address such as `http://127.0.0.1:11434`. Model downloads and Ollama configuration remain explicit setup steps outside Forge.

### First task

1. Open a TypeScript project from the workspace picker.
2. Wait for the automatic project and TypeScript analysis.
3. Describe a task in the composer, or dictate an editable voice draft.
4. Answer a critical clarification if the model needs a decision that the repository cannot provide.
5. Review each proposed diff or compiler request.
6. Apply, decline, stop, or undo from the interface.

## Project understanding

Forge creates a model-oriented map for every workspace. The map contains file paths, symbols, imports, exports, framework evidence, and a higher-level mental model of the application.

For React and Next.js projects it identifies entrypoints, routes, components, hooks, state, and data access. For React Native and Expo it also traces screens, navigation, native boundaries, and platform-specific files.

The index is bounded and reports when a scan is incomplete. Source text is loaded only through explicit read tools or a small task-relevant architecture slice.

## Critical clarification loop

Before choosing actions on each step, the local model checks whether one missing user decision could substantially change:

- architecture;
- observable behavior;
- data-loss risk;
- task scope.

When that happens, the model calls `ask_user_question` with 2–4 concrete options. Forge enters a persisted waiting state and returns the selected option to the same model/tool loop. If the model asks a question alongside other tool calls, those sibling actions are skipped until the answer arrives.

The agent is instructed to inspect the repository instead of asking about discoverable facts, and to use a safe reversible default for low-impact choices.

![TS Forge clarification UI](docs/forge-clarification.png)

## Privacy and execution boundaries

TS Forge has no account, telemetry, cloud-model integration, or hosted backend.

- Model requests accept HTTP loopback endpoints only.
- Redirects and cloud model entries are rejected.
- Electron uses a sandboxed renderer, validated IPC, restricted navigation, and microphone-only media permission.
- Workspace reads reject ignored paths, conventional secrets, symlink escapes, binaries, and oversized files.
- The agent has no general terminal tool.
- Compiler execution uses a bundled TypeScript binary in a restricted macOS process with network access denied.
- Voice recognition is forced into Chromium's on-device mode and has no remote fallback.

An external Ollama process remains part of the local trust boundary. SQLite databases, checkpoints, logs, and training data are stored as plaintext in Electron's local `userData` directory shown in Settings.

See [SECURITY.md](SECURITY.md) for the threat model and current limitations.

## Build and test

```sh
npm run typecheck       # TypeScript validation
npm test                # Harness, persistence, security, map, tools, and state tests
npm run build           # Production renderer and Electron bundles
npm run test:desktop    # Real Electron UI and IPC smoke test
npm run test:ui         # UI stress fixture
npm run package         # Unsigned macOS app bundle
```

Optional local-model evaluations:

```sh
npm run eval:local
npm run eval:understanding
```

Desktop tests create temporary workspaces and local fixture servers. The smoke test exercises voice input, settings, multiple workspaces, automatic analysis, clarification recovery after renderer reload, reviewed changes, TypeScript checks, undo, skills, and training data.

## Harness architecture

The renderer never receives Node.js access. A small preload bridge exposes typed operations to the Electron main process, where the durable agent loop validates every model tool call. Project inspection, mutations, compiler execution, persistence, and local inference remain separate capabilities with explicit boundaries.

<p align="center">
  <img src="docs/assets/forge-harness-architecture.svg" alt="TS Forge harness architecture diagram" width="100%" />
</p>

### Repository map

```text
src/                        React UI, run state, voice input, review controls
electron/main.ts            Electron lifecycle, permission policy, typed IPC
electron/agent.ts           Model loop, tools, clarifications, approvals
electron/store.ts           SQLite state, journal, snapshots, map cache
electron/workspace.ts       File policy, bounded reads, checked atomic edits
electron/project-map.ts     Cached TypeScript project map and context rendering
electron/mental-model.ts    React, React Native, Expo, and Next.js relationships
electron/language-tools.ts  TypeScript diagnostics and symbol queries
electron/executor.ts        Restricted macOS subprocess execution
electron/training.ts        Reviewed datasets and local MLX job lifecycle
shared/                     IPC contracts, settings, skills, shared map types
tests/                      Harness, hardening, reducer, and Electron smoke tests
```

## Training lab

Training is experimental and separate from inference. Ollama serves the active model; MLX trains adapters on Apple Silicon.

Forge can collect a completed response as a draft example with its task and tool context. Nothing enters a dataset automatically. Examples must be reviewed before export, and the dataset builder groups related tasks to avoid leaking the same family across training and validation splits.

See the [training plan](docs/training-plan.md) for the current workflow and open evaluation work.

## Documentation

- [Documentation index](docs/README.md)
- [Project map](docs/articles/project-map.ru.md)
- [React and React Native project understanding](docs/articles/project-understanding.ru.md)
- [TypeScript agent tools](docs/articles/typescript-agent-tooling.ru.md)
- [Critical clarification workflow](docs/articles/critical-clarifications.ru.md)
- [On-device voice input](docs/articles/voice-input.ru.md)
- [Production review](docs/next-improvements.md)
- [Contributing](CONTRIBUTING.md)

## Current limits

- The supported execution target is macOS on Apple Silicon.
- App signing, notarization, updates, and clean-install release testing are still open work.
- The project map uses bounded indexing and approximate token estimates.
- A full Electron restart marks an active run as interrupted; a renderer reload reconnects to pending approval or clarification.
- MLX training quality, adapter import, and broader coding benchmarks still need production validation.

## License

TS Forge is available under the [MIT License](LICENSE). Model weights and datasets keep their own licenses.
