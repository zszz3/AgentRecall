const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function normalizeExternalLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  try {
    const url = new URL(value);
    return EXTERNAL_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}
