import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractCursorUserQuery } from "./format-adapters";
import {
  encodeCursorWorkspaceSlug,
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  parseCursorTranscriptPath,
  parseJsonlText,
} from "./session-loader";
import { writeMigratedSession } from "./session-migration-writers";
import type { LoadedSession, MigrationTarget, PortableSession, SessionSource } from "./types";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const MESSAGE_IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
];
const NOW = new Date("2026-06-23T06:07:08.901Z");
const TARGETS = [
  { target: "claude", root: ".claude", source: "claude-cli", family: "claude" },
  { target: "tclaude", root: ".tclaude", source: "tclaude-cli", family: "claude" },
  { target: "claude-internal", root: ".claude-internal", source: "claude-internal", family: "claude" },
  { target: "codex", root: ".codex", source: "codex-cli", family: "codex" },
  { target: "tcodex", root: ".tcodex", source: "tcodex-cli", family: "codex" },
  { target: "codex-internal", root: ".codex-internal", source: "codex-internal", family: "codex" },
  { target: "codebuddy", root: ".codebuddy", source: "codebuddy-cli", family: "codebuddy" },
  { target: "cursor", root: ".cursor", source: "cursor-agent", family: "cursor" },
] as const satisfies readonly {
  target: MigrationTarget;
  root: string;
  source: SessionSource;
  family: "claude" | "codex" | "codebuddy" | "cursor";
}[];

function portable(): PortableSession {
  return {
    sourceSessionKey: "codex:source",
    sourceAgent: "codex",
    title: "迁移标题 🚀",
    projectPath: "/Users/测试/My Project",
    startedAt: "2026-06-20T01:02:03.004Z",
    messages: [
      { role: "user", content: "你好，世界 🌏", timestamp: "2026-06-20T01:02:04.005Z", index: 0 },
      { role: "assistant", content: "已收到\n第二行", timestamp: "2026-06-20T01:02:05.006Z", index: 1 },
      { role: "user", content: "继续", timestamp: "2026-06-20T01:02:06.007Z", index: 2 },
    ],
  };
}

function idFactory(ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error("Unexpected idFactory call");
    return id;
  };
}

function readRows(filePath: string): Array<Record<string, any>> {
  const text = fs.readFileSync(filePath, "utf8");
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  return parseJsonlText(text) as Array<Record<string, any>>;
}

function expectRoundTrip(
  target: MigrationTarget,
  source: SessionSource,
  sessionId: string,
  filePath: string,
  rows: Array<Record<string, any>>,
  session: PortableSession = portable(),
): void {
  const loaded = loadWrittenSession(target, source, filePath, rows, session);

  const firstUser = session.messages.find((message) => message.role === "user")?.content || "";
  expect(loaded?.session).toMatchObject({
    rawId: sessionId,
    projectPath: session.projectPath,
    ...(target === "cursor"
      ? { firstQuestion: extractCursorUserQuery(firstUser) }
      : { originalTitle: session.title }),
    source,
  });
  if (target === "cursor") {
    expect(loaded?.messages.map(({ role, content }) => ({ role, content }))).toEqual(
      session.messages.map(({ role, content }) => ({
        role,
        content: role === "user" ? extractCursorUserQuery(content) : content,
      })),
    );
    return;
  }

  expect(loaded?.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp }))).toEqual(
    session.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })),
  );
}

function loadWrittenSession(
  target: MigrationTarget,
  source: SessionSource,
  filePath: string,
  rows: Array<Record<string, any>>,
  session: PortableSession = portable(),
): LoadedSession | null {
  if (target === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  if (target === "cursor") {
    const { workspaceSlug } = parseCursorTranscriptPath(filePath);
    const workspacePathMap = workspaceSlug
      ? new Map([[workspaceSlug, session.projectPath]])
      : undefined;
    return loadCursorTranscriptFile(filePath, undefined, workspacePathMap);
  }
  if (target === "codex" || target === "tcodex" || target === "codex-internal") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: source });
  }
  return loadClaudeCliSessionRows(filePath, rows, { source });
}

describe("writeMigratedSession", () => {
  it.each(TARGETS)(
    "creates the temporary and final $target files with mode 0600",
    async ({ target, root, family }) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-mode-${target}-`));
      let temporaryMode = 0;
      const targetDirectory = family === "codex"
        ? path.join(homeDir, root, "sessions", "2026", "06", "23")
        : family === "claude"
          ? path.join(homeDir, root, "projects", "-Users----My-Project")
          : family === "cursor"
            ? path.join(
              homeDir,
              ".cursor",
              "projects",
              encodeCursorWorkspaceSlug(portable().projectPath),
              "agent-transcripts",
              SESSION_ID,
            )
            : path.join(homeDir, ".codebuddy", "projects", "Users----My-Project");
      fs.mkdirSync(targetDirectory, { recursive: true });
      const previousUmask = process.umask(0o777);

      try {
        let result;
        try {
          result = await writeMigratedSession({
            target,
            session: portable(),
            homeDir,
            now: NOW,
            idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
            beforeValidate: (filePath) => {
              temporaryMode = fs.statSync(filePath).mode & 0o777;
              fs.chmodSync(filePath, 0o644);
            },
          });
        } finally {
          process.umask(previousUmask);
        }

        expect(temporaryMode).toBe(0o600);
        expect(fs.statSync(result.filePath).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it.each(TARGETS)(
    "writes $target under $root and round-trips with its concrete source",
    async ({ target, root, source, family }) => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-roundtrip-${target}-`));
      try {
        const result = await writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
        });

        expect(path.relative(homeDir, result.filePath).split(path.sep)[0]).toBe(root);
        const rows = readRows(result.filePath);
        expectRoundTrip(target, source, result.sessionId, result.filePath, rows);
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    },
  );

  it("writes a native Codex rollout and round-trips it through the existing loader", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codex-"));

    const pending = writeMigratedSession({
      target: "codex",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID]),
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result).toEqual({
      sessionId: SESSION_ID,
      filePath: path.join(
        homeDir,
        ".codex",
        "sessions",
        "2026",
        "06",
        "23",
        `rollout-2026-06-23T06-07-08-901Z-${SESSION_ID}.jsonl`,
      ),
    });
    expect(fs.existsSync(path.join(homeDir, ".codex", "session_index.jsonl"))).toBe(false);

    const rows = readRows(result.filePath);
    expect(rows[0]).toEqual({
      type: "session_meta",
      timestamp: portable().startedAt,
      payload: {
        id: SESSION_ID,
        timestamp: portable().startedAt,
        cwd: portable().projectPath,
        title: portable().title,
        originator: "agent-recall",
        cli_version: "migration",
        model_provider: "openai",
      },
    });
    expect(rows.slice(1).map((row) => row.payload.content[0].type)).toEqual([
      "input_text",
      "output_text",
      "input_text",
    ]);
    expectRoundTrip("codex", "codex-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    ["codex", "openai"],
    ["tcodex", "tencent"],
    ["codex-internal", "openai"],
  ] as const)("writes the resumable $target model provider", async (target, modelProvider) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-provider-${target}-`));
    try {
      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      const rows = readRows(result.filePath);
      expect(rows[0]?.payload?.model_provider).toBe(modelProvider);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["codex", ".codex", "custom-codex"],
    ["tcodex", ".tcodex", "custom-tcodex"],
    ["codex-internal", ".codex-internal", "custom-codex-internal"],
  ] as const)("uses the active provider from the $target config", async (target, root, modelProvider) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-configured-provider-${target}-`));
    try {
      const targetHome = path.join(homeDir, root);
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        `model_provider = "${modelProvider}"\n\n[profiles.unused]\nmodel_provider = "profile-only"\n`,
      );

      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe(modelProvider);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("ignores profile-scoped Codex providers when no active provider is configured", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-profile-provider-"));
    try {
      const targetHome = path.join(homeDir, ".codex-internal");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        '[profiles.internal]\nmodel_provider = "profile-only"\n',
      );

      const result = await writeMigratedSession({
        target: "codex-internal",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("openai");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the provider from the selected Codex profile", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-active-profile-provider-"));
    try {
      const targetHome = path.join(homeDir, ".codex");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "config.toml"),
        [
          'profile = "work"',
          'model_provider = "root-provider"',
          "",
          "[profiles.work]",
          'model_provider = "profile-provider"',
          "",
        ].join("\n"),
      );

      const result = await writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("profile-provider");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back when the active Codex provider is malformed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-malformed-provider-"));
    try {
      const targetHome = path.join(homeDir, ".tcodex");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "config.toml"), "model_provider = [\n");

      const result = await writeMigratedSession({
        target: "tcodex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(readRows(result.filePath)[0]?.payload?.model_provider).toBe("tencent");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes native Claude rows with a unique UUID parent chain and embedded title", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-claude-"));

    const result = await writeMigratedSession({
      target: "claude",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
    });

    expect(result.filePath).toBe(
      path.join(homeDir, ".claude", "projects", "-Users----My-Project", `${SESSION_ID}.jsonl`),
    );
    expect(fs.existsSync(path.join(homeDir, ".claude", "sessions"))).toBe(false);

    const rows = readRows(result.filePath);
    expect(rows[0]).toMatchObject({ type: "ai-title", aiTitle: portable().title, sessionId: SESSION_ID });
    const messages = rows.slice(1);
    expect(messages.map((row) => row.uuid)).toEqual(MESSAGE_IDS);
    expect(messages.map((row) => row.parentUuid)).toEqual([null, MESSAGE_IDS[0], MESSAGE_IDS[1]]);
    expect(messages.map((row) => [row.type, row.message.role])).toEqual([
      ["user", "user"],
      ["assistant", "assistant"],
      ["user", "user"],
    ]);
    expect(messages[1]?.message?.model).toBe("session-migration");
    for (const [index, row] of messages.entries()) {
      expect(row).toMatchObject({
        cwd: portable().projectPath,
        sessionId: SESSION_ID,
        timestamp: portable().messages[index].timestamp,
        entrypoint: "cli",
        version: "migration",
      });
    }
    expectRoundTrip("claude", "claude-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each([
    ["claude", ".claude", "configured-claude-model"],
    ["tclaude", ".tclaude", "configured-tclaude-model"],
    ["claude-internal", ".claude-internal", "configured-claude-internal-model"],
  ] as const)("uses the routed model from the $target settings", async (target, root, model) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-configured-model-${target}-`));
    try {
      const targetHome = path.join(homeDir, root);
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(
        path.join(targetHome, "settings.json"),
        `${JSON.stringify({ model: "top-level-model", env: { ANTHROPIC_MODEL: `  ${model}  ` } }, null, 2)}\n`,
      );

      const result = await writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual([model]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the top-level Claude model when no routed model is configured", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-top-level-model-"));
    try {
      const targetHome = path.join(homeDir, ".claude");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "settings.json"), '{"model":"  opus  ","env":{}}\n');

      const result = await writeMigratedSession({
        target: "claude",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual(["opus"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back when the Claude settings are malformed", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-malformed-claude-settings-"));
    try {
      const targetHome = path.join(homeDir, ".claude-internal");
      fs.mkdirSync(targetHome, { recursive: true });
      fs.writeFileSync(path.join(targetHome, "settings.json"), "{\n");

      const result = await writeMigratedSession({
        target: "claude-internal",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
      });

      const assistantRows = readRows(result.filePath).filter((row) => row.type === "assistant");
      expect(assistantRows.map((row) => row.message.model)).toEqual(["session-migration"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes native CodeBuddy title and message rows with millisecond timestamps and a parent chain", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-codebuddy-"));

    const result = await writeMigratedSession({
      target: "codebuddy",
      session: portable(),
      homeDir,
      now: NOW,
      idFactory: idFactory([SESSION_ID, ...MESSAGE_IDS]),
    });

    expect(result.filePath).toBe(
      path.join(homeDir, ".codebuddy", "projects", "Users----My-Project", `${SESSION_ID}.jsonl`),
    );

    const rows = readRows(result.filePath);
    expect(rows[0]).toEqual({
      timestamp: new Date(portable().startedAt).getTime(),
      type: "ai-title",
      aiTitle: portable().title,
      sessionId: SESSION_ID,
      cwd: portable().projectPath,
    });
    const messages = rows.slice(1);
    expect(messages.map((row) => row.id)).toEqual(MESSAGE_IDS);
    expect(messages.map((row) => row.parentId)).toEqual([undefined, MESSAGE_IDS[0], MESSAGE_IDS[1]]);
    expect(messages.map((row) => row.timestamp)).toEqual(
      portable().messages.map((message) => new Date(message.timestamp).getTime()),
    );
    expect(messages.map((row) => row.content[0].type)).toEqual(["input_text", "output_text", "input_text"]);
    expectRoundTrip("codebuddy", "codebuddy-cli", result.sessionId, result.filePath, rows);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("uses crypto UUIDs by default and keeps all output under the injected home", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-default-id-"));

    const result = await writeMigratedSession({ target: "codex", session: portable(), homeDir, now: NOW });

    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(path.relative(homeDir, result.filePath)).not.toMatch(/^\.\./);
    expect(result.filePath.startsWith(os.homedir())).toBe(false);

    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it.each(TARGETS)("deletes $target output when validation fails", async ({ target, family }) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-validation-${target}-`));
    let temporaryFile = "";
    try {
      await expect(
        writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
          validate: (filePath) => {
            temporaryFile = filePath;
            return null;
          },
        }),
      ).rejects.toThrow(/validation/i);

      expect(temporaryFile).not.toBe("");
      expect(fs.existsSync(temporaryFile)).toBe(false);
      expect(filesUnder(homeDir)).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(TARGETS)("deletes $target output when beforeValidate fails", async ({ target, family }) => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-before-validate-${target}-`));
    try {
      await expect(
        writeMigratedSession({
          target,
          session: portable(),
          homeDir,
          now: NOW,
          idFactory: idFactory(family === "codex" || target === "cursor" ? [SESSION_ID] : [SESSION_ID, ...MESSAGE_IDS]),
          beforeValidate: () => {
            throw new Error("beforeValidate exploded");
          },
        }),
      ).rejects.toThrow("beforeValidate exploded");

      expect(filesUnder(homeDir)).toEqual([]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("deletes the temporary file and leaves no final file when atomic rename fails", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-rename-"));
    let temporaryFile = "";
    let finalFile = "";

    await expect(
      writeMigratedSession({
        target: "codex",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
        rename: (oldPath, newPath) => {
          temporaryFile = oldPath;
          finalFile = newPath;
          throw new Error("rename exploded");
        },
      }),
    ).rejects.toThrow("rename exploded");

    expect(temporaryFile).not.toBe("");
    expect(fs.existsSync(temporaryFile)).toBe(false);
    expect(fs.existsSync(finalFile)).toBe(false);
    expect(filesUnder(homeDir)).toEqual([]);
    fs.rmSync(homeDir, { recursive: true, force: true });
  });


  it("writes native Cursor transcript rows and round-trips them through the existing loader", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-writer-cursor-"));

    try {
      const result = await writeMigratedSession({
        target: "cursor",
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory([SESSION_ID]),
      });

      expect(result.filePath).toBe(
        path.join(
          homeDir,
          ".cursor",
          "projects",
          encodeCursorWorkspaceSlug(portable().projectPath),
          "agent-transcripts",
          SESSION_ID,
          `${SESSION_ID}.jsonl`,
        ),
      );

      const rows = readRows(result.filePath);
      expect(rows[0].message.content[0].text).toContain("<user_query>");
      expect(rows[1].message.content[0].text).toBe("已收到\n第二行");
      expectRoundTrip("cursor", "cursor-agent", result.sessionId, result.filePath, rows);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each(TARGETS)(
    "rejects tampered $target native content before rename and cleans the temporary file",
    async ({ target, family }) => {
      await expectTamperedSessionRejected(target, (rows) => {
        if (family === "codex") rows[0].payload.title = "被篡改的标题";
        else if (family === "claude") rows[2].parentUuid = null;
        else if (family === "cursor") rows[0].role = "system";
        else rows[1].timestamp += 1;
      });
    },
  );

  it("rejects a tampered Codex model provider before rename", async () => {
    await expectTamperedSessionRejected("codex", (rows) => {
      rows[0].payload.model_provider = "tampered-provider";
    });
  });

  it("rejects a tampered Claude model before rename", async () => {
    await expectTamperedSessionRejected("claude", (rows) => {
      rows[2].message.model = "tampered-model";
    });
  });
});

async function expectTamperedSessionRejected(
  target: MigrationTarget,
  mutate: (rows: Array<Record<string, any>>) => void,
): Promise<void> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), `migration-writer-tamper-${target}-`));
  let temporaryFile = "";

  try {
    await expect(
      writeMigratedSession({
        target,
        session: portable(),
        homeDir,
        now: NOW,
        idFactory: idFactory(target === "codex" || target === "tcodex" || target === "codex-internal" || target === "cursor"
          ? [SESSION_ID]
          : [SESSION_ID, ...MESSAGE_IDS]),
        beforeValidate: (filePath) => {
          temporaryFile = filePath;
          const rows = parseJsonlText(fs.readFileSync(filePath, "utf8")) as Array<Record<string, any>>;
          mutate(rows);
          fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        },
      }),
    ).rejects.toThrow(/validation/i);

    expect(temporaryFile).not.toBe("");
    expect(fs.existsSync(temporaryFile)).toBe(false);
    expect(filesUnder(homeDir)).toEqual([]);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(entryPath));
    else files.push(entryPath);
  }
  return files;
}
