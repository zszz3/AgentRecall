# V2 development

V2 is the preview Electron application. Inherit the root and apps-level instructions.

- Session changes follow the [session indexing spec](../../docs/spec/session-indexing.md); inspect V1 when behavior applies to both products. Await PostgreSQL store operations before publishing their results.
- Team changes follow the [team asset spec](../../docs/spec/team-assets.md). Headless formats, configuration and file ownership belong in workspace-core; native confirmation, window ownership and desktop operation lifetimes belong in main-process services.
- Keep team IPC schemas, handlers, preload and renderer types aligned. Closing a window must dispose its pending previews and operations; UI selection never authorizes a different upload snapshot.
- Runtime/Agent/Workflow/Eval changes also follow [automation instructions](src/automation/AGENTS.md) and the [Runtime spec](../../docs/spec/runtime.md). V2-only capabilities need no placeholder V1 code.
- Run focused tests from this app. Native processes, databases and ports started for tests must be isolated and stopped before completion.
