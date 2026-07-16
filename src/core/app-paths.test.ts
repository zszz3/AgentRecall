import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbPointerPath, resolveDbPath, writeDbPointer } from "./app-paths";

describe("app-paths db pointer", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "app-paths-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes and reads back the pointer", () => {
    writeDbPointer("/data/session-search.sqlite", home);
    expect(readFileSync(dbPointerPath(home), "utf8").trim()).toBe("/data/session-search.sqlite");
    expect(resolveDbPath({}, home)).toBe("/data/session-search.sqlite");
  });

  it("prefers the env override over the pointer", () => {
    writeDbPointer("/data/from-pointer.sqlite", home);
    expect(resolveDbPath({ AGENT_RECALL_DB: "/data/from-env.sqlite" }, home)).toBe("/data/from-env.sqlite");
  });

  it("returns null when neither override nor pointer exists", () => {
    expect(resolveDbPath({}, home)).toBeNull();
  });
});
