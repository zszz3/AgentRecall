import { describe, expect, it } from "vitest";
import { addCustomRedactions, applyRedactions, findRedactions, messageLink, parseMessageLink, MESSAGE_LINK_SCHEME } from "./message-tools";

describe("message links", () => {
  it("round trips environment, Unicode, separators and the first message without including content", () => {
    const locator = { sessionKey: "ssh:工作区/a?b#c&d", messageIndex: 0, fingerprint: "a".repeat(64) };
    expect(parseMessageLink(messageLink(locator))).toEqual(locator);
  });
  it.each(["https://message", "file:///tmp/test", `${MESSAGE_LINK_SCHEME}://message?index=-1`,
    `${MESSAGE_LINK_SCHEME}://message?index=0&session=a&fingerprint=${"a".repeat(64)}&extra=1`,
    `${MESSAGE_LINK_SCHEME}://message?index=0&session=a&fingerprint=${"a".repeat(64)}#execute`])("rejects %s", (url) => {
    expect(parseMessageLink(url)).toBeNull();
  });
});

describe("reviewed exports", () => {
  it("detects secrets, emails, Windows and macOS paths across the complete document", () => {
    const text = "# alice@example.com\nkey: sk-proj-abcdefghijklmnopqrstuv\nC:\\Users\\Alice\\private.txt\n/Users/alice/project\n/home/bob/work\n工具结果: password=hello123";
    const findings = findRedactions(text);
    expect(findings.map((item) => item.kind)).toEqual(["email", "secret", "path", "path", "path", "secret"]);
    const output = applyRedactions(text, findings, findings.map((item) => ({ id: item.id, replacement: item.replacement })));
    expect(output).not.toContain("alice");
    expect(output).not.toContain("hello123");
    expect(text).toContain("hello123");
  });
  it("redacts multiline private keys as a whole, without overlapping matches", () => {
    const text = "-----BEGIN PRIVATE KEY-----\nsecret=abcdef\n-----END PRIVATE KEY-----";
    const findings = findRedactions(text);
    expect(findings).toHaveLength(1);
    expect(applyRedactions(text, findings, [{ id: findings[0].id, replacement: "[KEY]" }])).toBe("[KEY]");
  });
  it("supports per-occurrence opt out and literal replacement strings without rescanning replacements", () => {
    const text = "a@example.com / a@example.com";
    const findings = findRedactions(text);
    expect(applyRedactions(text, findings, [{ id: findings[0].id, replacement: "$& email" }]))
      .toBe("$& email / a@example.com");
  });
  it("adds all exact custom matches including multibyte text", () => {
    const text = "客户甲 says [a+b]. 客户甲";
    const findings = addCustomRedactions(text, [], "客户甲");
    expect(applyRedactions(text, findings, findings.map((item) => ({ id: item.id, replacement: "" })))).toBe(" says [a+b]. ");
    expect(addCustomRedactions(text, [], "[a+b]")).toHaveLength(1);
  });
  it("rejects forged or duplicate choices and handles empty input", () => {
    expect(findRedactions("")).toEqual([]);
    expect(applyRedactions("", [], [])).toBe("");
    expect(() => applyRedactions("hello", [], [{ id: "0:5", replacement: "" }])).toThrow();
    const findings = findRedactions("a@example.com");
    const choice = { id: findings[0].id, replacement: "x" };
    expect(() => applyRedactions("a@example.com", findings, [choice, choice])).toThrow();
  });
});
