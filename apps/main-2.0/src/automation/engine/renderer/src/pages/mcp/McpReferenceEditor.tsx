import { useRef, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
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
 * headers) plus optional OS-encrypted secret storage managed by the main process.
 */
export function McpReferenceEditor({
  language = "en",
  isHttp,
  references,
  storedSecretKeys = [],
  missingHostEnvVars = [],
  secretsDisabled = false,
  onSaveSecret,
  onDeleteSecret,
  onChange,
}: {
  language?: Language;
  isHttp: boolean;
  references: Record<string, string>;
  storedSecretKeys?: string[];
  missingHostEnvVars?: string[];
  secretsDisabled?: boolean;
  onSaveSecret?: (key: string, value: string) => Promise<void> | void;
  onDeleteSecret?: (key: string) => Promise<void> | void;
  onChange: (next: Record<string, string>) => void;
}) {
  const zh = language === "zh";
  const rowId = useRef(0);
  const seedRows = (record: Record<string, string>): ReferenceRow[] =>
    Object.entries(record).map(([key, value]) => ({ id: (rowId.current += 1), key, value }));
  const [rows, setRows] = useState<ReferenceRow[]>(() => seedRows(references));
  const [seededFrom, setSeededFrom] = useState(references);
  const [secretKey, setSecretKey] = useState(isHttp ? "Authorization" : "");
  const [secretValue, setSecretValue] = useState("");
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
  const submitSecret = async () => {
    if (!onSaveSecret || !secretKey.trim() || !secretValue) return;
    await onSaveSecret(secretKey.trim(), secretValue);
    setSecretValue("");
  };
  const keys = rows.map((row) => row.key);
  const hasDuplicates = keys.some(
    (key, index) => key && keys.indexOf(key) !== index,
  );

  return (
    <WorkbenchSection
      title={
        isHttp
          ? zh ? "请求头与加密凭据" : "Headers & encrypted secrets"
          : zh ? "环境变量与加密凭据" : "Environment & encrypted secrets"
      }
      description={
        zh
          ? isHttp
            ? "可引用宿主机环境变量名，或直接保存到本机系统加密存储（数据库绝不保存明文密钥）。"
            : "可引用宿主机环境变量名，或直接保存到本机系统加密存储（数据库绝不保存明文密钥）。"
          : isHttp
            ? "Reference host environment variable names or store encrypted values locally (secrets are never written to the database)."
            : "Reference host environment variable names or store encrypted values locally (secrets are never written to the database)."
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
      {missingHostEnvVars.length > 0 ? (
        <div className="mcp-inline-error" role="alert">
          <span>
            {zh
              ? `未检测到宿主机环境变量：${missingHostEnvVars.join("、")}（可在下方改用本机加密保存）。`
              : `Missing host environment variable(s): ${missingHostEnvVars.join(", ")} (or store them encrypted below).`}
          </span>
        </div>
      ) : null}
      {hasDuplicates ? (
        <div className="mcp-inline-error" role="alert">
          <span>
            {zh
              ? "存在重复的名称，保存时只会保留最后一条。"
              : "Duplicate names: only the last entry is kept on save."}
          </span>
        </div>
      ) : null}
      {onSaveSecret ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <KeyRound size={13} />
            <span>
              {zh
                ? isHttp ? "本机加密请求头" : "本机加密环境变量"
                : isHttp ? "Locally encrypted headers" : "Locally encrypted variables"}
            </span>
          </div>
          {storedSecretKeys.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {storedSecretKeys.map((key) => (
                <span
                  key={key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    borderRadius: 6,
                    background: "var(--surface-2, rgba(127,127,127,0.1))",
                  }}
                >
                  <code>{key}</code>
                  <span>{zh ? "已加密" : "Encrypted"}</span>
                  {onDeleteSecret ? (
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={secretsDisabled}
                      aria-label={zh ? `删除加密项 ${key}` : `Delete stored secret ${key}`}
                      onClick={() => void onDeleteSecret(key)}
                    >
                      <Trash2 size={11} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mcp-env-list">
            <div>
              <input
                aria-label={isHttp ? "Encrypted header name" : "Encrypted variable name"}
                placeholder={isHttp ? "Authorization" : "API_KEY"}
                value={secretKey}
                disabled={secretsDisabled}
                onChange={(event) => setSecretKey(event.target.value)}
              />
              <span>=</span>
              <input
                type="password"
                aria-label={zh ? "加密密钥值" : "Secret value"}
                placeholder={isHttp ? "Bearer ..." : (zh ? "输入密钥值（不回显）" : "Enter secret value")}
                value={secretValue}
                disabled={secretsDisabled}
                onChange={(event) => setSecretValue(event.target.value)}
              />
              <button
                type="button"
                className="control-btn compact secondary"
                disabled={secretsDisabled || !secretKey.trim() || !secretValue}
                onClick={() => void submitSecret()}
              >
                {zh ? "加密保存" : "Store"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </WorkbenchSection>
  );
}
