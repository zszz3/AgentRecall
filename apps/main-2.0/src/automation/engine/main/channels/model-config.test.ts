import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ID } from "../../shared/models";
import type { AgentChannel } from "../../shared/types";
import { generateCodexConfigs, normalizeChannels, profileNameFor } from "./model-config";

const temporaryHomes: string[] = [];

afterEach(async () => {
  // Every test writes into its own throwaway directory, never the developer's real ~/.codex.
  await Promise.all(temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function makeCodexHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-config-codex-home-"));
  temporaryHomes.push(home);
  return home;
}

function codexChannel(overrides: Partial<AgentChannel> = {}): AgentChannel {
  return {
    id: "gateway",
    agentId: "codex",
    label: "Gateway",
    modelProvider: "gateway",
    models: [{ id: DEFAULT_MODEL_ID, label: "Default" }],
    ...overrides,
  };
}

describe("generated Codex profile names", () => {
  it("keeps synonymous model ids in separate profiles", async () => {
    const home = await makeCodexHome();
    const channel = codexChannel({
      models: [
        { id: "codewiz:gpt-5.6-sol", label: "CodeWiz Sol" },
        { id: "codewiz-gpt-5.6-sol", label: "CodeWiz Sol (dashed)" },
        { id: "CodeWiz:GPT-5.6-Sol", label: "CodeWiz Sol (cased)" },
      ],
    });

    const generated = await generateCodexConfigs([channel], home);

    // Sanitizing alone collapses all three onto one file name, so the last model written would
    // silently replace the other two and `--profile` would resolve runs to the wrong route.
    const profileNames = generated.map((file) => file.profileName);
    expect(new Set(profileNames).size).toBe(profileNames.length);
    const written = (await readdir(home)).filter((entry) => entry.endsWith(".config.toml"));
    expect(written).toHaveLength(profileNames.length);
    for (const file of generated) {
      // The Default entry the normalizer prepends deliberately pins no model.
      if (file.modelId === DEFAULT_MODEL_ID) continue;
      expect(await readFile(file.path, "utf8")).toContain(`model = "${file.modelId}"`);
    }
  });

  it("leaves an already legal profile part unsuffixed", () => {
    const channel = codexChannel({ id: "gateway", models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }] });
    // A dot is not a legal TOML section character, so that part is rewritten and disambiguated.
    expect(profileNameFor(channel, "gpt-5.6-sol")).toMatch(/^multi-agent-gateway-gpt-5-6-sol-[0-9a-f]{8}$/);
    // Nothing was rewritten here, so the readable name survives untouched.
    expect(profileNameFor(channel, "gpt-56-sol")).toBe("multi-agent-gateway-gpt-56-sol");
  });
});

describe("stale generated profile cleanup", () => {
  it("removes profiles this app wrote and no longer generates", async () => {
    const home = await makeCodexHome();
    const before = await generateCodexConfigs(
      [codexChannel({ models: [{ id: "old-model", label: "Old" }] })],
      home,
    );
    expect(before.map((file) => file.modelId)).toContain("old-model");

    await generateCodexConfigs([codexChannel({ models: [{ id: "new-model", label: "New" }] })], home);

    const remaining = await readdir(home);
    expect(remaining).toContain("multi-agent-gateway-new-model.config.toml");
    expect(remaining).not.toContain("multi-agent-gateway-old-model.config.toml");
  });

  it("never deletes a hand-written profile that happens to match the name pattern", async () => {
    const home = await makeCodexHome();
    const handWritten = path.join(home, "multi-agent-mine.config.toml");
    await writeFile(handWritten, 'model = "my-own-model"\n', "utf8");

    await generateCodexConfigs([codexChannel({ models: [{ id: "new-model", label: "New" }] })], home);

    // Without the generated header there is no proof this app wrote the file, so it stays.
    expect(await readFile(handWritten, "utf8")).toBe('model = "my-own-model"\n');
  });
});

describe("official Codex channel model list", () => {
  it("does not stack a bare model next to the gateway-prefixed one it already routes", () => {
    const [channel] = normalizeChannels([{
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      modelProvider: "openai",
      models: [{ id: "codewiz:gpt-5.6-sol", label: "CodeWiz Sol" }],
    }]);

    const ids = channel.models.map((model) => model.id);
    // The gateway id is the one that actually routes, so it stays and the bare duplicate the
    // built-in catalog would have added is suppressed.
    expect(ids).toContain("codewiz:gpt-5.6-sol");
    expect(ids).not.toContain("gpt-5.6-sol");
    // The catalog still contributes the reasoning levels the channel left unspecified.
    const sol = channel.models.find((model) => model.id === "codewiz:gpt-5.6-sol");
    expect(sol?.label).toBe("CodeWiz Sol");
    expect(sol?.reasoningEfforts).toContain("xhigh");
  });

  it("keeps different gateway prefixes of the same model as separate routes", () => {
    const [channel] = normalizeChannels([{
      id: "codex-openai",
      agentId: "codex",
      label: "Codex OpenAI",
      modelProvider: "openai",
      models: [
        { id: "codewiz:gpt-5.6-sol", label: "CodeWiz Sol" },
        { id: "clawbot:gpt-5.6-sol", label: "Clawbot Sol" },
      ],
    }]);

    const ids = channel.models.map((model) => model.id);
    expect(ids).toContain("codewiz:gpt-5.6-sol");
    expect(ids).toContain("clawbot:gpt-5.6-sol");
  });
});
