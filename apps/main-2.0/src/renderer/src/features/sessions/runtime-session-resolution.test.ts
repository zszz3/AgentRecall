import { describe, expect, it } from "vitest";
import { runtimeSessionUnavailableMessage } from "./runtime-session-resolution";

describe("runtimeSessionUnavailableMessage", () => {
  it("distinguishes indexing delay from a Runtime that returned no Session reference", () => {
    expect(runtimeSessionUnavailableMessage(
      { status: "not_indexed", invocationId: "inv-1" },
      { en: "this run", zh: "该运行" },
      "zh",
    )).toBe("该运行对应的 Session 尚未完成索引。");
    expect(runtimeSessionUnavailableMessage(
      { status: "no_session_reference", invocationId: "inv-2", invocationStatus: "failed" },
      { en: "this run", zh: "该运行" },
      "zh",
    )).toBe("该运行的 Runtime 未返回 Session 引用。");
  });

  it("reports pending and missing invocations explicitly", () => {
    expect(runtimeSessionUnavailableMessage(
      { status: "no_session_reference", invocationId: "inv-3", invocationStatus: "pending" },
      { en: "this message", zh: "该消息" },
      "en",
    )).toContain("is still running");
    expect(runtimeSessionUnavailableMessage(
      { status: "not_recorded" },
      { en: "this message", zh: "该消息" },
      "en",
    )).toContain("No Runtime invocation");
  });
});
