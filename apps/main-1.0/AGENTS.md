# V1 development

V1 is the stable Electron application. Inherit the root and apps-level instructions.

- Read the [session indexing spec](../../docs/spec/session-indexing.md) for session changes and inspect the corresponding V2 implementation before editing.
- V1 uses SQLite and mostly synchronous store calls. Do not port V2 async assumptions or PostgreSQL migration code into this app.
- Preserve independent V1 data, MCP and release identities; see [ADR 0001](../../docs/adr/0001-product-data-isolation.md).
- Run focused tests from this app. Installation and discovery tests use temporary HOME, synthetic fixtures and an isolated npm prefix as required by the root instructions.
