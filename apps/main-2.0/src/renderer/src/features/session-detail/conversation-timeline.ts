import { tracePresentation } from "../../../../core/trace-presentation";
import type { SessionMessage, SessionTraceEvent } from "../../../../core/types";
import type { TurnMessageRoleFilter } from "./turn-timeline";

export type ConversationTimelineItem =
  | { kind: "message"; key: string; timestampMs: number | null; order: number; message: SessionMessage }
  | { kind: "trace"; key: string; timestampMs: number | null; order: number; event: SessionTraceEvent };

export type ConversationRoleFilter = TurnMessageRoleFilter;

function timestampMs(timestamp: string): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function messageTimelineItem(message: SessionMessage): ConversationTimelineItem {
  return {
    kind: "message",
    key: `message:${message.index}`,
    timestampMs: timestampMs(message.timestamp),
    order: message.index * 2,
    message,
  };
}

/**
 * Interleaves loaded messages with presentable trace events by timestamp; items
 * without a timestamp sort last and ties keep source order. While messages are
 * loaded, a trace event without a source turn is kept only when its timestamp is
 * unknown or inside the loaded messages' time range.
 */
export function conversationTimeline(messages: SessionMessage[], traceEvents: SessionTraceEvent[]): ConversationTimelineItem[] {
  const messageTimes = messages.map((message) => timestampMs(message.timestamp)).filter((time): time is number => time !== null);
  const minMessageTime = messageTimes.length > 0 ? Math.min(...messageTimes) : null;
  const maxMessageTime = messageTimes.length > 0 ? Math.max(...messageTimes) : null;
  const presentableTraceEvents = traceEvents.filter(
    (event) => tracePresentation(event).visibility !== "hidden",
  );
  const visibleTraceEvents =
    messages.length === 0
      ? presentableTraceEvents
      : presentableTraceEvents.filter((event) => {
          if (event.sourceTurnId) return true;
          const time = timestampMs(event.timestamp);
          return time === null || minMessageTime === null || maxMessageTime === null || (time >= minMessageTime && time <= maxMessageTime);
        });

  const items: ConversationTimelineItem[] = [
    ...messages.map(messageTimelineItem),
    ...visibleTraceEvents.map((event) => ({
      kind: "trace" as const,
      key: `trace:${event.index}`,
      timestampMs: timestampMs(event.timestamp),
      order: event.index * 2 + 1,
      event,
    })),
  ];

  return items.sort((a, b) => {
    if (a.timestampMs !== null && b.timestampMs !== null && a.timestampMs !== b.timestampMs) {
      return a.timestampMs - b.timestampMs;
    }
    if (a.timestampMs !== null && b.timestampMs === null) return -1;
    if (a.timestampMs === null && b.timestampMs !== null) return 1;
    return a.order - b.order;
  });
}

export function filterConversationTimeline(
  items: ConversationTimelineItem[],
  roleFilter: ConversationRoleFilter,
  showTools: boolean,
): ConversationTimelineItem[] {
  return items.filter((item) => {
    if (item.kind === "trace") {
      const presentation = tracePresentation(item.event);
      if (presentation.visibility === "hidden") return false;
      return presentation.category !== "tool" || showTools;
    }
    return roleFilter === "all" || item.message.role === roleFilter;
  });
}

/**
 * Keys of timeline items matching any lowercased find term: message content,
 * or a trace event's title, detail and event type.
 */
export function timelineFindMatchKeys(items: readonly ConversationTimelineItem[], terms: readonly string[]): string[] {
  if (terms.length === 0) return [];
  const keys: string[] = [];
  for (const item of items) {
    const haystack = item.kind === "message"
      ? item.message.content.toLocaleLowerCase()
      : [item.event.title, item.event.detail, item.event.eventType]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
    if (terms.some((term) => haystack.includes(term))) keys.push(item.key);
  }
  return keys;
}
