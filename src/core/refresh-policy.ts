export const INITIAL_INDEX_DELAY_MS = 750;
export const AUTO_INDEX_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const INITIAL_SKILL_USAGE_REFRESH_DELAY_MS = 1_500;
export const AUTO_SKILL_USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const AUTO_SESSION_SYNC_QUEUE_INTERVAL_MS = 5 * 1000;
export const STALE_SESSION_SYNC_EVENT_AGE_MS = 5 * 60 * 1000;
export const LIVE_SESSION_REFRESH_INTERVAL_MS = 30 * 1000;
export const LIVE_SESSION_SNAPSHOT_CACHE_TTL_MS = 5 * 1000;
// The Claude statusline bridge rewrites ~/.claude/statusline-snapshot.json whenever Claude Code
// renders its statusline, so poll often enough that the quota panel tracks it while the window
// stays open instead of freezing on the value captured at mount.
export const QUOTA_REFRESH_INTERVAL_MS = 60 * 1000;
