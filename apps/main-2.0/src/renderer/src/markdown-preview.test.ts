import { describe, expect, it } from "vitest";

import { skillMarkdownBody } from "./markdown-preview";

describe("skillMarkdownBody", () => {
  it("drops the front matter the Skill header already shows", () => {
    expect(skillMarkdownBody("---\nname: review\ndescription: Review code.\n---\n\n# Review\n\nRead the diff.")).toBe("# Review\n\nRead the diff.");
    expect(skillMarkdownBody("---\r\nname: x\r\n---\r\nBody")).toBe("Body");
  });

  it("keeps documents without front matter and an unclosed block as written", () => {
    expect(skillMarkdownBody("# Title\n\n---\n\ntext")).toBe("# Title\n\n---\n\ntext");
    expect(skillMarkdownBody("---\nname: x\nno closing line")).toBe("---\nname: x\nno closing line");
  });
});
