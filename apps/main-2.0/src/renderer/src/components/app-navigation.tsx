import type { ReactElement } from "react";
import {
  Beaker,
  BrainCircuit,
  Cpu,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  PackageSearch,
  PlugZap,
  Settings,
  Workflow,
  UsersRound,
} from "lucide-react";
import type { LanguageMode } from "../language";

const BRAND_LOGO_URL = new URL("../../../../assets/logo.png", import.meta.url).href;

export type AppPage =
  | "workbench"
  | "sessions"
  | "workflows"
  | "evaluation"
  | "runtimes"
  | "mcp"
  | "memories"
  | "skills"
  | "providers"
  | "team-space";

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
        <div className="app-navigation-label">{l("Workspace", "工作区")}</div>
        <NavigationItem page="workbench" activePage={activePage} onNavigate={onNavigate} language={language}>
          <LayoutDashboard size={18} /><span>{l("Workbench", "工作台")}</span>
        </NavigationItem>
        <NavigationItem page="sessions" activePage={activePage} onNavigate={onNavigate} language={language}>
          <MessagesSquare size={18} /><span>Session</span>
        </NavigationItem>
        <div className="app-navigation-label">{l("Automation", "自动化")}</div>
        <NavigationItem page="workflows" activePage={activePage} onNavigate={onNavigate} language={language}>
          <Workflow size={18} /><span>Workflow</span>
        </NavigationItem>
        <NavigationItem page="evaluation" activePage={activePage} onNavigate={onNavigate} language={language}>
          <Beaker size={18} /><span>Eval</span>
        </NavigationItem>
        <NavigationItem page="runtimes" activePage={activePage} onNavigate={onNavigate} language={language}>
          <Cpu size={18} /><span>Runtime</span>
        </NavigationItem>
        <div className="app-navigation-label">{l("Resources", "资源")}</div>
        <NavigationItem page="mcp" activePage={activePage} onNavigate={onNavigate} language={language}>
          <PlugZap size={18} /><span>MCP</span>
        </NavigationItem>
        <NavigationItem page="memories" activePage={activePage} onNavigate={onNavigate} language={language}>
          <BrainCircuit size={18} /><span>Memory</span>
        </NavigationItem>
        <NavigationItem page="skills" activePage={activePage} onNavigate={onNavigate} language={language}>
          <PackageSearch size={18} /><span>Skills</span>
        </NavigationItem>
        <NavigationItem page="providers" activePage={activePage} onNavigate={onNavigate} language={language}>
          <KeyRound size={18} /><span>Provider</span>
        </NavigationItem>
        <div className="app-navigation-label">{l("Collaboration", "协作")}</div>
        <NavigationItem page="team-space" activePage={activePage} onNavigate={onNavigate} language={language}>
          <UsersRound size={18} /><span>{l("Team Space", "团队空间")}</span>
        </NavigationItem>
      </nav>
      <button
        className={`app-navigation-settings ${settingsOpen ? "active" : ""}`}
        aria-label={l("Settings", "设置")}
        title={l("Settings", "设置")}
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
  language,
  children,
}: {
  page: AppPage;
  activePage: AppPage;
  onNavigate(page: AppPage): void;
  language: LanguageMode;
  children: ReactElement | ReactElement[];
}): ReactElement {
  const labels: Record<AppPage, string> = { workbench: language === "zh" ? "工作台" : "Workbench", sessions: "Session", workflows: "Workflow", evaluation: "Eval", runtimes: "Runtime", mcp: "MCP", memories: "Memory", skills: "Skills", providers: "Provider", "team-space": language === "zh" ? "团队空间" : "Team Space" };
  return (
    <button
      title={labels[page]}
      aria-label={labels[page]}
      data-page={page}
      aria-current={activePage === page ? "page" : undefined}
      className={activePage === page ? "active" : ""}
      onClick={() => onNavigate(page)}
    >
      {children}
    </button>
  );
}
