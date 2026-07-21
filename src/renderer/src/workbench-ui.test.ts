import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rendererStyleSource } from "./style-test-source";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("../../main/index.ts", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("./features/skills/skills-page.tsx", import.meta.url), "utf8");
const providerSource = readFileSync(new URL("./features/providers/provider-page.tsx", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("./features/workbench/workbench-page.tsx", import.meta.url), "utf8");
const tokenTrendUrl = new URL("./features/workbench/token-trend-chart.tsx", import.meta.url);
const tokenTrendSource = existsSync(tokenTrendUrl) ? readFileSync(tokenTrendUrl, "utf8") : "";
const searchBoxSource = readFileSync(new URL("./features/search/search-box.tsx", import.meta.url), "utf8");
const appShellSource = readFileSync(new URL("./styles/app-shell.css", import.meta.url), "utf8");
const stylesheet = rendererStyleSource;

describe("workbench application shell", () => {
  it("starts on the workbench and exposes every primary navigation page", () => {
    expect(appSource).toContain('type AppPage = "workbench" | "sessions" | "workflows" | "runtimes" | "mcp" | "memories" | "skills" | "providers"');
    expect(appSource).toContain('useState<AppPage>("workbench")');
    expect(appSource).toContain("<WorkbenchPage");
    expect(appSource).toContain('data-page="sessions"');
    expect(appSource).toContain('data-page="workflows"');
    expect(appSource).toContain('data-page="runtimes"');
    expect(appSource).toContain('data-page="mcp"');
    expect(appSource).toContain('data-page="memories"');
    expect(appSource).toContain('data-page="skills"');
    expect(appSource).toContain('data-page="providers"');
  });

  it("keeps ordinary window activation on Workbench and focuses search only for the explicit shortcut", () => {
    expect(mainSource).toContain("function showWindow(options: { focusSearch?: boolean } = {})");
    expect(mainSource).toContain("if (options.focusSearch) mainWindow.webContents.send(\"focus-search\")");
    expect(mainSource).toContain("showWindow({ focusSearch: true })");
    expect(mainSource).toContain('app.on("activate", () => {\n  showWindow();');
  });

  it("gives every primary page a consistent title and description bar", () => {
    expect(workbenchSource).toContain('className="app-page-head workbench-page-head"');
    expect(workbenchSource).toContain('<h2>{l("Workbench", "工作台")}</h2>');
    expect(workbenchSource).toContain("<p>One for all</p>");
    expect(appSource).toContain('className="app-page-head sessions-page-head"');
    expect(skillsSource).toContain('className="app-page-head skills-page-head"');
    expect(providerSource).toContain('className="app-page-head provider-page-head"');
    expect(appShellSource).toMatch(/\.app-page-head\s*\{[^}]*border-bottom:\s*1px solid var\(--border-subtle\)/);
  });

  it("owns Skills as a page instead of preserving the old modal interface", () => {
    expect(skillsSource).toContain("export function SkillsPage");
    expect(skillsSource).toContain('className="skills-page"');
    expect(skillsSource).not.toContain('presentation?: "dialog" | "page"');
    expect(appSource).toContain("<SkillsPage");
    expect(appSource).not.toContain('presentation="page"');
  });

  it("owns Provider as a page instead of preserving the API configuration overlay", () => {
    expect(providerSource).toContain("export function ProviderPage");
    expect(providerSource).toContain('className="provider-page"');
    expect(providerSource).not.toContain('className="dialog-backdrop"');
    expect(appSource).toContain("<ProviderPage");
    expect(appSource).not.toContain("apiConfigOpen");
  });

  it("uses the compact navigation rail and independent workbench/session page scrollers", () => {
    expect(stylesheet).toMatch(/\.app-navigation\s*\{/);
    expect(stylesheet).toMatch(/\.workbench-page\s*\{/);
    expect(stylesheet).toMatch(/\.sessions-page\s*\{/);
    expect(stylesheet).toMatch(/grid-template-columns:\s*84px\s+minmax\(0,\s*1fr\)/);
  });

  it("does not reserve a blank macOS titlebar row above every page", () => {
    const workspace = appShellSource.match(/\.app-workspace\s*\{[^}]*\}/)?.[0] ?? "";
    const dragStrip = appShellSource.match(/\.app\[data-platform="darwin"\] \.titlebar-drag\s*\{[^}]*\}/)?.[0] ?? "";
    expect(workspace).toMatch(/padding-top:\s*0/);
    expect(dragStrip).toMatch(/left:\s*84px/);
    expect(dragStrip).toMatch(/height:\s*8px/);
    expect(appShellSource).toMatch(/\.app\[data-platform="darwin"\] \.titlebar-drag::before\s*\{[^}]*height:\s*40px/);
  });

  it("uses the README brand mark and a compact index refresh action without a persistent status bar", () => {
    const refreshButton = stylesheet.match(/\.app-navigation-refresh\s*\{[^}]*\}/)?.[0] ?? "";
    expect(appSource).toContain('const BRAND_LOGO_URL = new URL("../../../assets/logo.png", import.meta.url).href;');
    expect(appSource).toContain('<image href={BRAND_LOGO_URL}');
    expect(appSource).not.toContain("<Search size={17}");
    expect(appSource).toContain("app-navigation-refresh");
    expect(appSource.indexOf("app-navigation-refresh")).toBeLessThan(appSource.indexOf("app-navigation-settings"));
    expect(appSource).not.toContain('className="app-topbar"');
    expect(stylesheet).not.toMatch(/\.app-topbar\s*\{/);
    expect(refreshButton).toMatch(/width:\s*30px/);
    expect(refreshButton).toMatch(/height:\s*30px/);
  });

  it("keeps workbench session rows compact without dropping their two-line context", () => {
    const row = stylesheet.match(/\.workbench-session-row\s*\{[^}]*\}/)?.[0] ?? "";
    const copy = stylesheet.match(/\.workbench-session-copy\s*\{[^}]*\}/)?.[0] ?? "";
    const resume = stylesheet.match(/\.workbench-resume\s*\{[^}]*\}/)?.[0] ?? "";
    expect(row).toMatch(/min-height:\s*46px/);
    expect(row).toMatch(/padding:\s*4px\s+0/);
    expect(copy).toMatch(/gap:\s*1px/);
    expect(resume).toMatch(/height:\s*26px/);
    expect(workbenchSource).toContain('className="workbench-session-copy"');
    expect(workbenchSource).toContain("session.displayTitle");
    expect(workbenchSource).toContain("session.projectPath");
  });

  it("shows ten sessions in one independently scrollable workbench module with Enter-to-search", () => {
    const list = stylesheet.match(/\.workbench-session-list\s*\{[^}]*\}/)?.[0] ?? "";
    const panels = stylesheet.match(/\.workbench-primary-grid > \.workbench-panel\s*\{[^}]*\}/)?.[0] ?? "";
    expect(appSource).toContain('const [workbenchQuery, setWorkbenchQuery] = useState("");');
    expect(appSource).toContain("query: workbenchQuery");
    expect(appSource.match(/limit: WORKBENCH_SESSION_LIMIT/g)).toHaveLength(3);
    expect(workbenchSource).toContain("<SearchBox");
    expect(workbenchSource).toContain('className="workbench-session-list"');
    expect(workbenchSource).not.toContain("<SessionSection");
    expect(searchBoxSource).toContain("submittedValue?: string;");
    expect(list).toMatch(/overflow-y:\s*auto/);
    expect(list).toMatch(/scrollbar-gutter:\s*stable/);
    expect(panels).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(panels).toMatch(/border-radius:\s*var\(--radius\)/);
  });

  it("aligns the four usage metrics on stable value and label baselines", () => {
    const metrics = stylesheet.match(/\.workbench-metrics\s*\{[^}]*\}/)?.[0] ?? "";
    const metric = stylesheet.match(/\.workbench-metrics > div\s*\{[^}]*\}/)?.[0] ?? "";
    const value = stylesheet.match(/\.workbench-metrics strong\s*\{[^}]*\}/)?.[0] ?? "";
    const label = stylesheet.match(/\.workbench-metrics span\s*\{[^}]*\}/)?.[0] ?? "";
    expect(metrics).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(metric).toMatch(/grid-template-rows:\s*28px\s+14px/);
    expect(value).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(value).toMatch(/line-height:\s*1/);
    expect(label).toMatch(/line-height:\s*14px/);
  });

  it("places the usage period in a compact card-header dropdown", () => {
    const usageHead = stylesheet.match(/\.workbench-usage-head\s*\{[^}]*\}/)?.[0] ?? "";
    const periodSelect = stylesheet.match(/\.workbench-period-select\s*\{[^}]*\}/)?.[0] ?? "";
    expect(workbenchSource).toContain('className="workbench-usage-head"');
    expect(workbenchSource).toContain('className="workbench-period-select"');
    expect(workbenchSource).toContain("value={statsPeriod}");
    expect(workbenchSource).toContain("event.currentTarget.value as SessionStatsPeriod");
    expect(workbenchSource).toContain("<option key={period} value={period}>");
    expect(workbenchSource).not.toContain('className="workbench-periods"');
    expect(usageHead).toMatch(/justify-content:\s*space-between/);
    expect(periodSelect).toMatch(/height:\s*24px/);
  });

  it("keeps usage details visible beside an accessible seven-day Token trend", () => {
    const overview = stylesheet.match(/\.workbench-overview\s*\{[^}]*\}/)?.[0] ?? "";
    expect(overview).toMatch(/min-height:\s*142px/);
    expect(overview).toMatch(/grid-template-columns:[^;]*1\.24fr[^;]*1\.04fr[^;]*\.78fr/);
    expect(workbenchSource).toContain('className="workbench-token-composition"');
    expect(workbenchSource).toContain('className="workbench-source-usage"');
    expect(workbenchSource).toContain("<TokenTrendChart");
    expect(workbenchSource).toContain("points={stats.dailyTokenUsage}");
    expect(workbenchSource).not.toContain('className="workbench-overview-slot"');
    expect(tokenTrendSource).toContain('className="workbench-token-trend"');
    expect(tokenTrendSource).toContain("points = []");
    expect(tokenTrendSource).toContain("<svg");
    expect(tokenTrendSource).toContain("<button");
    expect(tokenTrendSource).toContain('role="tooltip"');
    expect(workbenchSource).not.toContain('className="workbench-detail-hint"');
  });

  it("places both providers in one quota card with one shared refresh action", () => {
    expect(workbenchSource).toContain('className="workbench-quota-card"');
    expect(workbenchSource).toContain('className="workbench-quota-pair"');
    expect(workbenchSource.match(/onClick=\{onRefreshQuotas\}/g)).toHaveLength(1);
    expect(workbenchSource).toContain('l("Refresh model quotas", "刷新模型额度")');
    expect(workbenchSource).not.toContain("onRefresh: () => void;");
  });

  it("shows explicit Open and Closed state in every workbench session row", () => {
    expect(workbenchSource).toContain("localizedLiveStateLabel(liveState, language)");
    expect(workbenchSource).toContain("workbench-session-state ${liveState}");
  });

  it("shows live Workflow state and lets the user create or reopen workflows", () => {
    expect(workbenchSource).toContain("workflows: WorkbenchWorkflowItem[]");
    expect(workbenchSource).toContain("onOpenWorkflow");
    expect(workbenchSource).toContain("onNewWorkflow");
    expect(workbenchSource).toContain('className="workbench-workflow-list"');
    expect(workbenchSource).toContain('className={`workbench-workflow-status is-${item.status}`}');
    expect(workbenchSource).not.toContain("Workflow is not migrated yet");
  });

  it("opens the usage settings section from unavailable quota cards", () => {
    expect(appSource).toContain('onOpenSettings={() => { setSettingsInitialSection("usage"); setSettingsOpen(true); }}');
  });
});
