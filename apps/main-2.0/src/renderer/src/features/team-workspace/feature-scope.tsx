import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Settings } from "lucide-react";
import type { AppPage } from "../../components/app-navigation";
import type { LanguageMode } from "../../language";

const TeamAssetsPanel = lazy(() => import("./team-assets-panel").then((module) => ({ default: module.TeamAssetsPanel })));
const names = {
  workbench: ["Workbench", "工作台"], sessions: ["Sessions", "Session"], "team-chat": ["Chat", "Chat"],
  workflows: ["Workflow", "Workflow"], evaluation: ["Eval", "Eval"], runtimes: ["Runtime", "Runtime"],
  mcp: ["MCP", "MCP"], memories: ["Memory", "Memory"], skills: ["Skills", "Skills"], providers: ["Provider", "Provider"],
} as const;

export function FeatureScope({ page, language, scope, settingsOpen, children, onScopeChange, onOpenSettings }: {
  page: AppPage;
  language: LanguageMode;
  scope: "local" | "team";
  settingsOpen: boolean;
  children: ReactNode;
  onScopeChange(scope: "local" | "team"): Promise<boolean>;
  onOpenSettings(): void;
}) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function change(next: "local" | "team") {
    if (running.current || next === scope) return;
    running.current = true; setSwitching(true); setFailed(false);
    try { await onScopeChange(next); }
    catch { if (alive.current) setFailed(true); }
    finally { running.current = false; if (alive.current) setSwitching(false); }
  }
  return <div className="feature-scope">
    <div className="feature-scope-bar">
      <div className="feature-scope-switch" role="group" aria-label={l("Content scope", "内容范围")}>
        <button type="button" aria-pressed={scope === "local"} disabled={switching} onClick={() => void change("local")}>{l("Local", "本地")}</button>
        <button type="button" aria-pressed={scope === "team"} disabled={switching} onClick={() => void change("team")}>{l("Team", "团队")}</button>
      </div>
      <button type="button" className="feature-scope-settings" onClick={onOpenSettings}><Settings size={14} />{l("Team settings", "团队设置")}</button>
    </div>
    {failed && <p role="alert">{l("Could not switch. Save your changes and try again.", "未能切换范围，请保存当前修改后重试。")}</p>}
    <div className="feature-scope-content">
      {scope === "local" ? children : page === "skills" ? <Suspense fallback={<p role="status">{l("Loading team Skills…", "正在读取团队 Skills…")}</p>}><TeamAssetsPanel language={language} settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} /></Suspense> : <section className="feature-scope-empty">
        <h2>{l(names[page][0], names[page][1])} · {l("Team", "团队")}</h2>
        <p>{page === "providers" ? l("Provider credentials stay on this device. Sharing provider templates is not available yet.", "Provider 凭据保存在本机，团队配置模板尚未开放。") : l("Team content for this feature is not available yet. Your local content remains in Local.", "此功能的团队内容尚未开放，个人内容仍在「本地」范围中。")}</p>
        <p>{page === "sessions" ? l("Sessions are not uploaded automatically.", "Session 不会自动上传。") : l("Team Skills and work configurations are available in Skills → Team.", "已支持的团队 Skill 和工作配置可在「Skills → 团队」中使用。")}</p>
        <button type="button" onClick={() => void change("local")}>{l("Back to local", "返回本地")}</button>
      </section>}
    </div>
  </div>;
}
