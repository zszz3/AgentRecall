import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const sessionRowSource = readFileSync(new URL("./features/search/session-row.tsx", import.meta.url), "utf8");
const remoteSessionsSource = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");

describe("stylesheet theme contract", () => {
  it("keeps structured search hits compact and highlighted with theme tokens", () => {
    const hit = stylesheet.match(/\.search-match-hit\s*\{[^}]*\}/)?.[0] ?? "";
    const snippet = stylesheet.match(/\.search-match-snippet\s*\{[^}]*\}/)?.[0] ?? "";
    const target = stylesheet.match(/\.matched \.message\.match-target\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hit).toMatch(/display:\s*grid/);
    expect(snippet).toMatch(/-webkit-line-clamp:\s*2/);
    expect(target).toMatch(/border-color:\s*var\(--accent-line\)/);
  });

  it("anchors a bounded recent-search dropdown below the search box", () => {
    const dropdown = stylesheet.match(/\.recent-search-dropdown\s*\{[^}]*\}/)?.[0] ?? "";
    const list = stylesheet.match(/\.recent-search-list\s*\{[^}]*\}/)?.[0] ?? "";
    expect(dropdown).toMatch(/position:\s*absolute/);
    expect(dropdown).toMatch(/top:\s*calc\(100% \+ 6px\)/);
    expect(list).toMatch(/max-height:\s*280px/);
    expect(list).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps theme differences in root tokens instead of component overrides", () => {
    expect(stylesheet).toMatch(/:root\s*\{/);
    expect(stylesheet).toMatch(/:root\[data-theme="dark"\]\s*\{/);
    expect(stylesheet).not.toMatch(/:root\[data-theme="(?:light|dark)"\]\s+[^,{]*\.[\w-]/);
    expect(stylesheet).not.toContain("LIGHT WORKBENCH");
    expect(stylesheet).not.toContain("DARK WORKBENCH");
  });

  it("opens session rows on single click without selecting row text", () => {
    const rowRender = sessionRowSource;
    const sessionRow = stylesheet.match(/\.session-row\s*\{[^}]*\}/)?.[0] ?? "";

    expect(rowRender).toContain("onOpen(session);");
    expect(rowRender).not.toContain("onDoubleClick={() => onOpen(session)}");
    expect(sessionRow).toMatch(/user-select:\s*none/);
    expect(sessionRow).toMatch(/-webkit-user-select:\s*none/);
  });

  it("reserves a stable scrollbar gutter on scrollers whose overflow is frozen by the overlay", () => {
    // Opening the detail overlay toggles `.sidebar`/`.results` to overflow:hidden.
    // Without a reserved gutter the scrollbar's width is released and the
    // right-aligned content jumps sideways, so both must keep a stable gutter.
    const blocks = [...stylesheet.matchAll(/(?:\.sidebar|\.results)\s*\{[^}]*\}/g)].map((m) => m[0]);
    const scrollers = blocks.filter((block) => /overflow-y:\s*auto/.test(block));
    expect(scrollers).toHaveLength(2);
    for (const scroller of scrollers) {
      expect(scroller).toMatch(/scrollbar-gutter:\s*stable/);
    }
  });

  it("keeps the settings dialog within the viewport while allowing pane content to scroll", () => {
    const settingsDialog = stylesheet.match(/\.settings-dialog\s*\{[^}]*\}/)?.[0] ?? "";
    const settingsShell = stylesheet.match(/\.settings-shell\s*\{[^}]*\}/)?.[0] ?? "";
    const settingsContent = stylesheet.match(/\.settings-content\s*\{[^}]*\}/)?.[0] ?? "";

    expect(settingsDialog).toMatch(/height:\s*min\([^;]*100vh/);
    expect(settingsShell).toMatch(/min-height:\s*0/);
    expect(settingsContent).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps the app shortcut reference readable in narrow settings panes", () => {
    const reference = stylesheet.match(/\.shortcut-reference\s*\{[^}]*\}/)?.[0] ?? "";
    const row = stylesheet.match(/\.shortcut-reference-row\s*\{[^}]*\}/)?.[0] ?? "";
    const keys = stylesheet.match(/\.shortcut-reference-row dd\s*\{[^}]*\}/)?.[0] ?? "";
    const keycap = stylesheet.match(/\.shortcut-reference-combo kbd\s*\{[^}]*\}/)?.[0] ?? "";
    const comboSeparator = stylesheet.match(/\.shortcut-reference-combo-separator\s*\{[^}]*\}/)?.[0] ?? "";
    const accessible = stylesheet.match(/\.shortcut-reference-accessible\s*\{[^}]*\}/)?.[0] ?? "";
    const narrowRow = stylesheet.match(/@media \(max-width:\s*640px\)\s*\{[\s\S]*?\.shortcut-reference-row\s*\{[^}]*\}/)?.[0] ?? "";

    expect(reference).toMatch(/display:\s*grid/);
    expect(row).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
    expect(keys).toMatch(/flex-wrap:\s*wrap/);
    expect(keys).toMatch(/justify-content:\s*flex-end/);
    expect(keycap).toMatch(/font-family:\s*var\(--mono\)/);
    expect(keycap).toMatch(/white-space:\s*nowrap/);
    expect(comboSeparator).toMatch(/color:\s*var\(--text-muted\)/);
    expect(accessible).toMatch(/position:\s*absolute/);
    expect(accessible).toMatch(/width:\s*1px/);
    expect(accessible).toMatch(/height:\s*1px/);
    expect(accessible).toMatch(/overflow:\s*hidden/);
    expect(accessible).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(accessible).toMatch(/white-space:\s*nowrap/);
    expect(narrowRow).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("aligns the about update toggle with the update card", () => {
    const updateCard = stylesheet.match(/\.update-available-card\s*\{[^}]*\}/)?.[0] ?? "";
    const autoCheck = stylesheet.match(/\.update-auto-check\s*\{[^}]*\}/)?.[0] ?? "";

    expect(updateCard).toMatch(/width:\s*min\(100%,\s*560px\)/);
    expect(autoCheck).toMatch(/width:\s*min\(100%,\s*560px\)/);
  });

  it("keeps the API config dialog viewport-bound with a clear provider switch", () => {
    const apiDialog = stylesheet.match(/\.api-config-dialog\s*\{[^}]*\}/)?.[0] ?? "";
    const apiBody = stylesheet.match(/\.api-config-body\s*\{[^}]*\}/)?.[0] ?? "";
    const providerSwitch = stylesheet.match(/\.api-provider-switch\s*\{[^}]*\}/)?.[0] ?? "";
    const codexProviderSwitch = stylesheet.match(/\.codex-provider-switch\s*\{[^}]*\}/)?.[0] ?? "";
    const summaryProviderSwitch = stylesheet.match(/\.summary-provider-switch\s*\{[^}]*\}/)?.[0] ?? "";
    const detectButton = stylesheet.match(/\.codex-model-detect-button\s*\{[^}]*\}/)?.[0] ?? "";
    const modelInput = stylesheet.match(/\.codex-model-input\s*\{[^}]*\}/)?.[0] ?? "";
    const modelCombo = stylesheet.match(/\.codex-model-combo\s*\{[^}]*\}/)?.[0] ?? "";
    const modelMenu = stylesheet.match(/\.codex-model-menu\s*\{[^}]*\}/)?.[0] ?? "";
    const apiField = stylesheet.match(/\.api-settings-form\s+\.settings-field\s*\{[^}]*\}/)?.[0] ?? "";
    const apiInput = stylesheet.match(/\.api-settings-form\s+\.settings-field\s+(?:input|select)[^{]*\{[^}]*\}/)?.[0] ?? "";

    expect(apiDialog).toMatch(/height:\s*min\([^;]*100vh/);
    expect(apiBody).toMatch(/overflow-y:\s*auto/);
    expect(providerSwitch).toMatch(/grid-template-columns:\s*repeat\(auto-fit/);
    expect(providerSwitch).toMatch(/minmax\(92px,\s*1fr\)/);
    expect(codexProviderSwitch).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(summaryProviderSwitch).toMatch(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(detectButton).toMatch(/border:\s*1px\s+solid\s+var\(--accent-line\)/);
    expect(detectButton).toMatch(/background:\s*var\(--accent-soft\)/);
    expect(detectButton).toMatch(/font-weight:\s*650/);
    expect(modelInput).toMatch(/display:\s*grid/);
    expect(modelInput).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s+max-content/);
    expect(modelCombo).toMatch(/position:\s*relative/);
    expect(modelMenu).toMatch(/position:\s*absolute/);
    expect(modelMenu).toMatch(/overflow-y:\s*auto/);
    expect(apiField).toMatch(/display:\s*grid/);
    expect(apiField).toMatch(/grid-template-columns:\s*minmax\(140px,\s*180px\)\s+minmax\(0,\s*1fr\)/);
    expect(apiInput).toMatch(/width:\s*100%/);
  });

  it("keeps the SSH dialog viewport-bound with scrollable content", () => {
    const sshDialog = stylesheet.match(/\.ssh-dialog\s*\{[^}]*\}/)?.[0] ?? "";
    const sshBody = stylesheet.match(/\.ssh-dialog-body\s*\{[^}]*\}/)?.[0] ?? "";

    expect(sshDialog).toMatch(/height:\s*min\([^;]*100vh/);
    expect(sshBody).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps Supabase skill sync inputs from overlapping their labels", () => {
    const syncField = stylesheet.match(/\.skills-sync-field\s*\{[^}]*\}/)?.[0] ?? "";
    const syncInput = stylesheet.match(/\.skills-sync-field\s+input\s*\{[^}]*\}/)?.[0] ?? "";
    const narrowSyncField = stylesheet.match(/@media \(max-width:\s*640px\)\s*\{[\s\S]*?\.skills-sync-field\s*\{[^}]*\}/)?.[0] ?? "";

    expect(syncField).toMatch(/display:\s*grid/);
    expect(syncField).toMatch(/grid-template-columns:\s*minmax\(160px,\s*220px\)\s+minmax\(0,\s*1fr\)/);
    expect(syncInput).toMatch(/width:\s*100%/);
    expect(syncInput).toMatch(/min-width:\s*0/);
    expect(narrowSyncField).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("clamps the detail title so long remote prompts cannot push conversation out of view", () => {
    const detailTitle = stylesheet.match(/\.detail-header h2\s*\{[^}]*\}/)?.[0] ?? "";

    expect(detailTitle).toMatch(/display:\s*-webkit-box/);
    expect(detailTitle).toMatch(/-webkit-line-clamp:\s*3/);
    expect(detailTitle).toMatch(/-webkit-box-orient:\s*vertical/);
  });

  it("separates the Tools toggle from role filters with spacing and no divider", () => {
    const controls = stylesheet.match(/\.conversation-filters\s*\{[^}]*\}/)?.[0] ?? "";
    const tools = stylesheet.match(/\.conversation-tools-toggle\s*\{[^}]*\}/)?.[0] ?? "";
    expect(controls).toMatch(/gap:\s*7px/);
    expect(tools).not.toMatch(/border-left/);
  });

  it("keeps toolbar action buttons isolated from the filter row", () => {
    const toolbar = stylesheet.match(/\.toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const toolbarFilters = stylesheet.match(/\.toolbar-filters\s*\{[^}]*\}/)?.[0] ?? "";
    const searchbox = stylesheet.match(/\.searchbox\s*\{[^}]*\}/)?.[0] ?? "";
    const dateFilter = stylesheet.match(/\.date-filter\s*\{[^}]*\}/)?.[0] ?? "";
    const dateFilterButton = stylesheet.match(/\.date-filter button\s*\{[^}]*\}/)?.[0] ?? "";
    const liveFilterButton = stylesheet.match(/\.live-filter button\s*\{[^}]*\}/)?.[0] ?? "";
    const clearChip = stylesheet.match(/\.chip\.clear\s*\{[^}]*\}/)?.[0] ?? "";
    const topActions = stylesheet.match(/\.top-actions\s*\{[^}]*\}/)?.[0] ?? "";
    const narrowToolbar = stylesheet.match(/@media \(max-width:\s*1040px\)\s*\{[\s\S]*?\.toolbar\s*\{[^}]*\}/)?.[0] ?? "";

    expect(toolbar).toMatch(/display:\s*grid/);
    expect(toolbar).toMatch(/position:\s*relative/);
    expect(toolbar).toMatch(/z-index:\s*5/);
    expect(toolbar).toMatch(/grid-template-columns:\s*minmax\(180px,\s*1fr\)\s+minmax\(0,\s*max-content\)\s+auto/);
    expect(toolbarFilters).toMatch(/--live-filter-width:\s*166px/);
    expect(toolbarFilters).toMatch(/--date-filter-width:\s*214px/);
    expect(toolbarFilters).toMatch(/width:\s*fit-content/);
    expect(toolbarFilters).toMatch(/max-width:\s*min\(636px,\s*48vw\)/);
    expect(toolbarFilters).toMatch(/justify-self:\s*end/);
    expect(toolbarFilters).toMatch(/flex-wrap:\s*nowrap/);
    expect(toolbarFilters).toMatch(/justify-content:\s*flex-start/);
    expect(toolbarFilters).toMatch(/overflow:\s*visible/);
    expect(dateFilter).toMatch(/height:\s*38px/);
    expect(dateFilter).toMatch(/width:\s*fit-content/);
    expect(dateFilter).toMatch(/max-width:\s*var\(--date-filter-width\)/);
    expect(dateFilter).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(dateFilterButton).toMatch(/min-width:\s*36px/);
    expect(dateFilterButton).toMatch(/height:\s*30px/);
    expect(dateFilterButton).toMatch(/white-space:\s*nowrap/);
    const liveFilter = stylesheet.match(/\.live-filter\s*\{[^}]*\}/)?.[0] ?? "";
    expect(liveFilter).toMatch(/width:\s*var\(--live-filter-width\)/);
    expect(liveFilter).toMatch(/flex:\s*0\s+0\s+var\(--live-filter-width\)/);
    expect(liveFilterButton).toMatch(/white-space:\s*nowrap/);
    expect(topActions).toMatch(/margin-left:\s*auto/);
    expect(topActions).toMatch(/flex-wrap:\s*nowrap/);
    expect(topActions).toMatch(/min-width:\s*0/);
    expect(searchbox).toMatch(/min-width:\s*0/);
    expect(searchbox).toMatch(/width:\s*100%/);
    expect(searchbox).toMatch(/flex:\s*none/);
    expect(clearChip).toMatch(/max-width:\s*min\(240px,\s*30vw\)/);
    expect(clearChip).toMatch(/overflow:\s*hidden/);
    expect(narrowToolbar).not.toMatch(/grid-column:\s*1\s*\/\s*-1/);
    expect(stylesheet).not.toMatch(/@media \(max-width:\s*1040px\)[\s\S]*?\.searchbox\s*\{[\s\S]*?flex-basis:\s*100%/);
  });

  it("keeps SSH config selection calm without a hard active border or selection shadow", () => {
    const sshConfigRow = stylesheet.match(/\.ssh-config-row\s*\{[^}]*\}/)?.[0] ?? "";
    const activeRow = stylesheet.match(/\.ssh-config-row\.active\s*\{[^}]*\}/)?.[0] ?? "";

    expect(sshConfigRow).toMatch(/transition:\s*none/);
    expect(activeRow).not.toMatch(/border-color:\s*var\(--accent-line\)/);
    expect(activeRow).not.toMatch(/box-shadow/);
  });

  it("uses a custom SSH checkbox instead of the native focus halo", () => {
    const sshCheck = stylesheet.match(/\.ssh-check\s*\{[^}]*\}/)?.[0] ?? "";
    const checked = stylesheet.match(/\.ssh-check:checked\s*\{[^}]*\}/)?.[0] ?? "";

    expect(sshCheck).toMatch(/appearance:\s*none/);
    expect(sshCheck).toMatch(/outline:\s*0/);
    expect(checked).toMatch(/background:\s*var\(--accent\)/);
  });

  it("uses a soft Xiaohongshu red for CodeWiz badges", () => {
    const root = stylesheet.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const dark = stylesheet.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const badge = stylesheet.match(/\.source-badge\.codewiz\s*\{[^}]*\}/)?.[0] ?? "";

    expect(root).toMatch(/--codewiz:\s*#ff2442/);
    expect(root).toMatch(/--codewiz-badge-bg:\s*#fff0f2/);
    expect(root).toMatch(/--codewiz-badge-text:\s*#b42335/);
    expect(dark).toMatch(/--codewiz-badge-bg:\s*rgba\(255,\s*90,\s*111,\s*0\.16\)/);
    expect(dark).toMatch(/--codewiz-badge-text:\s*#ff8d9d/);
    expect(badge).toMatch(/background:\s*var\(--codewiz-badge-bg\)/);
    expect(badge).toMatch(/color:\s*var\(--codewiz-badge-text\)/);
  });

  it("uses a distinct blue accent for ZCode badges", () => {
    const root = stylesheet.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const dark = stylesheet.match(/:root\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
    const badge = stylesheet.match(/\.source-badge\.zcode\s*\{[^}]*\}/)?.[0] ?? "";

    expect(root).toMatch(/--zcode:\s*#2563eb/);
    expect(root).toMatch(/--zcode-badge-bg:\s*#eaf2ff/);
    expect(root).toMatch(/--zcode-badge-text:\s*#1d4ed8/);
    expect(dark).toMatch(/--zcode-badge-bg:\s*rgba\(59,\s*130,\s*246,\s*0\.18\)/);
    expect(dark).toMatch(/--zcode-badge-text:\s*#93c5fd/);
    expect(badge).toMatch(/background:\s*var\(--zcode-badge-bg\)/);
    expect(badge).toMatch(/color:\s*var\(--zcode-badge-text\)/);
  });

  it("uses one desktop toolbar and the available viewport height for session sync", () => {
    const dialog = stylesheet.match(/\.remote-sessions-dialog\s*\{[^}]*\}/)?.[0] ?? "";
    const toolbar = stylesheet.match(/\.remote-sessions-toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const list = stylesheet.match(/\.remote-session-list\s*\{[^}]*\}/)?.[0] ?? "";

    expect(remoteSessionsSource).not.toContain('className="remote-selection-bar"');
    expect(dialog).toMatch(/height:\s*min\(88vh,\s*860px\)/);
    expect(dialog).toMatch(/display:\s*flex/);
    expect(toolbar).toMatch(/flex-wrap:\s*nowrap/);
    expect(list).toMatch(/flex:\s*1/);
    expect(list).toMatch(/overflow-y:\s*auto/);
  });

  it("keeps the Skills refresh action in the desktop toolbar row", () => {
    const toolbar = stylesheet.match(/\.skills-toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const refresh = stylesheet.match(/\.skills-toolbar \.stats-refresh\s*\{[^}]*\}/)?.[0] ?? "";

    expect(toolbar).toMatch(/flex-wrap:\s*nowrap/);
    expect(refresh).toMatch(/flex:\s*0\s+0\s+auto/);
  });

  it("uses a defined, theme-aware border for Supabase setup warnings", () => {
    const warning = stylesheet.match(/\.supabase-setup-guide\.warning\s*\{[^}]*\}/)?.[0] ?? "";

    expect(warning).toMatch(/border-color:\s*color-mix\([^;]*var\(--running-text\)/);
    expect(warning).not.toContain("--running-border");
  });

  it("keeps the nested remote-session setup guide aligned with the other settings cards", () => {
    const nestedGuide = stylesheet.match(/\.remote-sync-settings-body\s*>\s*\.supabase-setup-guide\s*\{[^}]*\}/)?.[0] ?? "";

    expect(nestedGuide).toMatch(/margin:\s*0/);
  });
});
