import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/benchmarks/jsonl-index.test.ts"],
    maxWorkers: 1,
  },
});
