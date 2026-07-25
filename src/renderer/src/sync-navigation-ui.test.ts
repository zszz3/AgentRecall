import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./features/session-detail/detail-panel.tsx", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("./features/skills/skills-dialog.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("sync overlay navigation and progress", () => {
  it("does not mount remote session navigation in the 1.0 shell", () => {
    expect(appSource).not.toContain("RemoteSessionsDialog");
    expect(appSource).not.toContain("function closeRemoteDetail");
    expect(appSource).not.toContain('backdropClassName="remote-detail-backdrop"');
    expect(detailSource).toContain("backdropClassName?: string");
    expect(stylesheet).toMatch(/\.remote-detail-backdrop\s*\{[^}]*z-index:\s*90/);
  });

  it("keeps Escape handling limited to core dialogs and local detail", () => {
    const start = appSource.indexOf('if (event.key === "Escape")');
    const escapeHandler = appSource.slice(start, appSource.indexOf("if (renameSession ||", start));
    expect(escapeHandler).toContain("setRenameSession(null)");
    expect(escapeHandler).toContain("setInfoSection(null)");
    expect(escapeHandler).toContain("closeDetail()");
    expect(escapeHandler).not.toContain("remoteDetail");
  });

  it("ignores a stale remote preview request after another request or list close", () => {
    expect(skillsSource).toBeTruthy();
    const sessionsSource = readFileSync(new URL("./features/remote-sessions/remote-sessions-dialog.tsx", import.meta.url), "utf8");
    expect(sessionsSource).toContain("detailRequestSeqRef.current++");
    expect(sessionsSource).toContain("requestId !== detailRequestSeqRef.current");
    expect(sessionsSource).toContain("closeRemoteSessionsDialog");
  });

  it("does not keep a second local uploading banner after App reports completion", () => {
    const uploadSelected = skillsSource.slice(
      skillsSource.indexOf("const uploadSelected = async"),
      skillsSource.indexOf("const toggleRemoteSelection"),
    );

    expect(uploadSelected).not.toContain("setBatchFeedback(l(`Uploading");
    expect(uploadSelected).toContain("await onUploadSelected");
  });
});
