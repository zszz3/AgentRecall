import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Copy, RefreshCw, RotateCw, Trash2 } from "lucide-react";

import type { McpCallLogEntry, McpCallMode } from "../../../../automation/contracts";
import type { AutomationApi } from "../../../../preload/automation";
import type { LanguageMode } from "../../language";
import { ResizableSplit } from "../../components/resizable-split";
import { CatalogDetail, CatalogGroup, CatalogItem, CatalogPage, CatalogSearch } from "../../ui/catalog";
import { Badge, Button, EmptyState, IconButton, Notice, Segmented } from "../../ui/primitives";
import { ipcErrorText } from "../status/status-messages";

type StatusFilter = "all" | "ok" | "error";

export type McpCallLogsApi = Pick<
  AutomationApi,
  "listMcpCallLogs" | "clearMcpCallLogs" | "onMcpCallLogs" | "restartMcpServer"
>;

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return String(timestamp);
  }
}

function formatDateTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return String(timestamp);
  }
}

function formatBytes(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatArgs(summary: string): string {
  try {
    return JSON.stringify(JSON.parse(summary), null, 2);
  } catch {
    return summary;
  }
}

function modeLabel(mode: McpCallMode, language: LanguageMode): string {
  if (mode === "direct") return language === "zh" ? "直出 (Direct)" : "Direct";
  if (mode === "indexed") return language === "zh" ? "按需网关 (Indexed)" : "Indexed gateway";
  return language === "zh" ? "内置工具 (Built-in)" : "Built-in";
}

/**
 * Live ring-buffer view of MCP tool invocations routed through AgentRecall's HTTP Hub and
 * STDIO gateway, with status/search filtering, redacted argument inspection, and server restart.
 */
export function McpCallLogsPanel({
  language,
  switcher,
  api,
}: {
  language: LanguageMode;
  switcher: ReactNode;
  api: McpCallLogsApi;
}): ReactElement {
  const l = (en: string, zh: string) => (language === "zh" ? zh : en);
  const [logs, setLogs] = useState<McpCallLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"refresh" | "clear" | "restart" | null>(null);
  const [notice, setNotice] = useState<{ kind: "status" | "alert"; text: string } | null>(null);

  const loadLogs = useCallback(async () => {
    setBusyAction("refresh");
    setError(null);
    try {
      const next = await api.listMcpCallLogs();
      setLogs(next);
    } catch (cause) {
      setError(ipcErrorText(cause));
      setLogs((prev) => prev ?? []);
    } finally {
      setBusyAction(null);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    setError(null);
    void api.listMcpCallLogs().then(
      (next) => {
        if (active) setLogs(next);
      },
      (cause: unknown) => {
        if (active) {
          setLogs([]);
          setError(ipcErrorText(cause));
        }
      },
    );
    const unsubscribe = api.onMcpCallLogs((next) => {
      if (active) setLogs(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const counts = useMemo(() => {
    const items = logs ?? [];
    let ok = 0;
    let failed = 0;
    for (const item of items) {
      if (item.status === "error") failed += 1;
      else ok += 1;
    }
    return { all: items.length, ok, error: failed };
  }, [logs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (logs ?? []).filter((entry) => {
      if (statusFilter !== "all" && entry.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        entry.toolName,
        entry.sourceName,
        entry.sourceId,
        entry.client,
        entry.mode,
        entry.argsSummary,
        entry.error,
      ].some((field) => field?.toLowerCase().includes(needle));
    });
  }, [logs, query, statusFilter]);

  const current = filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;

  async function handleClear() {
    setNotice(null);
    setBusyAction("clear");
    try {
      const next = await api.clearMcpCallLogs();
      setLogs(next);
      setSelectedId(null);
      setNotice({ kind: "status", text: l("Call logs cleared.", "已清空调用日志。") });
    } catch (cause) {
      setNotice({ kind: "alert", text: ipcErrorText(cause) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRestart(entry: McpCallLogEntry) {
    setNotice(null);
    setBusyAction("restart");
    try {
      const restarted = await api.restartMcpServer(entry.sourceId);
      if (restarted.status === "error") {
        setNotice({
          kind: "alert",
          text: restarted.lastError
            ? l(`Restarted "${entry.sourceName}" with error: ${restarted.lastError}`, `已重启「${entry.sourceName}」，但探测失败：${restarted.lastError}`)
            : l(`Restarted "${entry.sourceName}", but connection check failed.`, `已重启「${entry.sourceName}」，但连接探测失败。`),
        });
      } else {
        setNotice({
          kind: "status",
          text: l(`Restarted "${entry.sourceName}" (${restarted.tools.length} tools).`, `已重启「${entry.sourceName}」（${restarted.tools.length} 个工具）。`),
        });
      }
    } catch (cause) {
      setNotice({ kind: "alert", text: ipcErrorText(cause) });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopy(entry: McpCallLogEntry) {
    setNotice(null);
    const payload = JSON.stringify(entry, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setNotice({ kind: "status", text: l("Copied diagnostic JSON to clipboard.", "已复制诊断 JSON 到剪贴板。") });
    } catch (cause) {
      setNotice({ kind: "alert", text: ipcErrorText(cause) });
    }
  }

  const meta = logs === null
    ? l("Loading call logs…", "正在加载调用日志…")
    : l(
      `${counts.all} recent calls${counts.error > 0 ? ` · ${counts.error} failed` : ""}`,
      `最近 ${counts.all} 次调用${counts.error > 0 ? ` · ${counts.error} 次失败` : ""}`,
    );

  const list = (
    <div className="catalog-list" aria-label={l("MCP call logs", "MCP 调用日志")}>
      <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
        <Segmented<StatusFilter>
          label={l("Filter by call status", "按调用状态筛选")}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "all", label: l("All", "全部"), count: counts.all },
            { value: "ok", label: l("OK", "成功"), count: counts.ok },
            { value: "error", label: l("Failed", "失败"), count: counts.error },
          ]}
        />
      </div>
      {filtered.length > 0 ? (
        <CatalogGroup
          title={l("Recent invocations", "最近调用")}
          hint={l("Up to 200 recent MCP calls kept in memory", "内存中保留最近 200 条 MCP 调用")}
          count={filtered.length}
        >
          {filtered.map((entry) => (
            <CatalogItem
              key={entry.id}
              title={entry.toolName}
              meta={`${formatTime(entry.startedAt)} · ${entry.sourceName} · ${entry.client}`}
              icon={
                entry.status === "error"
                  ? <AlertCircle size={13} className="text-destructive" />
                  : <CheckCircle2 size={13} className="text-success" />
              }
              trailing={
                <Badge tone={entry.status === "error" ? "danger" : "neutral"}>
                  {entry.status === "error" ? l("Error", "失败") : `${entry.durationMs}ms`}
                </Badge>
              }
              selected={current?.id === entry.id}
              onSelect={() => {
                setSelectedId(entry.id);
                setNotice(null);
              }}
            />
          ))}
        </CatalogGroup>
      ) : null}
      {logs !== null && filtered.length === 0 ? (
        <p className="catalog-list-empty">
          {query.trim() || statusFilter !== "all"
            ? l("No calls match this filter.", "没有匹配当前筛选条件的调用记录。")
            : l("No MCP tool calls recorded yet.", "尚未记录到 MCP 工具调用。")}
        </p>
      ) : null}
    </div>
  );

  const noticeLine = notice ? (
    <Notice kind={notice.kind === "alert" ? "error" : "success"}>{notice.text}</Notice>
  ) : null;

  let detail: ReactElement;
  if (!current) {
    detail = (
      <EmptyState
        title={logs === null ? l("Loading call logs…", "正在加载调用日志…") : l("No MCP tool calls yet", "暂无 MCP 调用日志")}
        description={l(
          "Calls routed through the Streamable HTTP Hub or STDIO gateway appear here in real time, with latency, status, and redacted arguments.",
          "通过 Streamable HTTP Hub 或 STDIO 网关发起的 MCP 工具调用会实时显示在这里，包含耗时、状态与脱敏参数。",
        )}
      />
    );
  } else {
    const sizeText = formatBytes(current.responseBytes);
    detail = (
      <CatalogDetail
        title={current.toolName}
        subtitle={<><span>{current.sourceName}</span> · <code>{current.sourceId}</code></>}
        facts={[
          {
            label: l("Status", "状态"),
            value: (
              <Badge tone={current.status === "error" ? "danger" : "success"}>
                {current.status === "error" ? l("Failed", "失败") : l("OK", "成功")}
              </Badge>
            ),
          },
          { label: l("Mode", "调用模式"), value: modeLabel(current.mode, language) },
          { label: l("Client", "调用客户端"), value: current.client },
          { label: l("Duration", "耗时"), value: `${current.durationMs} ms` },
          ...(sizeText ? [{ label: l("Response size", "响应体积"), value: sizeText }] : []),
          { label: l("Started at", "调用时间"), value: formatDateTime(current.startedAt) },
        ]}
        actions={
          <>
            {current.mode !== "builtin" ? (
              <Button
                size="sm"
                variant={current.status === "error" ? "primary" : "secondary"}
                icon={<RotateCw size={14} />}
                disabled={busyAction !== null}
                onClick={() => void handleRestart(current)}
              >
                {busyAction === "restart" ? l("Restarting…", "重启中…") : l("Restart server", "重启连接")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy size={14} />}
              onClick={() => void handleCopy(current)}
            >
              {l("Copy diagnostic", "复制诊断")}
            </Button>
          </>
        }
      >
        {noticeLine}
        {current.error ? (
          <section className="catalog-section">
            <h4>{l("Error", "错误信息")}</h4>
            <Notice kind="error">{current.error}</Notice>
          </section>
        ) : null}
        <section className="catalog-section">
          <h4>{l("Arguments", "请求参数")}</h4>
          <pre className="catalog-code">{formatArgs(current.argsSummary)}</pre>
          <p className="catalog-detail-status">
            {l(
              "Secret-like fields and tokens are redacted automatically. Logs stay in memory (max 200) and clear when AgentRecall closes.",
              "疑似密钥、Token 与敏感字段已自动脱敏；日志仅保存在内存中（最多 200 条），关闭应用后自动清空。",
            )}
          </p>
        </section>
      </CatalogDetail>
    );
  }

  return (
    <CatalogPage
      title="MCP"
      meta={meta}
      search={
        <CatalogSearch
          value={query}
          onChange={setQuery}
          label={l("Search MCP call logs", "搜索 MCP 调用日志")}
          placeholder={l("Search tool, source, client or error", "搜索工具、工具源、客户端或报错")}
        />
      }
      actions={
        <>
          {switcher}
          <IconButton
            label={l("Refresh call logs", "刷新调用日志")}
            icon={<RefreshCw size={15} />}
            disabled={busyAction !== null}
            onClick={() => void loadLogs()}
          />
          <IconButton
            label={l("Clear call logs", "清空调用日志")}
            icon={<Trash2 size={15} />}
            disabled={busyAction !== null || counts.all === 0}
            onClick={() => void handleClear()}
          />
        </>
      }
    >
      {error ? <Notice kind="error" className="catalog-error">{error}</Notice> : null}
      <ResizableSplit
        className="catalog-split"
        label={l("Resize the call log list", "调整调用日志列表宽度")}
        storageKey="agent-recall-mcp-logs-pane.v1"
        initialWidth={320}
        minWidth={240}
        maxWidth={480}
      >
        {list}
        <div className="catalog-detail-pane">{detail}</div>
      </ResizableSplit>
    </CatalogPage>
  );
}
