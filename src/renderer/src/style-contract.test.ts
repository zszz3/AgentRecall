import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("stylesheet theme contract", () => {
  it("keeps theme differences in root tokens instead of component overrides", () => {
    expect(stylesheet).toMatch(/:root\s*\{/);
    expect(stylesheet).toMatch(/:root\[data-theme="dark"\]\s*\{/);
    expect(stylesheet).not.toMatch(/:root\[data-theme="(?:light|dark)"\]\s+[^,{]*\.[\w-]/);
    expect(stylesheet).not.toContain("LIGHT WORKBENCH");
    expect(stylesheet).not.toContain("DARK WORKBENCH");
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

  it("keeps the API config dialog viewport-bound with a clear provider switch", () => {
    const apiDialog = stylesheet.match(/\.api-config-dialog\s*\{[^}]*\}/)?.[0] ?? "";
    const apiBody = stylesheet.match(/\.api-config-body\s*\{[^}]*\}/)?.[0] ?? "";
    const providerSwitch = stylesheet.match(/\.api-provider-switch\s*\{[^}]*\}/)?.[0] ?? "";
    const apiField = stylesheet.match(/\.api-settings-form\s+\.settings-field\s*\{[^}]*\}/)?.[0] ?? "";
    const apiInput = stylesheet.match(/\.api-settings-form\s+\.settings-field\s+(?:input|select)[^{]*\{[^}]*\}/)?.[0] ?? "";

    expect(apiDialog).toMatch(/height:\s*min\([^;]*100vh/);
    expect(apiBody).toMatch(/overflow-y:\s*auto/);
    expect(providerSwitch).toMatch(/grid-template-columns:\s*repeat\(auto-fit/);
    expect(providerSwitch).toMatch(/minmax\(92px,\s*1fr\)/);
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

  it("keeps toolbar action buttons isolated from remote environment filter chips", () => {
    const toolbar = stylesheet.match(/\.toolbar\s*\{[^}]*\}/)?.[0] ?? "";
    const toolbarFilters = stylesheet.match(/\.toolbar-filters\s*\{[^}]*\}/)?.[0] ?? "";
    const searchbox = stylesheet.match(/\.searchbox\s*\{[^}]*\}/)?.[0] ?? "";
    const clearChip = stylesheet.match(/\.chip\.clear\s*\{[^}]*\}/)?.[0] ?? "";
    const topActions = stylesheet.match(/\.top-actions\s*\{[^}]*\}/)?.[0] ?? "";
    const narrowSearchbox = stylesheet.match(/@media \(max-width:\s*1040px\)\s*\{[\s\S]*?\.searchbox\s*\{[^}]*\}/)?.[0] ?? "";

    expect(toolbar).toMatch(/display:\s*flex/);
    expect(toolbar).toMatch(/flex-wrap:\s*wrap/);
    expect(toolbarFilters).toMatch(/flex-wrap:\s*wrap/);
    expect(toolbarFilters).toMatch(/justify-content:\s*flex-start/);
    expect(toolbarFilters).toMatch(/max-width:\s*min\(520px,\s*48vw\)/);
    expect(topActions).toMatch(/margin-left:\s*auto/);
    expect(searchbox).toMatch(/min-width:\s*0/);
    expect(searchbox).toMatch(/flex:\s*1\s+1\s+340px/);
    expect(clearChip).toMatch(/max-width:\s*min\(240px,\s*30vw\)/);
    expect(clearChip).toMatch(/overflow:\s*hidden/);
    expect(narrowSearchbox).toMatch(/flex-basis:\s*100%/);
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
});
