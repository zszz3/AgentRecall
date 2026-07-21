import { describe, expect, test, vi } from "vitest";
import { fetchOnlineSkills, type OnlineSkillSource } from "./online-skills";

describe("fetchOnlineSkills", () => {
  test("adds GitHub repository search results so candidates are not limited to skills.sh installs", async () => {
    const anthropicSource: OnlineSkillSource = {
      id: "anthropic-skills",
      label: "Anthropic Skills",
      owner: "anthropics",
      repo: "skills",
      branch: "main",
      maxFetch: 10,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://skills.sh/api/search")) {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: "wade56754/ai_ad_spend02/frontend-design",
                skillId: "frontend-design",
                name: "frontend-design",
                installs: 22,
                source: "wade56754/ai_ad_spend02",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                full_name: "design-labs/frontend-skills",
                description: "Frontend design skills for UI systems",
                html_url: "https://github.com/design-labs/frontend-skills",
                stargazers_count: 4820,
                default_branch: "main",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/repos/design-labs/frontend-skills/git/trees/main?recursive=1") {
        return new Response(
          JSON.stringify({
            tree: [{ path: "skills/frontend-design/SKILL.md", type: "blob" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://raw.githubusercontent.com/design-labs/frontend-skills/main/skills/frontend-design/SKILL.md") {
        return new Response(
          [
            "---",
            "name: frontend-design",
            "description: Community frontend visual design guidance.",
            "---",
            "",
            "# Frontend Design",
            "Use for frontend UI design systems, typography, visual design, and product interface review.",
          ].join("\n"),
          { status: 200 },
        );
      }
      if (url === "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1") {
        return new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return new Response(JSON.stringify({ stargazers_count: 155100 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const results = await fetchOnlineSkills("frontend design skill", [anthropicSource], fetcher);
    const githubResult = results.find((skill) => skill.sourceId === "github-search");
    const registryResult = results.find((skill) => skill.sourceId === "skills-sh");

    expect(githubResult).toMatchObject({
      name: "frontend-design",
      sourceLabel: "GitHub Search",
      repositoryUrl: "https://github.com/design-labs/frontend-skills",
      repositoryStars: 4820,
    });
    expect(results.indexOf(githubResult!)).toBeLessThan(results.indexOf(registryResult!));
  });

  test("prioritizes the requested official Anthropic frontend design skill over registry lookalikes", async () => {
    const anthropicSource: OnlineSkillSource = {
      id: "anthropic-skills",
      label: "Anthropic Skills",
      owner: "anthropics",
      repo: "skills",
      branch: "main",
      maxFetch: 10,
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://skills.sh/api/search")) {
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: "wade56754/ai_ad_spend02/frontend-design",
                skillId: "frontend-design",
                name: "frontend-design",
                installs: 22,
                source: "wade56754/ai_ad_spend02",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/repos/anthropics/skills/git/trees/main?recursive=1") {
        return new Response(
          JSON.stringify({
            tree: [
              { path: "skills/web-artifacts-builder/SKILL.md", type: "blob" },
              { path: "skills/brand-guidelines/SKILL.md", type: "blob" },
              { path: "skills/frontend-design/SKILL.md", type: "blob" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/repos/anthropics/skills") {
        return new Response(JSON.stringify({ stargazers_count: 13200 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md") {
        return new Response(
          [
            "---",
            "name: frontend-design",
            "description: Guidance for distinctive, intentional visual design when building new UI.",
            "---",
            "",
            "# Frontend Design",
            "Use when building frontend UI, product interfaces, web apps, and design systems.",
          ].join("\n"),
          { status: 200 },
        );
      }
      if (url === "https://raw.githubusercontent.com/anthropics/skills/main/skills/web-artifacts-builder/SKILL.md") {
        return new Response(
          [
            "---",
            "name: web-artifacts-builder",
            "description: Build polished frontend web artifacts with strong visual design.",
            "---",
            "",
            "# Web Artifacts Builder",
            "Use when creating frontend UI artifacts and web experiences with design direction.",
          ].join("\n"),
          { status: 200 },
        );
      }
      if (url === "https://raw.githubusercontent.com/anthropics/skills/main/skills/brand-guidelines/SKILL.md") {
        return new Response(
          [
            "---",
            "name: brand-guidelines",
            "description: Applies Anthropic's official brand colors and typography.",
            "---",
            "",
            "# Anthropic Brand Styling",
          ].join("\n"),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const results = await fetchOnlineSkills("下载一个前端设计skill，A那家公司的 anthropic frontend design skill", [anthropicSource], fetcher);

    expect(results[0]).toMatchObject({
      sourceId: "anthropic-skills",
      name: "frontend-design",
      path: "skills/frontend-design/SKILL.md",
      repositoryStars: 13200,
    });
    expect(results[0]?.installCommand).toBeUndefined();
  });
});
