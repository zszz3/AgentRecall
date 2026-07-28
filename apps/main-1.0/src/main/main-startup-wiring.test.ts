import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("main process startup wiring", () => {
  it("waits for full application initialization before showing a second-instance window", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const secondInstanceBlock = source.match(
      /app\.on\("second-instance",[\s\S]*?\n\s*}\);\n/,
    )?.[0];

    expect(secondInstanceBlock).toBeDefined();
    expect(secondInstanceBlock).toContain("applicationReady.then(() => showWindow())");
    expect(secondInstanceBlock).not.toContain("app.whenReady().then(() => showWindow())");
  });
});
