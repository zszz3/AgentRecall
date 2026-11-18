import { describe, expect, it } from "vitest";

import {
  buildExtractionPrompt,
  extractionSearchTerms,
  parseExtractionResponse,
  redactSecrets,
  summarizeToolOutput,
} from "./experience-extraction";
import type { MemoryCard, MemoryExtractionTurn } from "./postgres/memory-card-repository";

function turn(turnIndex: number, overrides: Partial<MemoryExtractionTurn> = {}): MemoryExtractionTurn {
  return {
    turnIndex, startedAt: "2026-11-17T03:00:00.000Z", userText: `question ${turnIndex}`, assistantText: `answer ${turnIndex}`,
    toolText: "", toolNames: [], ...overrides,
  };
}

const card: MemoryCard = {
  id: "card-1",
  projectPath: "/repo",
  kind: "experience",
  problem: "git push rejected",
  solution: "fetch and rebase first",
  previousSolution: null,
  failedAttempts: ["force push"],
  keywords: ["git", "push"],
  status: "active",
  supersededBy: null,
  model: "m",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  sources: [],
};

describe("experience extraction", () => {
  it("redacts common credential shapes", () => {
    const text = [
      "key sk-proj-abcdefghijklmnopqrstuvwx",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "aws AKIAABCDEFGHIJKLMNOP",
      "Authorization: Bearer abc.def-123456789",
      "API_KEY=hunter2hunter2",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSecrets(text);
    for (const secret of ["sk-proj-abc", "ghp_abc", "AKIAABCD", "abc.def-123456789", "hunter2", "eyJhbGci", "MIIBOgIBAAJBAK"]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("API_KEY=[redacted]");
    expect(redactSecrets("plain text stays")).toBe("plain text stays");
  });

  it("redacts credentials under quoted keys in JSON and YAML", () => {
    const text = `{"access": {"type": "api-key", "apiKey": "abcd1234efgh5678"}}\n'client_secret': 's3cr3tvalue'`;
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("abcd1234efgh5678");
    expect(redacted).not.toContain("s3cr3tvalue");
    expect(redacted).toContain(`"type": "api-key"`);
  });

  it("keeps tool names and error lines within the per-turn budget", () => {
    const toolText = ["ls -la", "total 0", "error: permission denied (publickey)", "ok", ...Array.from({ length: 200 }, (_, index) => `fatal: line ${index} failed`)].join("\n");
    const summary = summarizeToolOutput(["shell", "shell", "read"], toolText, 1000);
    expect(summary.startsWith("Tools: shell, read")).toBe(true);
    expect(summary).toContain("error: permission denied (publickey)");
    expect(summary).not.toContain("total 0");
    expect(summary.length).toBeLessThanOrEqual(1000);
    expect(summarizeToolOutput([], "", 1000)).toBe("");
  });

  it("builds a prompt with dated, redacted Turns, dated candidate cards and the output contract", () => {
    const seenCard: MemoryCard = {
      ...card,
      sources: [{ sessionKey: "s0", firstTurnIndex: 0, lastTurnIndex: 2, lastTurnAt: "2026-11-15T08:00:00.000Z" }],
    };
    const prompt = buildExtractionPrompt({
      sessionKey: "s1", source: "codex-cli", projectPath: "/repo", title: "Fix push",
      turns: [turn(3, { userText: "push fails token=abcdef123456", toolNames: ["shell"], toolText: "error: rejected" })],
    }, [seenCard]);
    expect(prompt).toContain("/repo");
    expect(prompt).toContain("### Turn 3 (2026-11-17)");
    expect(prompt).toContain("error: rejected");
    expect(prompt).toContain(`"id":"card-1"`);
    expect(prompt).toContain(`"updated":"2026-11-01","lastSeen":"2026-11-15"`);
    expect(prompt).toContain(`{"op": "confirm", "id": "<existing card id>"}`);
    expect(prompt).not.toContain("abcdef123456");
    expect(buildExtractionPrompt({ sessionKey: "s1", source: "codex-cli", projectPath: "/repo", title: "t", turns: [turn(0)] }, [card]))
      .toContain(`"updated":"2026-11-01","lastSeen":"2026-11-01"`);
  });

  it("parses create, update, confirm and supersede operations and redacts their text", () => {
    const output = "```json\n" + JSON.stringify({
      operations: [
        { op: "create", ref: "n1", kind: "decision", problem: "Push policy", solution: "Never force push; token sk-abcdefghijklmnopqrstuv", failedAttempts: [], keywords: ["git"] },
        { op: "update", id: "card-1", failedAttempts: ["git push -f"], keywords: ["rebase"] },
        { op: "confirm", id: "card-2" },
        { op: "supersede", id: "card-1", replacedBy: "n1" },
      ],
    }) + "\n```";
    const operations = parseExtractionResponse(output, ["card-1", "card-2"]);
    expect(operations).toHaveLength(4);
    expect(operations[0]).toMatchObject({ op: "create", ref: "n1", kind: "decision", problem: "Push policy" });
    expect(JSON.stringify(operations)).not.toContain("sk-abcdefghij");
    expect(operations[1]).toEqual({ op: "update", id: "card-1", failedAttempts: ["git push -f"], keywords: ["rebase"] });
    expect(operations[2]).toEqual({ op: "confirm", id: "card-2" });
    expect(parseExtractionResponse("{\"operations\":[]}", [])).toEqual([]);
  });

  it("rejects the whole batch for invalid JSON, invalid fields or ids outside the candidates", () => {
    expect(() => parseExtractionResponse("I found nothing", [])).toThrow(/JSON/);
    expect(() => parseExtractionResponse("{\"operations\":[{\"op\":\"create\",\"ref\":\"n1\",\"kind\":\"note\",\"problem\":\"p\",\"solution\":\"s\"}]}", [])).toThrow();
    expect(() => parseExtractionResponse("{\"operations\":[{\"op\":\"create\",\"ref\":\"n1\",\"kind\":\"experience\",\"problem\":\"\",\"solution\":\"s\"}]}", [])).toThrow();
    expect(() => parseExtractionResponse("{\"operations\":[{\"op\":\"update\",\"id\":\"other\",\"solution\":\"s\"}]}", ["card-1"])).toThrow(/other/);
    expect(() => parseExtractionResponse("{\"operations\":[{\"op\":\"confirm\",\"id\":\"other\"}]}", ["card-1"])).toThrow(/other/);
    expect(() => parseExtractionResponse("{\"operations\":[{\"op\":\"supersede\",\"id\":\"card-1\",\"replacedBy\":\"missing\"}]}", ["card-1"])).toThrow(/missing/);
  });

  it("derives search terms from user text, tool names and error lines including Chinese", () => {
    const terms = extractionSearchTerms([turn(0, { userText: "修复推送失败 git push rejected", toolNames: ["shell"], toolText: "error: permission denied" })]);
    expect(terms).toEqual(expect.arrayContaining(["push", "rejected", "permission", "修复推送失败"]));
    expect(terms.length).toBeLessThanOrEqual(12);
  });
});
