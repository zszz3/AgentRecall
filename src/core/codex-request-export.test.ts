import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findLatestCodexTraceRequest,
  reconstructCodexResponsesRequest,
  resolveCodexResponsesRequest,
} from "./codex-request-export";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-export-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJsonLines(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("Codex request export", () => {
  it("returns the newest exact request captured for the matching thread", async () => {
    const root = temporaryDirectory();
    const bundle = path.join(root, "trace-bundle-thread-1");
    fs.mkdirSync(path.join(bundle, "payloads"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "payloads", "old.json"), JSON.stringify({ model: "old" }));
    fs.writeFileSync(path.join(bundle, "payloads", "new.json"), JSON.stringify({ model: "gpt-5", stream: true, parallel_tool_calls: true }));
    writeJsonLines(path.join(bundle, "trace.jsonl"), [
      { wall_time_unix_ms: 1, payload: { type: "inference_started", thread_id: "thread-1", request_payload: { path: "payloads/old.json" } } },
      { wall_time_unix_ms: 3, payload: { type: "inference_started", thread_id: "other", request_payload: { path: "payloads/ignored.json" } } },
      { wall_time_unix_ms: 2, payload: { type: "inference_started", thread_id: "thread-1", request_payload: { path: "payloads/new.json" } } },
    ]);

    expect(await findLatestCodexTraceRequest(root, "thread-1")).toEqual({ model: "gpt-5", stream: true, parallel_tool_calls: true });
  });

  it("does not read a trace payload outside its bundle", async () => {
    const root = temporaryDirectory();
    const bundle = path.join(root, "trace-bundle-thread-1");
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(root, "outside.json"), JSON.stringify({ secret: true }));
    writeJsonLines(path.join(bundle, "trace.jsonl"), [
      { payload: { type: "inference_started", thread_id: "thread-1", request_payload: { path: "../outside.json" } } },
    ]);

    expect(await findLatestCodexTraceRequest(root, "thread-1")).toBeNull();
  });

  it("reconstructs persisted Responses fields and tools", async () => {
    const root = temporaryDirectory();
    const rollout = path.join(root, "rollout.jsonl");
    writeJsonLines(rollout, [
      { type: "session_meta", payload: {
        id: "thread-1",
        session_id: "session-1",
        base_instructions: { text: "Follow the repository instructions." },
        dynamic_tools: [{ Function: {
          name: "lookup",
          description: "Look up a record",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        } }],
      } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.4", effort: "high", summary: "concise" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find it" }] } },
      { type: "response_item", payload: { type: "function_call", name: "lookup", call_id: "call-1", arguments: "{\"id\":\"42\"}" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "found" } },
    ]);

    expect(await reconstructCodexResponsesRequest(rollout)).toEqual({
      model: "gpt-5.4",
      instructions: "Follow the repository instructions.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Find it" }] },
        { type: "function_call", name: "lookup", call_id: "call-1", arguments: "{\"id\":\"42\"}" },
        { type: "function_call_output", call_id: "call-1", output: "found" },
      ],
      tools: [{ type: "function", name: "lookup", description: "Look up a record", strict: false, parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }],
      tool_choice: "auto",
      reasoning: { effort: "high", summary: "concise" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-1",
      client_metadata: { session_id: "session-1", thread_id: "thread-1", turn_id: "turn-1" },
    });
  });

  it("rebuilds legacy compaction from retained user messages and a user-role summary", async () => {
    const root = temporaryDirectory();
    const rollout = path.join(root, "rollout.jsonl");
    const message = (role: "user" | "assistant", text: string) => ({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
    });
    writeJsonLines(rollout, [
      { type: "session_meta", payload: { id: "thread-1" } },
      message("user", "first user"),
      message("assistant", "first assistant"),
      { type: "compacted", payload: { message: "summary one" } },
      message("user", "second user"),
      message("assistant", "second assistant"),
      { type: "compacted", payload: { message: "summary two" } },
      message("user", "third user"),
    ]);

    const request = await reconstructCodexResponsesRequest(rollout);
    expect(request?.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "first user" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "second user" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "summary two" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "third user" }] },
    ]);
  });

  it("rejects a trace payload symlink that resolves outside the bundle", async () => {
    const root = temporaryDirectory();
    const bundle = path.join(root, "trace-bundle-thread-1");
    fs.mkdirSync(path.join(bundle, "payloads"), { recursive: true });
    const outside = path.join(root, "outside.json");
    const linkedPayload = path.join(bundle, "payloads", "request.json");
    fs.writeFileSync(outside, JSON.stringify({ secret: true }));
    try {
      fs.symlinkSync(outside, linkedPayload, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    writeJsonLines(path.join(bundle, "trace.jsonl"), [
      { payload: { type: "inference_started", thread_id: "thread-1", request_payload: { path: "payloads/request.json" } } },
    ]);

    expect(await findLatestCodexTraceRequest(root, "thread-1")).toBeNull();
  });

  it("keeps namespaced dynamic tools and infers custom tools without duplicates", async () => {
    const root = temporaryDirectory();
    const rollout = path.join(root, "rollout.jsonl");
    writeJsonLines(rollout, [
      { type: "session_meta", payload: {
        id: "thread-1",
        dynamic_tools: [{ Namespace: {
          name: "files",
          tools: [{ Function: { name: "read", inputSchema: { type: "object" } } }],
        } }],
      } },
      { type: "response_item", payload: { type: "function_call", namespace: "files", name: "read", call_id: "call-1", arguments: "{}" } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "python", call_id: "call-2", input: "print(1)" } },
    ]);

    const request = await reconstructCodexResponsesRequest(rollout);
    expect(request?.tools).toEqual([
      {
        type: "namespace",
        name: "files",
        description: "",
        tools: [{
          type: "function",
          name: "read",
          description: "",
          strict: false,
          parameters: { type: "object" },
        }],
      },
      {
        type: "custom",
        name: "python",
        description: "Reconstructed from recorded custom tool calls; the original format was not persisted.",
      },
    ]);
  });

  it("streams large rollout files without changing item order", async () => {
    const root = temporaryDirectory();
    const rollout = path.join(root, "rollout.jsonl");
    const rows = Array.from({ length: 1_500 }, (_, index) => ({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `message-${index}` }] },
    }));
    writeJsonLines(rollout, [
      { type: "session_meta", payload: { id: "thread-1" } },
      ...rows,
    ]);

    const request = await reconstructCodexResponsesRequest(rollout);
    expect((request?.input as unknown[] | undefined)?.length).toBe(1_500);
    expect((request?.input as Array<{ content: Array<{ text: string }> }>)[1_499].content[0].text).toBe("message-1499");
  });

  it("falls back to reconstruction when no matching trace is available", async () => {
    const root = temporaryDirectory();
    const rollout = path.join(root, "rollout.jsonl");
    writeJsonLines(rollout, [
      { type: "session_meta", payload: { id: "thread-1" } },
      { type: "turn_context", payload: { model: "gpt-5" } },
    ]);

    expect(await resolveCodexResponsesRequest({ filePath: rollout, rawId: "thread-1", traceRoot: root })).toMatchObject({
      fidelity: "reconstructed",
      body: { model: "gpt-5", stream: true },
    });
  });
});
