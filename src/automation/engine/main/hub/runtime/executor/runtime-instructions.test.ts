import { describe, expect, test } from "vitest";
import {
  combineDeveloperInstructions,
  promptWithDeveloperInstructions,
} from "./runtime-instructions";

describe("runtime instructions", () => {
  test("combines non-empty instruction layers in precedence order", () => {
    expect(combineDeveloperInstructions(" host ", undefined, "agent", "  "))
      .toBe("host\n\nagent");
  });

  test("keeps CLI prompts unchanged without instructions and labels the user request otherwise", () => {
    expect(promptWithDeveloperInstructions("Inspect the repo", undefined))
      .toBe("Inspect the repo");
    expect(promptWithDeveloperInstructions("Inspect the repo", "Follow policy"))
      .toBe("Follow policy\n\nUser request:\nInspect the repo");
  });
});
