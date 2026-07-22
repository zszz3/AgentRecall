import { describe, expect, test } from "vitest";
import { updateEntityDraft } from "./useEntityDraft";

describe("entity draft boundary", () => {
  test("keeps editor updates local until the caller explicitly commits", () => {
    const source = { id: "dataset", name: "Original" };
    const draft = updateEntityDraft(source, { ...source, name: "Typing" });
    expect(source.name).toBe("Original");
    expect(draft.name).toBe("Typing");
  });

  test("preserves identity when an editor emits the current value", () => {
    const source = { id: "dataset", name: "Original" };
    expect(updateEntityDraft(source, source)).toBe(source);
  });
});
