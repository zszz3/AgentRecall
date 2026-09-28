// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AppNavigation, type AppPage } from "./app-navigation";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("grouped main navigation", () => {
  it.each(["en", "zh"] as const)("keeps every page and settings reachable in %s", async language => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onNavigate = vi.fn();
    const onOpenSettings = vi.fn();
    try {
      await act(async () => root.render(<AppNavigation activePage="sessions" settingsOpen={false}
        signalUpdate={true} language={language} onNavigate={onNavigate} onOpenSettings={onOpenSettings} />));
      expect([...host.querySelectorAll('[role="group"]')].map(group => group.getAttribute("aria-label"))).toEqual(
        language === "en" ? ["Home", "Work", "Automation", "Knowledge", "Connections"] : ["首页", "工作", "自动化", "知识", "连接"],
      );
      const pages: AppPage[] = ["workbench", "sessions", "team-chat", "runtimes", "workflows", "evaluation", "memories", "skills", "mcp", "providers"];
      const buttons = [...host.querySelectorAll<HTMLButtonElement>("nav button")];
      expect(buttons.map(button => button.dataset.page)).toEqual(pages);
      for (const button of buttons) await act(async () => button.click());
      expect(onNavigate.mock.calls.map(([page]) => page)).toEqual(pages);
      expect(host.querySelector('[aria-current="page"]')?.getAttribute("data-page")).toBe("sessions");
      const settings = host.querySelector<HTMLButtonElement>(".app-navigation-settings")!;
      expect(settings.closest("nav")).toBeNull();
      await act(async () => settings.click());
      expect(onOpenSettings).toHaveBeenCalledOnce();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
