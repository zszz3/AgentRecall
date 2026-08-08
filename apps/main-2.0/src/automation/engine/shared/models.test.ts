import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  FALLBACK_MODEL_OPTIONS,
  defaultModelOption,
  modelDisplayLabel,
  runtimeModelId,
} from "./models";

describe("model naming", () => {
  it("spells out what Default means instead of showing it as a peer model", () => {
    expect(DEFAULT_MODEL_LABEL).not.toBe("Default");
    expect(DEFAULT_MODEL_LABEL).toContain("config file");
    expect(defaultModelOption()).toEqual({ id: DEFAULT_MODEL_ID, label: DEFAULT_MODEL_LABEL });
  });

  it("hands out a fresh Default option so callers can mutate their model list", () => {
    const first = defaultModelOption();
    first.label = "mutated";
    expect(defaultModelOption().label).toBe(DEFAULT_MODEL_LABEL);
  });

  it("labels every agent's Default entry the same way", () => {
    for (const [agentId, models] of Object.entries(FALLBACK_MODEL_OPTIONS)) {
      const fallbackDefault = models.find((model) => model.id === DEFAULT_MODEL_ID);
      expect(fallbackDefault, `${agentId} has no Default entry`).toBeDefined();
      expect(fallbackDefault?.label, `${agentId} Default label`).toBe(DEFAULT_MODEL_LABEL);
    }
  });

  it("renders a stored model id as its catalog label, never as a bare id", () => {
    const models = [defaultModelOption(), { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }];
    expect(modelDisplayLabel("gpt-5.6-sol", models)).toBe("GPT-5.6-Sol");
    expect(modelDisplayLabel(DEFAULT_MODEL_ID, models)).toBe(DEFAULT_MODEL_LABEL);
    // Missing or unset reads as Default, because that is what the runtime will do with it.
    expect(modelDisplayLabel(undefined)).toBe(DEFAULT_MODEL_LABEL);
    expect(modelDisplayLabel("")).toBe(DEFAULT_MODEL_LABEL);
    // An id the catalog does not know still has to be identifiable.
    expect(modelDisplayLabel("codewiz:gpt-5.6-sol", models)).toBe("codewiz:gpt-5.6-sol");
    expect(modelDisplayLabel("codewiz:gpt-5.6-sol")).toBe("codewiz:gpt-5.6-sol");
  });

  it("keeps Default out of anything sent to a runtime", () => {
    expect(runtimeModelId(DEFAULT_MODEL_ID)).toBeNull();
    expect(runtimeModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });
});
