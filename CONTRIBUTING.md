# Contributing

Forge currently targets macOS Apple Silicon. Use Node 22.23.1, `npm ci`, and `npm run dev`.

Before proposing a change, run `npm test` and `npm run test:desktop`. The desktop suite uses temporary state and a local fixture server; it requires no model downloads. `npm run eval:local` is an optional real-model baseline using an already installed Ollama model. It automatically approves edits only in its generated temporary project.

Keep runtime requests on loopback, validate IPC inputs, and preserve file policy across every access path. Tool errors and incomplete scans must be explicit. Never add project scripts to the main process. New platforms need an executor with tested filesystem and network restrictions.

Do not commit prompts, source from private projects, model weights, training datasets, credentials, or local state. Reproduce bugs with synthetic fixtures. Include migration tests when changing persisted schemas. MIT covers Forge code; third-party weights and datasets retain their own licenses.
