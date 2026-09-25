import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@agentrecall/workspace-core": resolve("../../packages/workspace-core/src/index.ts") },
    dedupe: ["zod", "yaml", "proper-lockfile"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    minWorkers: 1,
    maxWorkers: "50%",
  },
});
