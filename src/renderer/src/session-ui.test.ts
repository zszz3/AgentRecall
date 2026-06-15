import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../core/platform";
import { projectSortTimestamp, sessionSortOptions, sessionSortTimestamp, sourceFilterLabel, sourceFilters } from "./session-ui";

describe("session source labels", () => {
  it("keeps Claude Code and Codex as the only first-party source filters", () => {
    const filters = sourceFilters(null);
    const labels = filters.map((filter) => sourceFilterLabel(filter, "en"));
    const zhLabels = filters.map((filter) => sourceFilterLabel(filter, "zh"));

    expect(labels).toEqual(expect.arrayContaining(["All", "Claude Code", "Codex"]));
    expect(zhLabels).toEqual(expect.arrayContaining(["全部", "Claude Code", "Codex"]));
    expect(labels).not.toEqual(expect.arrayContaining(["Claude", "Claude App", "Codex CLI", "Codex App"]));
  });

  it("shows optional local agent sources only after they are enabled in settings", () => {
    const defaultLabels = sourceFilters(defaultSettings).map((filter) => sourceFilterLabel(filter, "en"));

    expect(defaultLabels).not.toEqual(expect.arrayContaining(["OpenClaw", "Hermes", "OpenCode", "Cursor Agent", "Trae"]));

    const enabledLabels = sourceFilters({
      ...defaultSettings,
      includeOpenClaw: true,
      includeHermes: true,
      includeOpenCode: true,
      includeCursorAgent: true,
      includeTrae: true,
    }).map((filter) => sourceFilterLabel(filter, "en"));

    expect(enabledLabels).toEqual(expect.arrayContaining(["OpenClaw", "Hermes", "OpenCode", "Cursor Agent", "Trae"]));
  });

  it("uses the selected sort mode to choose the session timestamp shown in rows", () => {
    const session = {
      timestamp: 100,
      fileMtimeMs: 300,
      lastResumedAt: 500,
      lastActivityAt: 400,
    };

    expect(sessionSortTimestamp(session, "created")).toBe(100);
    expect(sessionSortTimestamp(session, "activity")).toBe(400);
  });

  it("uses latest activity instead of creation time for project rows sorted by activity", () => {
    const project = {
      createdAt: 100,
      lastActivityAt: 900,
    };

    expect(projectSortTimestamp(project, "created")).toBe(100);
    expect(projectSortTimestamp(project, "activity")).toBe(900);
  });

  it("does not expose updated time as a separate session sort option", () => {
    expect(sessionSortOptions().map((option) => option.value)).toEqual(["activity", "created"]);
  });

  it("labels activity sorting as recent conversation", () => {
    expect(sessionSortOptions()[0]).toEqual({ label: "Recent conversation", value: "activity" });
  });
});
