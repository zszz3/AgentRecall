import { afterEach, describe, expect, it } from "vitest";
import { defaultModelOption } from "../../shared/models";
import type { AgentChannel } from "../../shared/types";
import { startCodexChatRouter, type CodexChatRouterServer } from "./codex-chat-router";

let router: CodexChatRouterServer | null = null;

afterEach(async () => {
  await router?.stop();
  router = null;
});

function channel(models: AgentChannel["models"]): AgentChannel {
  return {
    id: "acme",
    agentId: "codex",
    label: "Acme Relay",
    models,
    // Never reached in these tests: the request is rejected before any upstream call.
    baseUrl: "http://127.0.0.1:1/v1",
  };
}

async function postResponses(body: unknown): Promise<{ status: number; message: string }> {
  const response = await fetch(`${router!.baseUrl}/acme/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { error?: { message?: string } };
  return { status: response.status, message: payload.error?.message ?? "" };
}

describe("Codex chat router model resolution", () => {
  it("refuses to forward the Default placeholder as if it were a model name", async () => {
    router = await startCodexChatRouter({ channels: () => [channel([defaultModelOption()])] });

    const { status, message } = await postResponses({ model: "default", input: [] });

    expect(status).toBe(500);
    expect(message).toContain("Acme Relay");
    expect(message).toContain("no model to send");
  });

  it("falls back to the channel's first real model when the caller asks for Default", async () => {
    router = await startCodexChatRouter({
      channels: () => [channel([defaultModelOption(), { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }])],
    });

    // The upstream is unreachable by design, so reaching a fetch failure proves a concrete
    // model was resolved rather than the request being rejected up front.
    const { status, message } = await postResponses({ model: "default", input: [] });

    expect(status).toBe(500);
    expect(message).not.toContain("no model to send");
  });

  it("keeps Default out of the model catalog it advertises to Codex", async () => {
    router = await startCodexChatRouter({
      channels: () => [channel([defaultModelOption(), { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }])],
    });

    const response = await fetch(`${router.baseUrl}/acme/models`);
    const payload = (await response.json()) as { models?: Array<{ slug?: string; display_name?: string }> };

    expect(payload.models?.map((model) => model.slug)).toEqual(["gpt-5.6-sol"]);
    expect(payload.models?.map((model) => model.display_name)).toEqual(["GPT-5.6-Sol"]);
  });
});
