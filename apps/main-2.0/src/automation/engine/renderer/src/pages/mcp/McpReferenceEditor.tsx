import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Language } from "../../app/language";
import { WorkbenchSection } from "../../ui/workbench/Workbench";

interface ReferenceRow {
  id: number;
  key: string;
  value: string;
}

function foldRows(rows: ReferenceRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
}

/**
 * Editable name → host-environment-variable reference list (stdio env or HTTP
 * headers). Rows carry stable ids so renaming edits the input in place instead
 * of remounting it (which used to drop focus on every keystroke) and duplicate
 * names stay visible with a warning instead of silently merging.
 */
export function McpReferenceEditor({
  language = "en",
  isHttp,
  references,
  onChange,
}: {
  language?: Language;
  isHttp: boolean;
  references: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const zh = language === "zh";
  const rowId = useRef(0);
  const seedRows = (record: Record<string, string>): ReferenceRow[] =>
    Object.entries(record).map(([key, value]) => ({ id: (rowId.current += 1), key, value }));
  const [rows, setRows] = useState<ReferenceRow[]>(() => seedRows(references));
  const [seededFrom, setSeededFrom] = useState(references);
  // Reseed when the record changes underneath us (JSON apply, transport
  // switch). Our own onChange echoes fold back to identical content, so the
  // deep compare skips them and local row identity survives.
  if (references !== seededFrom) {
    if (JSON.stringify(foldRows(rows)) !== JSON.stringify(references)) {
      setRows(seedRows(references));
    }
    setSeededFrom(references);
  }

  const emit = (nextRows: ReferenceRow[]) => {
    setRows(nextRows);
    onChange(foldRows(nextRows));
  };
  const addRow = () => {
    const used = new Set(rows.map((row) => row.key));
    const candidates = isHttp ? ["Authorization", "New-Header"] : ["NEW_VARIABLE"];
    let key = candidates.find((name) => !used.has(name));
    for (let index = 2; !key; index += 1) {
      const candidate = `${isHttp ? "New-Header-" : "NEW_VARIABLE_"}${index}`;
      if (!used.has(candidate)) key = candidate;
    }
    emit([...rows, { id: (rowId.current += 1), key, value: "" }]);
  };
  const keys = rows.map((row) => row.key);
  const hasDuplicates = keys.some(
    (key, index) => key && keys.indexOf(key) !== index,
  );

  return (
    <WorkbenchSection
      title={
        isHttp
          ? zh ? "请求头引用" : "Header references"
          : zh ? "环境变量引用" : "Environment references"
      }
      description={
        zh
          ? isHttp
            ? "左侧填写请求头名称（如 Authorization），右侧填写宿主机环境变量名，不在数据库中保存密钥值。"
            : "右侧填写宿主机环境变量名，不在数据库中保存密钥值。"
          : isHttp
            ? "Map header names (e.g. Authorization) to host environment variable names; secret values are not stored."
            : "Reference host environment variable names; secret values are not stored."
      }
      action={
        <button
          type="button"
          className="control-btn compact secondary"
          onClick={addRow}
        >
          {isHttp ? "+ Header" : "+ Variable"}
        </button>
      }
    >
      <div className="mcp-env-list">
        {rows.map((row) => (
          <div key={row.id}>
            <input
              aria-label={isHttp ? "Header name" : "Environment key"}
              value={row.key}
              onChange={(event) =>
                emit(rows.map((item) =>
                  item.id === row.id ? { ...item, key: event.target.value } : item,
                ))
              }
            />
            <span>←</span>
            <input
              aria-label="Host environment variable"
              value={row.value}
              placeholder="HOST_ENV_NAME"
              onChange={(event) =>
                emit(rows.map((item) =>
                  item.id === row.id ? { ...item, value: event.target.value } : item,
                ))
              }
            />
            <button
              className="icon-btn"
              type="button"
              aria-label={
                isHttp
                  ? zh ? "删除请求头" : "Delete header"
                  : zh ? "删除环境变量" : "Delete environment variable"
              }
              title={
                isHttp
                  ? zh ? "删除请求头" : "Delete header"
                  : zh ? "删除环境变量" : "Delete environment variable"
              }
              onClick={() => emit(rows.filter((item) => item.id !== row.id))}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      {hasDuplicates ? (
        <div className="mcp-inline-error" role="alert">
          <span>
            {zh
              ? "存在重复的名称，保存时只会保留最后一条。"
              : "Duplicate names: only the last entry is kept on save."}
          </span>
        </div>
      ) : null}
    </WorkbenchSection>
  );
}
