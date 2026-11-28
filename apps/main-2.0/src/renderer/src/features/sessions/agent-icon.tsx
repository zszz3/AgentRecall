import type { ReactElement } from "react";
import type { SessionSource } from "../../../../core/types";
import { SOURCE_LABEL } from "../../session-ui";

// Logos from LobeHub Icons (MIT); see THIRD_PARTY_NOTICES.md. The files are trusted build inputs.
const FILES = import.meta.glob<string>("../../assets/agent-icons/*.svg", { query: "?raw", import: "default", eager: true });

const ICON_FILE: Partial<Record<SessionSource, string>> = {
  "claude-cli": "claudecode-color",
  "claude-app": "claude-color",
  "codex-cli": "codex-color",
  "codex-app": "codex-color",
  "stepcode-claude": "stepfun-color",
  "stepcode-codex": "stepfun-color",
  "codebuddy-cli": "codebuddy-color",
  "workbuddy-cli": "workbuddy-color",
  openclaw: "openclaw-color",
  hermes: "hermesagent",
  "opencode-cli": "opencode",
  "zcode-cli": "zai",
  "cursor-agent": "cursor",
  trae: "trae-color",
  qoder: "qoder-color",
  "qoder-ide": "qoder-color",
  "pi-cli": "pi",
  // omp (oh-my-pi) ships no logo of its own; it is a Pi fork.
  "omp-cli": "pi",
  "deepseek-cli": "deepseek-color",
  "kimi-cli": "kimi-color",
  "qwen-code": "qwen-color",
  "gemini-cli": "geminicli-color",
  antigravity: "antigravity-color",
  "antigravity-cli": "antigravity-color",
};

const markup = new Map<string, string>();

function iconMarkup(source: SessionSource): string | null {
  const name = ICON_FILE[source];
  if (!name) return null;
  const cached = markup.get(name);
  if (cached !== undefined) return cached;
  const svg = FILES[`../../assets/agent-icons/${name}.svg`];
  if (!svg) return null;
  // The label on the wrapper names the agent; the file's own title would add a second tooltip.
  const cleaned = svg.replace(/<title>[^<]*<\/title>/, "").replace(/ style="[^"]*"/, "");
  markup.set(name, cleaned);
  return cleaned;
}

/** The logo of the agent that wrote a Session; agents without a logo show their initial. */
export function AgentIcon({ source, size = 16 }: { source: SessionSource; size?: number }): ReactElement {
  const label = SOURCE_LABEL[source] ?? source;
  const svg = iconMarkup(source);
  return (
    <span
      className="agent-icon inline-flex shrink-0 items-center justify-center text-foreground [&>svg]:size-full"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
      title={label}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      data-agent={source}
    >
      {svg ? undefined : <span className="flex size-full items-center justify-center rounded-[4px] bg-muted text-[10px] leading-none font-semibold text-muted-foreground">{label.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}
