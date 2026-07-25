import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "update-window": resolve("src/main/update-window.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          "update-progress": resolve("src/preload/update-progress.ts"),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          "quick-search": resolve("src/renderer/quick-search.html"),
          "update-progress": resolve("src/renderer/update-progress.html"),
        },
      },
    },
  },
});
