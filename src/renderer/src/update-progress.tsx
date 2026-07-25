import { useEffect, useRef, useState } from "react";
import type { AppUpdateProgress } from "../../core/app-update-types";

export interface UpdateProgressView {
  percent: number;
  title: string;
  detail: string;
  failed: boolean;
}

function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return "";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}

export function updateProgressView(
  progress: AppUpdateProgress,
  stagingElapsedMs: number,
  previousPercent = 0,
): UpdateProgressView {
  switch (progress.phase) {
    case "checking":
      return { percent: 0, title: "正在准备更新", detail: "正在确认最新版本…", failed: false };
    case "downloading": {
      const downloadPercent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
      const speed = formatSpeed(progress.bytesPerSecond);
      return {
        percent: Math.round(downloadPercent * 0.6),
        title: "正在下载更新",
        detail: progress.percent === undefined
          ? "正在连接下载服务器…"
          : `已下载 ${downloadPercent}%${speed ? ` · ${speed}` : ""}`,
        failed: false,
      };
    }
    case "verifying":
      return { percent: 64, title: "正在校验下载", detail: "正在确认更新包完整性…", failed: false };
    case "staging":
      return {
        percent: Math.min(90, 65 + Math.floor(Math.max(0, stagingElapsedMs) / 4_800)),
        title: "正在安装更新",
        detail: "npm 正在准备新版本，耗时会随网络和磁盘速度变化…",
        failed: false,
      };
    case "validating":
      return { percent: 94, title: "正在验证应用", detail: "正在检查应用和 Electron 运行时…", failed: false };
    case "restarting":
      return { percent: 98, title: "正在重新启动", detail: "更新已准备完成，即将打开新版本…", failed: false };
    case "completed":
      return { percent: 100, title: "更新完成", detail: "AgentRecall 即将重新打开。", failed: false };
    case "error":
      return {
        percent: previousPercent,
        title: "更新未完成",
        detail: progress.error || "自动更新失败，稍后会显示手动安装方式。",
        failed: true,
      };
  }
}

function targetVersion(): string {
  return new URLSearchParams(window.location.search).get("version") || "";
}

export function UpdateProgressWindow(): React.JSX.Element {
  const version = targetVersion();
  const [progress, setProgress] = useState<AppUpdateProgress>({
    phase: "downloading",
    version,
    percent: 0,
  });
  const [now, setNow] = useState(() => Date.now());
  const stagingStartedAt = useRef<number | null>(null);
  const latestPercent = useRef(0);
  const currentPhase = useRef<AppUpdateProgress["phase"]>("downloading");

  useEffect(() => window.updateProgress.onProgress((next) => {
    if (next.phase === "staging" && currentPhase.current !== "staging") {
      stagingStartedAt.current = Date.now();
      setNow(Date.now());
    }
    currentPhase.current = next.phase;
    setProgress(next);
  }), []);

  useEffect(() => {
    if (progress.phase !== "staging") return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [progress.phase]);

  const elapsed = stagingStartedAt.current === null ? 0 : now - stagingStartedAt.current;
  const view = updateProgressView(progress, elapsed, latestPercent.current);
  if (!view.failed) latestPercent.current = Math.max(latestPercent.current, view.percent);
  const displayedPercent = view.failed ? view.percent : latestPercent.current;

  return (
    <main className={`updater-shell${view.failed ? " is-failed" : ""}`}>
      <div className="updater-mark" aria-hidden="true">
        <span>⌁</span>
      </div>
      <p className="updater-eyebrow">AgentRecall{version ? ` v${version}` : ""}</p>
      <h1>{view.title}</h1>
      <p className="updater-detail">{view.detail}</p>
      <div
        className="updater-progress"
        role="progressbar"
        aria-label="更新进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={displayedPercent}
      >
        <div className="updater-progress-fill" style={{ width: `${displayedPercent}%` }} />
      </div>
      <div className="updater-progress-meta">
        <span>{displayedPercent}%</span>
        <span>{view.failed ? "已保留当前版本" : "完成后会自动重新打开"}</span>
      </div>
    </main>
  );
}
