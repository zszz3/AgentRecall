export function formatScore(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(2);
}
export function formatPassRate(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}
export function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}
export function averageCaseScore(
  scores: Array<{ score: number }>,
): number | undefined {
  return scores.length
    ? scores.reduce((sum, score) => sum + score.score, 0) / scores.length
    : undefined;
}
