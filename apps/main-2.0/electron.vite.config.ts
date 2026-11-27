import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// electron-vite launches Electron with this process's environment. Terminals hosted by
// Electron-based tools can leak ELECTRON_RUN_AS_NODE=1, which would start the app as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@agentrecall/workspace-core": resolve("../../packages/workspace-core/src/index.ts") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "live-session-worker": resolve("src/main/live-session-worker.ts"),
          "session-index-worker": resolve("src/main/session-index-worker.ts"),
          "session-backend-entry": resolve("src/main/session-backend-entry.ts"),
          "team-session-download-worker": resolve("src/main/team-session-download-worker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Browser-safe workspace schemas share the app's validator instead of
    // bundling the workspace root's second copy of Zod.
    resolve: { dedupe: ["zod"] },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "quick-search": resolve("src/renderer/quick-search.html"),
          island: resolve("src/renderer/island.html"),
        },
      },
    },
  },
});
