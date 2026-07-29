import { describe, expect, it } from "vitest";
import { environmentBadgeLabel, environmentBadgeTitle } from "./session-ui";

describe("session environment badges", () => {
  it("shows the WSL distribution label instead of local", () => {
    const session = { environmentKind: "wsl" as const, environmentLabel: "Ubuntu" };

    expect(environmentBadgeLabel(session, "zh")).toBe("Ubuntu");
    expect(environmentBadgeTitle(session, "zh")).toBe("WSL 环境：Ubuntu");
  });

  it("keeps local sessions labeled as local", () => {
    const session = { environmentKind: "local" as const, environmentLabel: "Local" };

    expect(environmentBadgeLabel(session, "zh")).toBe("本地");
    expect(environmentBadgeTitle(session, "zh")).toBe("这台电脑上的本地会话");
  });
});
