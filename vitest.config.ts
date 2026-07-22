import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    minWorkers: 1,
    maxWorkers: "50%",
  },
});
