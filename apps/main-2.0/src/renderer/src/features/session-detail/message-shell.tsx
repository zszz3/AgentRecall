import { Fragment } from "react";
import type { ReactElement } from "react";
import { Sparkles, UserRound } from "lucide-react";

import { formatMessageTime } from "../../../../core/format-session";
import type { SessionMessage } from "../../../../core/types";
import { localize, type LanguageMode } from "../../language";

export type MessageRole = SessionMessage["role"];

export function messageRoleLabel(role: MessageRole, language: LanguageMode): string {
  return role === "user"
    ? localize(language, "User", "用户")
    : localize(language, "Assistant", "助手");
}

/**
 * Avatar gutter + head line shared by the Turns view and the full conversation view.
 * Returns a fragment so both parts land directly in the parent `.msg` grid columns.
 */
export function MessageHead({
  role,
  phase,
  timestamp,
  language,
}: {
  role: MessageRole;
  phase?: SessionMessage["phase"];
  timestamp: string;
  language: LanguageMode;
}): ReactElement {
  return (
    <Fragment>
      <span className="msg-avatar" aria-hidden>
        {role === "user" ? <UserRound size={11} /> : <Sparkles size={11} />}
      </span>
      <div className="msg-head">
        <strong>{messageRoleLabel(role, language)}</strong>
        {phase === "commentary" ? (
          <span className="msg-phase">{localize(language, "Process note", "过程说明")}</span>
        ) : null}
        <span className="msg-time">{formatMessageTime(timestamp)}</span>
      </div>
    </Fragment>
  );
}
