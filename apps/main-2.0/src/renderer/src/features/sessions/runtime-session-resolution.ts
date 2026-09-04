import type { RuntimeInvocationSessionResolution } from "../../../../core/types";
import type { LanguageMode } from "../../language";

export function runtimeSessionUnavailableMessage(
  resolution: Exclude<RuntimeInvocationSessionResolution, { status: "found" }>,
  subject: { en: string; zh: string },
  language: LanguageMode,
): string {
  if (resolution.status === "not_indexed") {
    return language === "zh"
      ? `${subject.zh}对应的 Session 尚未完成索引。`
      : `The Session for ${subject.en} has not been indexed yet.`;
  }
  if (resolution.status === "no_session_reference") {
    if (resolution.invocationStatus === "pending") {
      return language === "zh"
        ? `${subject.zh}的 Runtime 调用仍在运行，尚未返回 Session 引用。`
        : `The Runtime call for ${subject.en} is still running and has not reported a Session reference.`;
    }
    return language === "zh"
      ? `${subject.zh}的 Runtime 未返回 Session 引用。`
      : `The Runtime for ${subject.en} did not return a Session reference.`;
  }
  return language === "zh"
    ? `${subject.zh}没有可追溯的 Runtime 调用记录。`
    : `No Runtime invocation was recorded for ${subject.en}.`;
}
