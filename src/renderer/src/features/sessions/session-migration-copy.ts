import type {
  SessionMigrationProgress,
  SessionMigrationResult,
} from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";
import { migrationAgentLabel } from "../../session-ui";

export function migrationStrategyLabel(
  strategy: SessionMigrationResult["strategy"],
  language: LanguageMode,
): string {
  if (strategy === "complete") return localize(language, "complete", "完整迁移");
  if (strategy === "ai-compressed") {
    return localize(language, "AI compressed", "AI 压缩");
  }
  return localize(language, "locally truncated", "本地截断");
}

export function migrationProgressMessage(
  progress: SessionMigrationProgress,
  language: LanguageMode,
): string {
  const target = migrationAgentLabel(progress.target);
  if (progress.stage === "reading") {
    return localize(
      language,
      `Reading session for ${target}...`,
      `正在读取会话，准备迁移到 ${target}...`,
    );
  }
  if (progress.stage === "compressing") {
    const base = localize(
      language,
      `Compressing long session for ${target}...`,
      `正在压缩长会话，准备迁移到 ${target}...`,
    );
    return progress.percent != null ? `${base} ${progress.percent}%` : base;
  }
  if (progress.stage === "writing") {
    return localize(
      language,
      `Writing ${target} session...`,
      `正在写入 ${target} 会话...`,
    );
  }
  if (progress.stage === "indexing") {
    return localize(language, "Refreshing index...", "正在刷新索引...");
  }
  return localize(
    language,
    `Opening ${target}...`,
    `正在打开 ${target}...`,
  );
}
