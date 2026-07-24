import type { ReactElement } from "react";
import {
  Beaker,
  BrainCircuit,
  Cpu,
  KeyRound,
  LayoutDashboard,
  MessageCircleMore,
  MessagesSquare,
  PackageSearch,
  PlugZap,
  RefreshCw,
  Settings,
  Workflow,
} from "lucide-react";
import type { IndexStatus } from "../../../core/indexer";
import { formatRelativeTime } from "../../../core/format-session";
import type { LanguageMode } from "../language";

const BRAND_LOGO_URL = new URL("../../../../assets/logo.png", import.meta.url).href;

export type AppPage =
  | "workbench"
  | "sessions"
  | "team-chat"
  | "workflows"
  | "evaluation"
  | "runtimes"
  | "mcp"
  | "memories"
  | "skills"
  | "providers";

export function AppNavigation({
  activePage,
  indexStatus,
  settingsOpen,
  signalUpdate,
  language,
  onNavigate,
  onRefresh,
  onOpenSettings,
}: {
  activePage: AppPage;
  indexStatus: IndexStatus | null;
  settingsOpen: boolean;
  signalUpdate: boolean;
  language: LanguageMode;
  onNavigate(page: AppPage): void;
  onRefresh(): void;
  onOpenSettings(): void;
}): ReactElement {
  const l = (en: string, zh: string): string => language === "zh" ? zh : en;
  return (
    <aside className="app-navigation">
      <button
        className="app-navigation-brand"
        onClick={() => onNavigate("workbench")}
        aria-label="AgentRecall"
      >
        <span className="app-navigation-brand-mark" aria-hidden="true">
          <svg viewBox="75 240 280 280">
            <image href={BRAND_LOGO_URL} width="1800" height="796" />
          </svg>
        </span>
        <strong>AgentRecall</strong>
      </button>
      <nav aria-label={l("Main navigation", "主导航")}>
        <NavigationItem page="workbench" activePage={activePage} onNavigate={onNavigate}>
          <LayoutDashboard size={18} /><span>{l("Workbench", "工作台")}</span>
        </NavigationItem>
        <NavigationItem page="sessions" activePage={activePage} onNavigate={onNavigate}>
          <MessagesSquare size={18} /><span>Session</span>
        </NavigationItem>
        <NavigationItem page="team-chat" activePage={activePage} onNavigate={onNavigate}>
          <MessageCircleMore size={18} /><span>Chat</span>
        </NavigationItem>
        <NavigationItem page="workflows" activePage={activePage} onNavigate={onNavigate}>
          <Workflow size={18} /><span>Workflow</span>
        </NavigationItem>
        <NavigationItem page="evaluation" activePage={activePage} onNavigate={onNavigate}>
          <Beaker size={18} /><span>Eval</span>
        </NavigationItem>
        <NavigationItem page="runtimes" activePage={activePage} onNavigate={onNavigate}>
          <Cpu size={18} /><span>Runtime</span>
        </NavigationItem>
        <NavigationItem page="mcp" activePage={activePage} onNavigate={onNavigate}>
          <PlugZap size={18} /><span>MCP</span>
        </NavigationItem>
        <NavigationItem page="memories" activePage={activePage} onNavigate={onNavigate}>
          <BrainCircuit size={18} /><span>Memory</span>
        </NavigationItem>
        <NavigationItem page="skills" activePage={activePage} onNavigate={onNavigate}>
          <PackageSearch size={18} /><span>Skills</span>
        </NavigationItem>
        <NavigationItem page="providers" activePage={activePage} onNavigate={onNavigate}>
          <KeyRound size={18} /><span>Provider</span>
        </NavigationItem>
      </nav>
      <button
        className={`app-navigation-refresh ${indexStatus?.running ? "is-running" : ""} ${
          indexStatus?.error ? "error" : ""
        }`}
        onClick={onRefresh}
        disabled={indexStatus?.running}
        title={indexStatus?.error
          ? l("Index update failed. Click to retry.", "索引更新失败，点击重试。")
          : indexStatus?.lastIndexedAt
            ? `${l("Refresh index", "刷新索引")} · ${formatRelativeTime(indexStatus.lastIndexedAt)}`
            : l("Refresh index", "刷新索引")}
        aria-label={indexStatus?.running
          ? l("Refreshing index", "正在刷新索引")
          : l("Refresh index", "刷新索引")}
      >
        <RefreshCw size={15} />
      </button>
      <button
        className={`app-navigation-settings ${settingsOpen ? "active" : ""}`}
        onClick={onOpenSettings}
      >
        <Settings size={18} /><span>{l("Settings", "设置")}</span>
        {signalUpdate ? <i aria-label={l("Update available", "有新版本可用")} /> : null}
      </button>
    </aside>
  );
}

function NavigationItem({
  page,
  activePage,
  onNavigate,
  children,
}: {
  page: AppPage;
  activePage: AppPage;
  onNavigate(page: AppPage): void;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <button
      data-page={page}
      className={activePage === page ? "active" : ""}
      onClick={() => onNavigate(page)}
    >
      {children}
    </button>
  );
}
