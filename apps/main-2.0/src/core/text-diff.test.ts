import { expect, it } from "vitest";
import { renderLineDiff } from "./text-diff";

it("preserves added, deleted and shared lines with long common prefixes", () => {
  const prefix = "shared-prefix-".repeat(1000);
  expect(renderLineDiff(`keep\n${prefix}old\nend`, `keep\n${prefix}new\nend`)).toBe(` keep\n-${prefix}old\n+${prefix}new\n end`);
  expect(renderLineDiff("", "新增")).toBe("+新增");
  expect(renderLineDiff("删除", "")).toBe("-删除");
});
it("bounds a very large newline-heavy preview and identifies omitted lines", () => {
  const result = renderLineDiff("same\n".repeat(200_000), "same\n".repeat(200_000));
  expect(result.split("\n")).toHaveLength(801);
  expect(result).toContain("diff truncated");
});
