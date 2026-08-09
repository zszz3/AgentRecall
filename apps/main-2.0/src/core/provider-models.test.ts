import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeVerifiedConfig } from "./atomic-config-write";
import { parseProviderModels, probeProviderModels, providerModelsEndpoint, providerModelsEndpoints } from "./provider-models";

describe("provider model discovery", () => {
  it("accepts common model response shapes without dropping namespaced IDs", () => {
    expect(parseProviderModels({ data: [{ id: "codewiz:gpt-5.6-sol" }, { id: "gh:gpt-5.5" }] })).toEqual([
      "codewiz:gpt-5.6-sol",
      "gh:gpt-5.5",
    ]);
    expect(parseProviderModels({ models: ["clawbot:gpt-5.5", { slug: "dibp:claude-4" }] })).toEqual([
      "clawbot:gpt-5.5",
      "dibp:claude-4",
    ]);
    expect(parseProviderModels({ models: { "codewiz:gpt-5.6-sol": {}, "gh:gpt-5.5": { owned_by: "github" } } })).toEqual([
      "codewiz:gpt-5.6-sol",
      "gh:gpt-5.5",
    ]);
    expect(parseProviderModels({ "clawbot:gpt-5.5": {}, "dibp:claude-4": { label: "Claude" } })).toEqual([
      "clawbot:gpt-5.5",
      "dibp:claude-4",
    ]);
  });

  it("normalizes model endpoints and reports the endpoint on HTTP failures", async () => {
    expect(providerModelsEndpoint("https://api.example/v1/")).toBe("https://api.example/v1/models");
    expect(providerModelsEndpoint("https://api.example/v1/models")).toBe("https://api.example/v1/models");
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) }));
    await expect(probeProviderModels({ baseUrl: "https://api.example/v1", apiKey: "secret" }, fetchImpl)).rejects.toThrow(
      "Model detection failed at https://api.example/v1/models (403 Forbidden).",
    );
  });

  it("asks every catalog surface a gateway may expose and merges what they return", async () => {
    expect(providerModelsEndpoints("https://api.example/relay")).toEqual([
      "https://api.example/relay/models",
      "https://api.example/relay/v1/models",
      "https://api.example/v1/models",
    ]);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://api.example/relay/models") {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "codewiz:gpt-5.6-sol" }] }) };
      }
      if (url === "https://api.example/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "gh:gpt-5.5" }, { id: "dibp:claude-4" }] }) };
      }
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    });
    const result = await probeProviderModels({ baseUrl: "https://api.example/relay", apiKey: "secret" }, fetchImpl);
    expect(result.models).toEqual(["codewiz:gpt-5.6-sol", "dibp:claude-4", "gh:gpt-5.5"]);
    expect(result.endpoints).toEqual(["https://api.example/relay/models", "https://api.example/v1/models"]);
    expect(result.endpoint).toBe("https://api.example/relay/models");
  });

  it("follows catalog pagination instead of stopping at the first page", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("after_id=clawbot%3Agpt-5.5")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "dibp:claude-4" }], has_more: false }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "codewiz:gpt-5.6-sol" }, { id: "clawbot:gpt-5.5" }], has_more: true }),
      };
    });
    const result = await probeProviderModels({ baseUrl: "https://api.example/v1", apiKey: "secret" }, fetchImpl);
    expect(result.models).toEqual(["clawbot:gpt-5.5", "codewiz:gpt-5.6-sol", "dibp:claude-4"]);
  });
});

describe("model probe transport failures", () => {
  /** What `fetch` throws when it never reaches the server: a bare message plus a nested cause. */
  function fetchFailed(code: string, message = "connect failure"): TypeError {
    const cause = Object.assign(new Error(message), { code });
    return Object.assign(new TypeError("fetch failed"), { cause });
  }

  it("names the URL and the underlying reason instead of only 'fetch failed'", async () => {
    const fetchImpl = vi.fn(async () => {
      throw fetchFailed("ENOTFOUND", "getaddrinfo ENOTFOUND api.example");
    });

    // The bare "TypeError: fetch failed" the user used to see names neither the endpoint that
    // failed nor why, which leaves nothing to act on.
    await expect(probeProviderModels({ baseUrl: "https://api.example/v1", apiKey: "secret" }, fetchImpl))
      .rejects.toThrow(/could not reach https:\/\/api\.example\/v1\/models.*host name could not be resolved.*ENOTFOUND/);
  });

  it("reports one problem when every endpoint fails the same way", async () => {
    const fetchImpl = vi.fn(async () => {
      throw fetchFailed("ECONNREFUSED");
    });

    const error = await probeProviderModels({ baseUrl: "https://api.example/relay", apiKey: "secret" }, fetchImpl)
      .then(() => { throw new Error("the probe was expected to fail"); }, (thrown: Error) => thrown);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(error.message).toContain("https://api.example/relay/models, https://api.example/relay/v1/models, https://api.example/v1/models");
    expect(error.message).toContain("nothing accepted the connection");
    expect(error.message).not.toContain("fetch failed");
  });

  it("keeps an HTTP rejection's own message rather than calling it a transport failure", async () => {
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith("/relay/models")
      ? { ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}) }
      : (() => { throw fetchFailed("ENOTFOUND"); })()));

    await expect(probeProviderModels({ baseUrl: "https://api.example/relay", apiKey: "secret" }, fetchImpl))
      .rejects.toThrow("Model detection failed at https://api.example/relay/models (401 Unauthorized).");
  });

  it("gives up on a silent endpoint instead of hanging", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
      // A black-holed connection never settles; only the probe's own deadline ends it.
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });

    await expect(probeProviderModels({ baseUrl: "https://api.example/v1", apiKey: "secret" }, fetchImpl))
      .rejects.toThrow(/could not reach https:\/\/api\.example\/v1\/models: no response within 20s/);
  });
});

describe("verified config writes", () => {
  it("restores the original file when read-back verification fails", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-recall-config-write-"));
    const targetPath = path.join(directory, "config.toml");
    try {
      await writeFile(targetPath, "original\n");
      await expect(writeVerifiedConfig({
        targetPath,
        contents: "broken\n",
        verify: async () => { throw new Error("mismatch"); },
      })).rejects.toThrow("Config verification failed");
      await expect(readFile(targetPath, "utf8")).resolves.toBe("original\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
