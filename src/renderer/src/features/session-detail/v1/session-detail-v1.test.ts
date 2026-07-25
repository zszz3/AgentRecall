import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionDetailV1 } from "./SessionDetailV1";

describe("SessionDetailV1", () => {
  it("renders the controlled core actions, metadata, and paged timeline", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailV1, {
        hasOlderMessages: true,
        isFavorite: true,
        messages: [
          {
            content: "Question",
            id: "session-1:8",
            role: "user",
            timestamp: "2026-07-25T08:00:00.000Z",
          },
          {
            content: "Answer",
            id: "session-1:9",
            role: "assistant",
            timestamp: "2026-07-25T08:01:00.000Z",
          },
        ],
        onClose: () => undefined,
        onLoadOlder: () => undefined,
        onRename: () => undefined,
        onResume: () => undefined,
        onToggleFavorite: () => undefined,
        session: {
          id: "session-1",
          messageCount: 100,
          projectPath: "/workspace/project",
          sourceLabel: "Codex",
          startedAt: "2026-07-25T08:00:00.000Z",
          title: "Core session",
        },
      }),
    );

    expect(html).toContain('data-session-id="session-1"');
    expect(html).toContain("Core session");
    expect(html).toContain("/workspace/project");
    expect(html).toContain("100 messages");
    expect(html).toContain('data-message-id="session-1:8"');
    expect(html).toContain('data-message-id="session-1:9"');
    expect(html).toContain('data-page-size="80"');
    expect(html).toContain('aria-label="Remove from favorites"');
    expect(html).toContain(">Resume</button>");
  });
});
