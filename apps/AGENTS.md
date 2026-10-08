# Application development

For the Electron applications (`main-1.0` and `main-2.0`), apply these process boundaries. The CLI remains headless and delegates shared configuration and asset operations to [workspace-core](../packages/workspace-core/AGENTS.md).

## Electron boundaries

- The main process owns filesystem access, databases, credentials, child processes, native dialogs, menus, and other privileged OS operations. The renderer requests those operations through the preload API.
- Keep the preload surface narrow and typed. An IPC change updates the shared channel contract, main handler, preload API, renderer-facing types, and boundary tests together.
- Renderer imports must be browser-safe. Do not pull a module importing `node:*`, Electron main APIs, database clients, or process-control code into a renderer bundle. Treat Vite browser-externalization warnings as a boundary problem, not harmless noise.
- Validate untrusted values at real boundaries: files, durable records, IPC, subprocess output, network responses, model/tool JSON, and user input. Trust TypeScript for typed same-process calls instead of duplicating runtime checks everywhere.
- Keep secrets in the owning main-process service and expose only the minimum renderer state needed for the UI.
- Enforce permissions and destructive decisions in the operation that performs the action. Hiding a renderer button or filtering a prompt is not enforcement when another caller can reach the executor.
- Publish renderer-visible state and notifications only after the owning operation commits. Derive caches and UI projections from one authoritative source instead of independently mutating parallel copies.
