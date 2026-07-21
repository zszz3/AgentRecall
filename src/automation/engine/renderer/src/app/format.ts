export function formatTime(value: number): string {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value: number): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day} ${hour}:${minute}`;
}

export function formatDuration(value: number): string {
  if (value < 1000) return `${Math.max(0, Math.round(value))}ms`;
  return `${Math.max(0, value / 1000).toFixed(1)}s`;
}
