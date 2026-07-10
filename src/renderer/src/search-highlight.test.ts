import { describe, expect, it } from "vitest";
import { highlightedTextParts, searchHighlightTerms } from "./search-highlight";

describe("search highlighting", () => {
  it("normalizes standalone AND while preserving embedded text", () => {
    expect(searchHighlightTerms("login AND expired and android")).toEqual(["login", "expired", "android"]);
  });

  it("highlights every case-insensitive occurrence and preserves original text", () => {
    expect(highlightedTextParts("Login then LOGIN", ["login"])).toEqual([
      { text: "Login", highlighted: true },
      { text: " then ", highlighted: false },
      { text: "LOGIN", highlighted: true },
    ]);
  });

  it("treats regex metacharacters as literal text", () => {
    expect(highlightedTextParts("Use c++ and c+", ["c++"])).toEqual([
      { text: "Use ", highlighted: false },
      { text: "c++", highlighted: true },
      { text: " and c+", highlighted: false },
    ]);
  });

  it("returns plain text when no terms match", () => {
    expect(highlightedTextParts("unchanged", [])).toEqual([{ text: "unchanged", highlighted: false }]);
    expect(highlightedTextParts("unchanged", ["missing"])).toEqual([{ text: "unchanged", highlighted: false }]);
  });
});
