import { memo } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Beaker,
  BrainCircuit,
  Cpu,
  KeyRound,
  FileText,
  LayoutDashboard,
  MessagesSquare,
  PackageSearch,
  PlugZap,
  Settings,
  UsersRound,
} from "lucide-react";
import type { LanguageMode } from "../language";

const BRAND_LOGO_URL = new URL("../../../../assets/logo.png", import.meta.url).href;

export type AppPage =
  | "workbench"
  | "sessions"
  | "evaluation"
  | "runtimes"
  | "mcp"
  | "memories"
  | "skills"
  | "instructions"
  | "providers"
  | "team-space";

export const AppNavigation = memo(function AppNavigation({
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
  const item = (page: AppPage, icon: ReactElement, label: string): ReactElement => (
    <NavigationItem page={page} activePage={activePage} onNavigate={onNavigate} language={language}>
      {icon}<span className="truncate max-[1060px]:hidden">{label}</span>
    </NavigationItem>
  );
  return (
    <aside className="app-navigation relative z-[9] flex min-h-0 min-w-0 flex-col gap-1.5 bg-sidebar px-2 pt-10 pb-2.5 text-sidebar-foreground">
      <button
        className="mb-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left text-foreground outline-none transition-colors hover:bg-sidebar-accent max-[1060px]:justify-center max-[1060px]:px-0"
        onClick={() => onNavigate("workbench")}
        aria-label="AgentRecall"
      >
        <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-card shadow-(--control-shadow)" aria-hidden="true">
          <svg viewBox="75 240 280 280" className="block size-4">
            <image href={BRAND_LOGO_URL} width="1800" height="796" />
          </svg>
        </span>
        <strong className="whitespace-nowrap text-sm font-semibold max-[1060px]:hidden">AgentRecall</strong>
      </button>
      <nav aria-label={l("Main navigation", "主导航")} className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto [scrollbar-width:none]">
        <GroupLabel first>{l("Workspace", "工作区")}</GroupLabel>
        {item("workbench", <LayoutDashboard />, l("Workbench", "工作台"))}
        {item("sessions", <MessagesSquare />, "Session")}
        <GroupLabel>{l("Resources", "资源")}</GroupLabel>
        {item("memories", <BrainCircuit />, "Memory")}
        {item("instructions", <FileText />, l("Instructions", "指令"))}
        {item("skills", <PackageSearch />, "Skills")}
        {item("mcp", <PlugZap />, "MCP")}
        {item("providers", <KeyRound />, l("Gateway", "网关"))}
        <GroupLabel>{l("Collaboration", "协作")}</GroupLabel>
        {item("team-space", <UsersRound />, l("Team Space", "团队空间"))}
        <GroupLabel>{l("Automation", "自动化")}</GroupLabel>
        {item("evaluation", <Beaker />, "Eval")}
        {item("runtimes", <Cpu />, "Runtime")}
      </nav>
      <div className="mt-1 border-t border-sidebar-border pt-2">
        <button
          className={`app-navigation-settings ${ROW}`}
          data-active={settingsOpen || undefined}
          aria-label={l("Settings", "设置")}
          title={l("Settings", "设置")}
          onClick={onOpenSettings}
        >
          <Settings /><span className="truncate max-[1060px]:hidden">{l("Settings", "设置")}</span>
          {signalUpdate ? <i className="ml-auto size-1.5 shrink-0 rounded-full bg-destructive" aria-label={l("Update available", "有新版本可用")} /> : null}
        </button>
      </div>
    </aside>
  );
});

/** A sleek macOS sidebar row. Icons only below 1060 px. */
const ROW = "flex h-[30px] w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-[13px] font-medium text-sidebar-foreground/75 outline-none transition-[background-color,color,box-shadow] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[active]:bg-card data-[active]:text-foreground data-[active]:shadow-(--card-shadow) max-[1060px]:justify-center max-[1060px]:px-0 [&>svg]:size-[14px] [&>svg]:shrink-0 [&>svg]:text-muted-foreground/85 data-[active]:[&>svg]:text-[var(--accent-indigo)]";

function GroupLabel({ first = false, children }: { first?: boolean; children: string }): ReactElement {
  return (
    <div className={`app-navigation-label flex h-6 shrink-0 items-end px-2 pb-1 text-[11px] font-semibold text-muted-foreground/75 ${first ? "pt-0" : "pt-3"} max-[1060px]:mx-1.5 max-[1060px]:my-2 max-[1060px]:h-px max-[1060px]:overflow-hidden max-[1060px]:bg-sidebar-border max-[1060px]:p-0 max-[1060px]:text-transparent ${first ? "max-[1060px]:hidden" : ""}`}>
      {children}
    </div>
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
  children: ReactNode;
}): ReactElement {
  const labels: Record<AppPage, string> = { workbench: language === "zh" ? "工作台" : "Workbench", sessions: "Session", evaluation: "Eval", runtimes: "Runtime", mcp: "MCP", memories: "Memory", skills: "Skills", instructions: language === "zh" ? "指令" : "Instructions", providers: language === "zh" ? "网关" : "Gateway", "team-space": language === "zh" ? "团队空间" : "Team Space" };
  return (
    <button
      title={labels[page]}
      aria-label={labels[page]}
      data-page={page}
      aria-current={activePage === page ? "page" : undefined}
      data-active={activePage === page || undefined}
      className={ROW}
      onClick={() => onNavigate(page)}
    >
      {children}
    </button>
  );
}
