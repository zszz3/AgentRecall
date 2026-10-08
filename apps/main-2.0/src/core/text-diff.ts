const MAX_TEXT_DIFF_LINES = 800;

export function renderLineDiff(local: string, remote: string): string {
  const localLines = local ? local.split("\n", MAX_TEXT_DIFF_LINES + 1) : [];
  const remoteLines = remote ? remote.split("\n", MAX_TEXT_DIFF_LINES + 1) : [];
  const truncated = localLines.length > MAX_TEXT_DIFF_LINES || remoteLines.length > MAX_TEXT_DIFF_LINES;
  const a = localLines.slice(0, MAX_TEXT_DIFF_LINES);
  const b = remoteLines.slice(0, MAX_TEXT_DIFF_LINES);
  const ids = new Map<string, number>();
  const intern = (line: string) => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; };
  const aIds = a.map(intern), bIds = b.map(intern);
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = aIds[i] === bIds[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const output: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && aIds[i] === bIds[j]) {
      output.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) {
      output.push(`-${a[i]}`);
      i += 1;
    } else {
      output.push(`+${b[j]}`);
      j += 1;
    }
  }
  if (truncated) output.push(" … diff truncated …");
  return output.join("\n");
}

