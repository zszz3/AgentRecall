import { describe, expect, it } from "vitest";
import { readStoredTheme, resolveTheme } from "./theme";

describe("theme", () => {
  it("follows the system until a theme is chosen and opens the retired warm theme as light", () => {
    expect(readStoredTheme(null)).toBe("system");
    expect(readStoredTheme("unexpected")).toBe("system");
    expect(readStoredTheme("light")).toBe("light");
    expect(readStoredTheme("dark")).toBe("dark");
    expect(readStoredTheme("warm")).toBe("light");
  });

  it("resolves the system theme from the operating system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
