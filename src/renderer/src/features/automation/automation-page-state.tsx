import { AlertTriangle, LoaderCircle, RefreshCw } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { LanguageMode } from "../../language";
import { localize } from "../../language";

export function AutomationPageState({
  loading,
  error,
  language,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  language: LanguageMode;
  onRetry: () => void;
  children: ReactNode;
}): ReactElement {
  if (loading) {
    return (
      <div className="automation-page-state" role="status">
        <LoaderCircle className="is-spinning" size={22} />
        <strong>{localize(language, "Starting automation engine…", "正在启动自动化引擎…")}</strong>
      </div>
    );
  }
  if (error) {
    return (
      <div className="automation-page-state is-error" role="alert">
        <AlertTriangle size={22} />
        <strong>{localize(language, "Automation engine failed to start", "自动化引擎启动失败")}</strong>
        <span>{error}</span>
        <button className="automation-control-button" type="button" onClick={onRetry}>
          <RefreshCw size={13} />{localize(language, "Retry", "重试")}
        </button>
      </div>
    );
  }
  return <>{children}</>;
}
