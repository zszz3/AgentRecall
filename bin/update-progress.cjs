"use strict";

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function simulatedInstallPercent(elapsedMs) {
  return Math.min(90, 10 + Math.floor(Math.max(0, elapsedMs) / 2_500));
}

function createTerminalUpdateProgress(options = {}) {
  const stream = options.stream || process.stdout;
  const timers = options.timers || globalThis;
  const now = options.now || Date.now;
  let installTimer = null;
  let installStartedAt = 0;
  let version = "";
  let lastNonTtyPhase = "";
  let lineOpen = false;

  const write = (text, final = false) => {
    if (stream.isTTY) {
      const available = Math.max(20, Number(stream.columns || 80) - 1);
      const line = text.length > available ? `${text.slice(0, available - 1)}…` : text;
      stream.write(`\r\u001b[2K${line}${final ? "\n" : ""}`);
      lineOpen = !final;
      return;
    }
    stream.write(`${text}\n`);
  };

  const stopInstallTimer = () => {
    if (installTimer !== null) timers.clearInterval(installTimer);
    installTimer = null;
  };

  const renderInstall = () => {
    const percent = simulatedInstallPercent(now() - installStartedAt);
    if (stream.isTTY) write(`正在通过 npm 安装 AgentRecall v${version}… ${percent}%`);
  };

  const phaseText = (progress) => {
    switch (progress.phase) {
      case "downloading": {
        const parts = [`正在下载更新 v${progress.version}`];
        if (Number.isFinite(progress.percent)) parts.push(`${progress.percent}%`);
        if (Number.isFinite(progress.downloadedBytes) && Number.isFinite(progress.totalBytes)) {
          parts.push(`${formatBytes(progress.downloadedBytes)}/${formatBytes(progress.totalBytes)}`);
        }
        if (Number.isFinite(progress.bytesPerSecond)) parts.push(`${formatBytes(progress.bytesPerSecond)}/s`);
        return parts.join(" · ");
      }
      case "verifying":
        return `正在校验 AgentRecall v${progress.version} 下载文件…`;
      case "staging":
        return `正在通过 npm 安装 AgentRecall v${progress.version}…${stream.isTTY ? " 10%" : ""}`;
      case "validating":
        return `正在验证应用和 Electron 运行时（AgentRecall v${progress.version}）…`;
      case "restarting":
        return `正在重新启动 AgentRecall v${progress.version}…`;
      case "error":
        return `AgentRecall v${progress.version} 更新失败。`;
      default:
        return progress.message || `正在更新 AgentRecall v${progress.version}…`;
    }
  };

  const report = (progress) => {
    version = progress.version || version;
    if (progress.phase === "staging") {
      if (installTimer === null) {
        installStartedAt = now();
        installTimer = timers.setInterval(renderInstall, 1_000);
      }
    } else {
      stopInstallTimer();
    }
    if (!stream.isTTY && lastNonTtyPhase === progress.phase) return;
    lastNonTtyPhase = progress.phase;
    write(phaseText(progress));
  };

  const complete = (completedVersion = version) => {
    stopInstallTimer();
    version = completedVersion || version;
    write(`AgentRecall v${version} 更新完成。 100%`, true);
  };

  const dispose = () => {
    stopInstallTimer();
    if (stream.isTTY && lineOpen) {
      stream.write("\n");
      lineOpen = false;
    }
  };

  return { report, complete, dispose };
}

module.exports = {
  createTerminalUpdateProgress,
  simulatedInstallPercent,
};
