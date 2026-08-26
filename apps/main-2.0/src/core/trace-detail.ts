export const TRACE_DETAIL_PREVIEW_MAX_CHARS = 12_000;

function codePointSafeSliceEnd(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return end;
  const previousCodeUnit = value.charCodeAt(end - 1);
  const nextCodeUnit = value.charCodeAt(end);
  return previousCodeUnit >= 0xD800
    && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00
    && nextCodeUnit <= 0xDFFF
    ? end - 1
    : end;
}

export function truncateTraceDetail(detail: string, maxChars = TRACE_DETAIL_PREVIEW_MAX_CHARS): string {
  if (detail.length <= maxChars) return detail;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";

  let keepChars = maxChars;
  while (true) {
    keepChars = codePointSafeSliceEnd(detail, keepChars);
    const notice = `\n\n[Indexed preview truncated: ${detail.length - keepChars} characters omitted]`;
    if (notice.length > maxChars) {
      return detail.slice(0, codePointSafeSliceEnd(detail, maxChars));
    }
    const nextKeepChars = codePointSafeSliceEnd(detail, maxChars - notice.length);
    if (nextKeepChars === keepChars) return `${detail.slice(0, keepChars)}${notice}`;
    keepChars = nextKeepChars;
  }
}
