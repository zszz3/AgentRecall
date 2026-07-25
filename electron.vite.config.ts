import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
