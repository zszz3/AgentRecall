import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` is included so renderer tests actually run: without it a component test file is
    // silently skipped and reads as passing.
    include: ["src/**/*.test.{ts,tsx}"],
    // Matches V2. Several suites here spawn processes and race real timers, so oversubscribing
    // the machine makes them time out under load rather than fail for a real reason.
    minWorkers: 1,
    maxWorkers: "50%",
  },
});
