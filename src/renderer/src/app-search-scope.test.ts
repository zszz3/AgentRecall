import { describe, expect, it } from "vitest";
import { resolveSearchScope } from "./features/search/search-scope";
import { existingSshHostAliases } from "./features/settings/ssh-environment-dialog";

describe("resolveSearchScope", () => {
  it("marks explicit environment and another environment's selected project as incompatible", () => {
    expect(resolveSearchScope("ssh-b", "/work/app", "ssh-a")).toEqual({
      environmentId: "ssh-b",
      projectPath: "/work/app",
      projectEnvironmentConflict: true,
    });
  });

  it("keeps all-environment project filters scoped to the selected project environment", () => {
    expect(resolveSearchScope("all", "/work/app", "ssh-a")).toEqual({
      environmentId: "ssh-a",
      projectPath: "/work/app",
      projectEnvironmentConflict: false,
    });
  });
});

describe("existingSshHostAliases", () => {
  it("returns only actual aliases already represented by SSH environments", () => {
    expect(
      existingSshHostAliases([
        { kind: "local", label: "Local", hostAlias: null },
        { kind: "ssh", label: "devbox", hostAlias: "devbox" },
        { kind: "ssh", label: "prod", hostAlias: null },
        { kind: "ssh", label: "local", hostAlias: null },
      ]),
    ).toEqual(new Set(["devbox"]));
  });
});
