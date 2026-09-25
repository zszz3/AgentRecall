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
  Settings,
  Workflow,
} from "lucide-react";
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
  settingsOpen,
  signalUpdate,
  language,
  onNavigate,
  onOpenSettings,
}: {
  activePage: AppPage;
  settingsOpen: boolean;
  signalUpdate: boolean;
  language: LanguageMode;
  onNavigate(page: AppPage): void;
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
        <div className="app-navigation-group" role="group" aria-label={l("Home", "首页")}>
        <p aria-hidden="true">{l("Home", "首页")}</p>
        <NavigationItem page="workbench" activePage={activePage} onNavigate={onNavigate}>
          <LayoutDashboard size={18} /><span>{l("Workbench", "工作台")}</span>
        </NavigationItem>
        </div>
        <div className="app-navigation-group" role="group" aria-label={l("Work", "工作")}>
        <p aria-hidden="true">{l("Work", "工作")}</p>
        <NavigationItem page="sessions" activePage={activePage} onNavigate={onNavigate}>
          <MessagesSquare size={18} /><span>Session</span>
        </NavigationItem>
        <NavigationItem page="team-chat" activePage={activePage} onNavigate={onNavigate}>
          <MessageCircleMore size={18} /><span>Chat</span>
        </NavigationItem>
        </div>
        <div className="app-navigation-group" role="group" aria-label={l("Automation", "自动化")}>
        <p aria-hidden="true">{l("Automation", "自动化")}</p>
        <NavigationItem page="runtimes" activePage={activePage} onNavigate={onNavigate}>
          <Cpu size={18} /><span>Runtime</span>
        </NavigationItem>
        <NavigationItem page="workflows" activePage={activePage} onNavigate={onNavigate}>
          <Workflow size={18} /><span>Workflow</span>
        </NavigationItem>
        <NavigationItem page="evaluation" activePage={activePage} onNavigate={onNavigate}>
          <Beaker size={18} /><span>Eval</span>
        </NavigationItem>
        </div>
        <div className="app-navigation-group" role="group" aria-label={l("Knowledge", "知识")}>
        <p aria-hidden="true">{l("Knowledge", "知识")}</p>
        <NavigationItem page="memories" activePage={activePage} onNavigate={onNavigate}>
          <BrainCircuit size={18} /><span>Memory</span>
        </NavigationItem>
        <NavigationItem page="skills" activePage={activePage} onNavigate={onNavigate}>
          <PackageSearch size={18} /><span>Skills</span>
        </NavigationItem>
        </div>
        <div className="app-navigation-group" role="group" aria-label={l("Connections", "连接")}>
        <p aria-hidden="true">{l("Connections", "连接")}</p>
        <NavigationItem page="mcp" activePage={activePage} onNavigate={onNavigate}>
          <PlugZap size={18} /><span>MCP</span>
        </NavigationItem>
        <NavigationItem page="providers" activePage={activePage} onNavigate={onNavigate}>
          <KeyRound size={18} /><span>Provider</span>
        </NavigationItem>
        </div>
      </nav>
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
      aria-current={activePage === page ? "page" : undefined}
      className={activePage === page ? "active" : ""}
      onClick={() => onNavigate(page)}
    >
      {children}
    </button>
  );
}
