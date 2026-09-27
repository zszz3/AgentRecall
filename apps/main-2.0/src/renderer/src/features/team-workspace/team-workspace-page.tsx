import { useEffect, useRef, useState } from "react";
import { FileText, MessagesSquare, PackageSearch, Settings, UsersRound } from "lucide-react";
import type { LanguageMode } from "../../language";
import { TeamProjectBrowser, type TeamProjectSelection } from "./team-project-browser";
import { TeamAssetsPanel } from "./team-assets-panel";
import { TeamDocumentsPanel } from "./team-documents-panel";
import { TeamSessionsPanel } from "./team-sessions-panel";

export function TeamWorkspacePage({ language, settingsOpen, onOpenSettings }: { language: LanguageMode; settingsOpen: boolean; onOpenSettings(): void }) {
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  return <section className="team-space-page">
    <header className="team-space-heading"><div><h1><UsersRound size={22} />{l("Team Space", "团队空间")}</h1><p>{l("Shared work, organized by team and project.", "按团队和项目整理共享的工作。")}</p></div><button className="settings-action-button" onClick={onOpenSettings}><Settings size={15} />{l("Team settings", "团队设置")}</button></header>
    <TeamProjectBrowser language={language} settingsOpen={settingsOpen} onOpenSettings={onOpenSettings}>{(selection) => <ProjectContent key={`${selection.project.id}:${selection.project.root}:${selection.team?.repository}`} selection={selection} language={language} onOpenSettings={onOpenSettings} />}</TeamProjectBrowser>
  </section>;
}
function ProjectContent({ selection, language, onOpenSettings }: { selection: TeamProjectSelection; language: LanguageMode; onOpenSettings(): void }) {
  const [tab, setTab] = useState<"sessions" | "skills" | "documents">("sessions");
  const [directory, setDirectory] = useState<string>();
  const [choosing, setChoosing] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const selected = { ...selection, ...(directory ? { directory } : {}) };
  async function chooseDirectory() {
    if (running.current) return;
    running.current = true; setChoosing(true); setError("");
    try {
      const reply = await window.sessionSearch.teamWorkspace.request({ action: "choose-folder" });
      if (!alive.current) return;
      if (!reply.ok) setError(reply.error.message);
      else if (reply.data.kind === "folder" && reply.data.value) setDirectory(reply.data.value);
    } catch { if (alive.current) setError(language === "zh" ? "无法选择目录，请重试。" : "Could not select folder. Try again."); }
    finally { running.current = false; if (alive.current) setChoosing(false); }
  }
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  return <div className="team-space-project">
    <div className="team-space-tabs" role="group" aria-label={l("Project resources", "项目资源")}>
      <button aria-pressed={tab === "sessions"} onClick={() => setTab("sessions")}><MessagesSquare size={16} />{l("Shared sessions", "共享会话")}</button>
      <button aria-pressed={tab === "skills"} onClick={() => setTab("skills")}><PackageSearch size={16} />Skills</button>
      <button aria-pressed={tab === "documents"} onClick={() => setTab("documents")}><FileText size={16} />{l("Documents", "文档")}</button>
    </div>
    {tab !== "sessions" && !selection.project.root && <div className="team-local-destination"><span>{directory ?? l("Browse freely; choose a folder when applying assets.", "可以直接浏览；安装或应用时再选择本地目录。")}</span><button className="settings-action-button" disabled={choosing || selection.busy} onClick={() => void chooseDirectory()}>{choosing ? l("Choosing…", "选择中…") : directory ? l("Change local folder", "更换本地目录") : l("Choose local folder", "选择本地目录")}</button>{error && <p role="alert">{error}</p>}</div>}
    {tab === "sessions" ? <TeamSessionsPanel selection={selection} language={language} /> : tab === "skills" ? <TeamAssetsPanel key={directory ?? "unselected"} selection={selected} language={language} onOpenSettings={onOpenSettings} /> : <TeamDocumentsPanel key={directory ?? "unselected"} selection={selected} language={language} />}
  </div>;
}
