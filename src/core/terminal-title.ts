const MAX_TERMINAL_TITLE_CODE_POINTS = 160;

export function normalizeTerminalTitle(value: string): string {
  const normalized =
    value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "Untitled Session";
  return Array.from(normalized).slice(0, MAX_TERMINAL_TITLE_CODE_POINTS).join("");
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function withPosixTerminalTitle(command: string, title: string): string {
  return `printf '\\033]0;%s\\007' ${posixQuote(normalizeTerminalTitle(title))} && ${command}`;
}

export function withPowerShellTerminalTitle(command: string, title: string): string {
  return `$Host.UI.RawUI.WindowTitle = ${powershellQuote(normalizeTerminalTitle(title))}; ${command}`;
}

export function withCmdTerminalTitle(command: string, title: string): string {
  const safeTitle = normalizeTerminalTitle(title)
    .replace(/[%!^&|<>"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safeTitle ? `title ${safeTitle} & ${command}` : command;
}

export function windowsTerminalTitleArgs(title: string): string[] {
  return ["--title", normalizeTerminalTitle(title), "--suppressApplicationTitle"];
}
