import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const detailSource = readFileSync(new URL("./features/session-detail/detail-panel.tsx", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("./features/skills/skills-dialog.tsx", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("sync overlay navigation and progress", () => {
  it("keeps the remote session list mounted underneath its preview", () => {
    const openRemoteDetail = appSource.slice(
      appSource.indexOf("function openRemoteDetail"),
      appSource.indexOf("async function loadMoreMessages"),
    );

    expect(openRemoteDetail).not.toContain("setRemoteSessionsOpen(false)");
    expect(appSource).toContain("function closeRemoteDetail");
    expect(appSource).toContain('backdropClassName="remote-detail-backdrop"');
    expect(detailSource).toContain("backdropClassName?: string");
    expect(stylesheet).toMatch(/\.remote-detail-backdrop\s*\{[^}]*z-index:\s*90/);
  });

  it("closes a remote preview before closing the remote session list", () => {
    const remoteListCloseIndex = appSource.indexOf("else if (remoteSessionsOpen)");
    const escapeHandler = appSource.slice(
      appSource.lastIndexOf('if (event.key === "Escape")', remoteListCloseIndex),
      remoteListCloseIndex + 240,
    );

    expect(escapeHandler.indexOf("remoteDetail")).toBeGreaterThanOrEqual(0);
    expect(escapeHandler.indexOf("remoteDetail")).toBeLessThan(escapeHandler.indexOf("remoteSessionsOpen"));
    expect(escapeHandler).toContain("closeRemoteDetail()");
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
