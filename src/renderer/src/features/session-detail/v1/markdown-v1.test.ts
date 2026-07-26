import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownV1 } from "./MarkdownV1";
import { SessionMessageCardV1, type SessionDetailMessageV1 } from "./SessionDetailV1";

function renderMarkdown(markdown: string, allowExternalImages = false): string {
  return renderToStaticMarkup(
    createElement(MarkdownV1, { allowExternalImages }, markdown),
  );
}

describe("MarkdownV1", () => {
  it("renders GFM tables, fenced code, and secure external links", () => {
    const html = renderMarkdown(
      [
        "| Name | Value |",
        "| --- | ---: |",
        "| alpha | 1 |",
        "",
        "```ts",
        "const answer = 42;",
        "```",
        "",
        "[Open docs](https://example.com/docs)",
      ].join("\n"),
    );

    expect(html).toContain("<table>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain('data-language="ts"');
    expect(html).toContain("const answer = 42;");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("discards raw HTML rather than parsing it", () => {
    const html = renderMarkdown(
      "before <script>alert('xss')</script> <img src=x onerror=alert(1)> after",
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it.each([
    "http://images.example/a.png",
    "https://images.example/a.png",
    "//images.example/a.png",
    "ftp://images.example/a.png",
    "file:///tmp/private.png",
    "file://server/share/private.png",
    "/Users/example/private.png",
    "C:/Users/example/private.png",
  ])("blocks external image source %s by default", (source) => {
    const html = renderMarkdown(`![architecture](${source})`);

    expect(html).toContain("Image blocked: architecture");
    expect(html).not.toContain("<img");
    expect(html).not.toContain(source);
  });

  it("only renders an external image src after explicit opt-in", () => {
    const source = "https://images.example/a.png";
    const html = renderMarkdown(`![architecture](${source})`, true);

    expect(html).toContain("<img");
    expect(html).toContain(`src="${source}"`);
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it.each([
    "file:///tmp/private.png",
    "file://server/share/private.png",
    "\\\\server\\share\\private.png",
    "C:\\Users\\example\\private.png",
  ])("keeps local or UNC image source %s blocked after network opt-in", (source) => {
    const html = renderMarkdown(`![private](${source})`, true);

    expect(html).not.toContain("<img");
    expect(html).not.toContain(source);
  });
});

describe("SessionMessageCardV1", () => {
  const longMessage: SessionDetailMessageV1 = {
    content: `visible start\n\n${"middle ".repeat(100)}secret tail`,
    id: "message-long",
    role: "assistant",
    timestamp: "2026-07-25T08:30:00.000Z",
  };

  it("collapses a very long message to a bounded preview by default", () => {
    const html = renderToStaticMarkup(
      createElement(SessionMessageCardV1, {
        message: longMessage,
        previewCharacters: 240,
      }),
    );

    expect(html).toContain("visible start");
    expect(html).not.toContain("secret tail");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show full message");
  });

  it("renders the complete long message when initially expanded", () => {
    const html = renderToStaticMarkup(
      createElement(SessionMessageCardV1, {
        defaultExpanded: true,
        message: longMessage,
        previewCharacters: 240,
      }),
    );

    expect(html).toContain("secret tail");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Show less");
  });
});
