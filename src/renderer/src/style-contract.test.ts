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
});
