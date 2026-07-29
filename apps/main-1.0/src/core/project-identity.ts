function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function codexTaskWorkspaceDate(projectPath: string): string | null {
  const parts = projectPath.split(/[\\/]+/u).filter(Boolean);
  if (parts.length < 3) return null;
  const codexSegment = parts.at(-3) || "";
  const dateSegment = parts.at(-2) || "";
  const taskSegment = parts.at(-1) || "";
  return codexSegment.toLocaleLowerCase() === "codex"
    && taskSegment
    && validIsoDate(dateSegment)
    ? dateSegment
    : null;
}
