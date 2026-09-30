import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

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
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
    // Browser-safe workspace schemas share the app's validator instead of
    // bundling the workspace root's second copy of Zod.
    resolve: { dedupe: ["zod"] },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "quick-search": resolve("src/renderer/quick-search.html"),
        },
      },
    },
  },
});
