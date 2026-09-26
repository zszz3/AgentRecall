import { useState } from "react";
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
  const l = (en: string, zh: string) => language === "zh" ? zh : en;
  return <div className="team-space-project">
    <div className="team-space-tabs" role="group" aria-label={l("Project resources", "项目资源")}>
      <button aria-pressed={tab === "sessions"} onClick={() => setTab("sessions")}><MessagesSquare size={16} />{l("Shared sessions", "共享会话")}</button>
      <button aria-pressed={tab === "skills"} onClick={() => setTab("skills")}><PackageSearch size={16} />Skills</button>
      <button aria-pressed={tab === "documents"} onClick={() => setTab("documents")}><FileText size={16} />{l("Documents", "文档")}</button>
    </div>
    {tab === "sessions" ? <TeamSessionsPanel selection={selection} language={language} /> : tab === "skills" ? <TeamAssetsPanel selection={selection} language={language} onOpenSettings={onOpenSettings} /> : <TeamDocumentsPanel selection={selection} language={language} />}
  </div>;
}
