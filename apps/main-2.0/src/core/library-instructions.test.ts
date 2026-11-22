import { describe, expect, it } from "vitest";
import { LIBRARY_BEGIN, LIBRARY_END, hasMagpieBlock, ownedBlock, personalParagraphs, withOwnedBlock, withoutParagraphs } from "./library-instructions";

describe("library instructions", () => {
  it("adds the Library block after the user's own text, replaces it, and removes it", () => {
    const added = withOwnedBlock("# Mine\n\nKeep this.\n", "Answer in Chinese.");
    expect(added).toBe(`# Mine\n\nKeep this.\n\n${LIBRARY_BEGIN}\nAnswer in Chinese.\n${LIBRARY_END}\n`);
    expect(ownedBlock(added)).toBe("Answer in Chinese.");

    const replaced = withOwnedBlock(`${added}\nAfter.\n`, "Use English commits.");
    expect(replaced).toBe(`# Mine\n\nKeep this.\n\n${LIBRARY_BEGIN}\nUse English commits.\n${LIBRARY_END}\n\nAfter.\n`);

    expect(withOwnedBlock(replaced, null)).toBe("# Mine\n\nKeep this.\n\nAfter.\n");
    expect(withOwnedBlock(withOwnedBlock("", "x"), null)).toBe("");
    expect(ownedBlock("plain")).toBeNull();
  });

  it("refuses a file with a broken or repeated Library block instead of guessing", () => {
    expect(() => ownedBlock(`${LIBRARY_BEGIN}\nno end`)).toThrow(/Library block/);
    expect(() => ownedBlock(`${LIBRARY_BEGIN}\na\n${LIBRARY_END}\n${LIBRARY_BEGIN}\nb\n${LIBRARY_END}`)).toThrow(/Library block/);
    expect(() => withOwnedBlock(`${LIBRARY_END}\n${LIBRARY_BEGIN}`, "x")).toThrow(/Library block/);
  });

  it("lists the user's own paragraphs without any tool's managed block", () => {
    const text = [
      "# Habits",
      "",
      "Answer in Chinese.",
      "",
      LIBRARY_BEGIN, "from library", LIBRARY_END,
      "",
      "<!-- agentrecall:team begin -->", "team rule", "<!-- agentrecall:team end -->",
      "",
      "<!-- magpie:begin · written by magpie from its Library -->", "magpie rule", "<!-- magpie:end -->",
      "",
      "  Run   tests  first.  ",
    ].join("\r\n");
    expect(personalParagraphs(text)).toEqual(["# Habits", "Answer in Chinese.", "Run tests first."]);
    expect(hasMagpieBlock(text)).toBe(true);
    expect(hasMagpieBlock("plain")).toBe(false);
  });

  it("removes chosen paragraphs and keeps every managed block and the rest of the user's text", () => {
    const team = "<!-- agentrecall:team begin -->\nteam\n\nrule\n<!-- agentrecall:team end -->";
    const text = `Answer   in Chinese.\n\n${team}\n\nPrefer rg.\n\nAnswer in Chinese.\n`;
    expect(withoutParagraphs(text, new Set(["Answer in Chinese."]))).toBe(`${team}\n\nPrefer rg.\n`);
    expect(withoutParagraphs("only\n", new Set(["only"]))).toBe("");
  });
});
