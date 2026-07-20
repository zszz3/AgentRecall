import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rendererStyleSource } from "./style-test-source";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("./features/skills/skills-page.tsx", import.meta.url), "utf8");
const providerSource = readFileSync(new URL("./features/providers/provider-page.tsx", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("./features/workbench/workbench-page.tsx", import.meta.url), "utf8");
const searchBoxSource = readFileSync(new URL("./features/search/search-box.tsx", import.meta.url), "utf8");
const stylesheet = rendererStyleSource;

describe("workbench application shell", () => {
  it("starts on the workbench and exposes workbench, sessions, Skills, and Provider navigation", () => {
    expect(appSource).toContain('type AppPage = "workbench" | "sessions" | "skills" | "providers"');
    expect(appSource).toContain('useState<AppPage>("workbench")');
    expect(appSource).toContain("<WorkbenchPage");
    expect(appSource).toContain('data-page="sessions"');
    expect(appSource).toContain('data-page="skills"');
    expect(appSource).toContain('data-page="providers"');
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

  it("compresses usage and quota into one status rail without permanent detail rows", () => {
    const overview = stylesheet.match(/\.workbench-overview\s*\{[^}]*\}/)?.[0] ?? "";
    expect(overview).toMatch(/min-height:\s*72px/);
    expect(workbenchSource).not.toContain("<TokenComposition");
    expect(workbenchSource).not.toContain('className="workbench-source-usage"');
    expect(workbenchSource).toContain('className="workbench-detail-hint"');
    expect(workbenchSource).toContain("tabIndex={detail ? 0 : undefined}");
  });

  it("shows explicit Open and Closed state in every workbench session row", () => {
    expect(workbenchSource).toContain("localizedLiveStateLabel(liveState, language)");
    expect(workbenchSource).toContain("workbench-session-state ${liveState}");
  });

  it("reserves Workflow as an empty slot without migrating workflow data", () => {
    expect(workbenchSource).toContain('l("Workflow is not migrated yet", "Workflow 暂未迁移")');
    expect(workbenchSource).not.toContain("onOpenWorkflow");
    expect(workbenchSource).not.toContain("workflows:");
  });

  it("opens the usage settings section from unavailable quota cards", () => {
    expect(appSource).toContain('onOpenSettings={() => { setSettingsInitialSection("usage"); setSettingsOpen(true); }}');
  });
});
