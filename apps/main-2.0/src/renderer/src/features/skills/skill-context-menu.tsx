import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import type { InstalledSkill } from "../../../../core/skill-manager";
import { useClampedContextMenuStyle } from "../../context-menu-position";
import { localize, type LanguageMode } from "../../language";

export interface SkillContextMenuState {
  skill: InstalledSkill;
  x: number;
  y: number;
}

export function SkillContextMenu({
  state,
  language,
  onDelete,
}: {
  state: SkillContextMenuState;
  language: LanguageMode;
  onDelete: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const menu = useClampedContextMenuStyle(state);
  return (
    <div
      ref={menu.ref}
      className="context-menu skill-context-menu"
      style={menu.style}
      role="menu"
      aria-label={l(`Actions for ${state.skill.name}`, `${state.skill.name} 的操作`)}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" className="danger" role="menuitem" onClick={onDelete}>
        <Trash2 size={14} /> {l("Delete", "删除")}
      </button>
    </div>
  );
}
