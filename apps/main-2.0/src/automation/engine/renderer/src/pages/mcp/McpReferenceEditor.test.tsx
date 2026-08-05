import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { McpReferenceEditor } from "./McpReferenceEditor";

describe("MCP reference editor", () => {
  test("renders one row per stdio environment reference", () => {
    const markup = renderToStaticMarkup(
      <McpReferenceEditor
        isHttp={false}
        references={{ API_TOKEN: "HOST_API_TOKEN", MODE: "HOST_MODE" }}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain("Environment references");
    expect(markup).toContain("+ Variable");
    expect(markup).toContain('value="API_TOKEN"');
    expect(markup).toContain('value="HOST_API_TOKEN"');
    expect(markup).toContain('value="MODE"');
    expect(markup).not.toContain("Duplicate names");
  });

  test("renders header wording for http transport", () => {
    const markup = renderToStaticMarkup(
      <McpReferenceEditor
        isHttp
        references={{ Authorization: "HOST_HTTP_TOKEN" }}
        onChange={() => undefined}
      />,
    );
    expect(markup).toContain("Header references");
    expect(markup).toContain("+ Header");
    expect(markup).toContain('value="Authorization"');
  });
});
