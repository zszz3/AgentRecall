import { describe, expect, it } from "vitest";
import { normalizeWorkbenchCardOrder } from "./workbench-page";

describe("saved workbench layout", () => {
  it("drops the retired Chat card while preserving the other saved positions", () => {
    expect(normalizeWorkbenchCardOrder(["skills", "chat", "sessions", "workflows", "memories", "runtimes", "mcp"]))
      .toEqual(["skills", "sessions", "workflows", "memories", "runtimes", "mcp"]);
  });
});
