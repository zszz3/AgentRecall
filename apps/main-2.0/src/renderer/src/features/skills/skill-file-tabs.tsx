import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ChevronDown, ChevronUp, FileCode, FolderTree, Search } from "lucide-react";
import { localize, type LanguageMode } from "../../language";

const COLLAPSE_THRESHOLD = 4;
const FILTER_THRESHOLD = 12;

export function SkillFileTabs({
  files,
  activeFile,
  ariaLabel,
  language,
  onSelect,
}: {
  files: ReadonlyArray<{ path: string }>;
  activeFile: string;
  ariaLabel: string;
  language: LanguageMode;
  onSelect(path: string): void;
}): ReactElement | null {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const filesSignature = files.map((file) => file.path).join("\n");

  useEffect(() => {
    setExpanded(false);
    setFilter("");
  }, [filesSignature]);

  const collapsible = files.length > COLLAPSE_THRESHOLD;
  const visibleFiles = useMemo(() => {
    if (!collapsible) return files;
    if (!expanded) {
      const primary = files[0];
      const selected = files.find((file) => file.path === activeFile);
      return selected && selected.path !== primary?.path && primary
        ? [primary, selected]
        : primary
          ? [primary]
          : [];
    }
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((file) => file.path.toLowerCase().includes(needle));
  }, [files, collapsible, expanded, activeFile, filter]);

  if (files.length <= 1) return null;

  const hiddenCount = Math.max(0, files.length - visibleFiles.length);

  return (
    <div className="skill-files-bar">
      <div className="skill-file-tabs" role="tablist" aria-label={ariaLabel}>
        {(!collapsible || !expanded) ? (
          visibleFiles.map((file) => (
            <button
              key={file.path}
              type="button"
              role="tab"
              aria-selected={activeFile === file.path}
              onClick={() => onSelect(file.path)}
            >
              <FileCode size={12} aria-hidden="true" />
              <span>{file.path}</span>
            </button>
          ))
        ) : null}
        {collapsible ? (
          <button
            type="button"
            className="skill-file-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <FolderTree size={12} aria-hidden="true" />
            <span>
              {expanded
                ? l(`Hide files (${files.length})`, `收起文件（${files.length}）`)
                : l(`+${hiddenCount} more files`, `展开全部文件（+${hiddenCount}）`)}
            </span>
            {expanded ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        ) : null}
      </div>

      {collapsible && expanded ? (
        <div className="skill-files-drawer">
          {files.length >= FILTER_THRESHOLD ? (
            <label className="skill-files-filter">
              <Search size={12} aria-hidden="true" />
              <input
                type="search"
                value={filter}
                aria-label={l("Filter Skill files", "筛选 Skill 文件")}
                placeholder={l(`Filter ${files.length} files…`, `在 ${files.length} 个文件中筛选…`)}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
            </label>
          ) : null}
          <div className="skill-file-tabs skill-files-scroll" role="tablist" aria-label={ariaLabel}>
            {visibleFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                role="tab"
                aria-selected={activeFile === file.path}
                onClick={() => onSelect(file.path)}
              >
                <FileCode size={12} aria-hidden="true" />
                <span>{file.path}</span>
              </button>
            ))}
            {visibleFiles.length === 0 ? (
              <span className="skill-files-empty">{l("No matching files.", "没有匹配的文件。")}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
