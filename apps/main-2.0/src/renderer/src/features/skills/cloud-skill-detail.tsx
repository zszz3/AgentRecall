import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Cloud, Download } from "lucide-react";
import type { RemoteSkill, RemoteSkillGroup } from "../../../../core/skill-sync";
import { localize, type LanguageMode } from "../../language";
import { Markdown } from "../../markdown";
import { markdownPreview, skillMarkdownBody } from "../../markdown-preview";

export function CloudSkillDetail({
  group,
  busy,
  language,
  onInstall,
  onFetchVersion,
}: {
  group: RemoteSkillGroup;
  busy: boolean;
  language: LanguageMode;
  onInstall: (remoteSkillId: string) => Promise<void>;
  onFetchVersion: (remoteSkillId: string) => Promise<RemoteSkill>;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [selectedVersionId, setSelectedVersionId] = useState(group.latest.id);
  const [markdown, setMarkdown] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedVersion = group.versions.find((version) => version.id === selectedVersionId) ?? group.latest;

  useEffect(() => {
    setSelectedVersionId(group.latest.id);
  }, [group.fingerprint, group.latest.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMarkdown("");
    onFetchVersion(selectedVersion.id)
      .then((remote) => {
        if (!cancelled) setMarkdown(remote.markdown);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onFetchVersion, selectedVersion.id]);

  return (
    <main className="skill-library-detail">
      <header className="managed-skill-head">
        <div className="managed-skill-title">
          <div>
            <h3>{group.name}</h3>
            <span>{l("Cloud", "云端")}</span>
          </div>
          <p>{group.description || l("No description", "暂无说明")}</p>
        </div>
        <div className="managed-skill-actions">
          <button type="button" className="primary" disabled={busy || group.legacy} onClick={() => void onInstall(selectedVersion.id)}>
            <Download size={14} />
            {l("Add to Skill library", "加入 Skill 库")}
          </button>
        </div>
      </header>

      <section className="managed-skill-document">
        <div className="managed-skill-document-head">
          <span><Cloud size={12} /> SKILL.md</span>
          <small>{l(`${group.versions.length} cloud versions`, `${group.versions.length} 个云端版本`)}</small>
        </div>
        <div className="managed-skill-version-list cloud-skill-version-list">
          {group.versions.map((version) => (
            <button
              key={version.id}
              type="button"
              className={version.id === selectedVersion.id ? "active" : ""}
              onClick={() => setSelectedVersionId(version.id)}
            >
              <strong>v{version.version}</strong>
              <span>{new Date(version.updatedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</span>
            </button>
          ))}
        </div>
        <div className="managed-skill-markdown">
          {loading ? l("Loading cloud Skill…", "正在加载云端 Skill…") : error ? error : (
            <Markdown text={markdownPreview(skillMarkdownBody(markdown), 18_000, l("…(truncated)", "…（已截断）"))} language={language} />
          )}
        </div>
      </section>
    </main>
  );
}
