import { readFileSync } from "node:fs";

const STYLE_FILES = [
  "./styles.css",
  "./styles/sessions.css",
  "./styles/session-detail.css",
  "./styles/skills.css",
  "./styles/settings.css",
  "./styles/providers.css",
  "./styles/overlays.css",
  "./styles/app-shell.css",
  "./styles/workbench.css",
  "./styles/skills-page.css",
] as const;

export const rendererStyleSource = STYLE_FILES
  .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
  .join("\n");
