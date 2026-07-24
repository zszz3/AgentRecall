import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  captureTurn,
  commitSession,
  findWorkspaceForCwd,
  recallForWorkspace,
} = require("./openviking-memory-hook.cjs");

export function createAgentRecallOpenVikingPlugin(manifestPath, dependencies = {}) {
  return async function agentRecallOpenVikingPlugin(context) {
    const sessions = new Map();
    const messages = new Map();
    const directory = context?.directory || context?.worktree || process.cwd();

    async function activeScope() {
      const manifest = readManifest(manifestPath);
      if (!manifest || manifest.version !== 1 || !manifest.baseUrl || manifest.integrations?.opencode !== true) return null;
      let canonicalDirectory;
      try {
        canonicalDirectory = (dependencies.realpathSync || fs.realpathSync.native)(directory);
      } catch {
        return null;
      }
      const workspace = findWorkspaceForCwd(manifest, canonicalDirectory, dependencies.platform || process.platform);
      return workspace ? { manifest, workspace } : null;
    }

    async function capture(sessionID) {
      const scope = await activeScope();
      const session = sessions.get(sessionID);
      if (!scope || !session?.user || !session?.assistant) return;
      await captureTurn(scope.workspace, sessionKey(scope.workspace.id, sessionID), session, {
        baseUrl: scope.manifest.baseUrl,
        fetchImpl: dependencies.fetchImpl,
        timeoutMs: dependencies.timeoutMs,
        stateDir: scope.manifest.stateDir,
      });
    }

    async function commit(sessionID) {
      const scope = await activeScope();
      if (!scope || !sessionID) return;
      await commitSession(scope.workspace, sessionKey(scope.workspace.id, sessionID), {
        baseUrl: scope.manifest.baseUrl,
        fetchImpl: dependencies.fetchImpl,
        timeoutMs: dependencies.timeoutMs,
      });
    }

    return {
      "chat.message": async (input, output) => {
        const scope = await activeScope();
        if (!scope) return;
        const prompt = textFromParts(output?.parts);
        if (!prompt) return;
        const sessionID = input?.sessionID || input?.sessionId || input?.session?.id;
        if (sessionID) sessions.set(sessionID, { ...(sessions.get(sessionID) || {}), user: stripInjectedContext(prompt) });
        const recalled = await recallForWorkspace(scope.workspace, prompt, {
          baseUrl: scope.manifest.baseUrl,
          fetchImpl: dependencies.fetchImpl,
          timeoutMs: dependencies.timeoutMs,
        });
        if (recalled && Array.isArray(output?.parts)) output.parts.unshift({ type: "text", text: recalled, synthetic: true });
      },

      event: async ({ event }) => {
        try {
          const type = event?.type;
          const properties = event?.properties || {};
          if (type === "message.updated") {
            const info = properties.info || properties.message || {};
            const messageID = info.id || info.messageID;
            const sessionID = info.sessionID || info.sessionId;
            if (messageID && sessionID) messages.set(messageID, { sessionID, role: info.role });
            return;
          }
          if (type === "message.part.updated") {
            const part = properties.part || {};
            const message = messages.get(part.messageID) || {};
            const sessionID = part.sessionID || part.sessionId || message.sessionID;
            if (!sessionID || part.type !== "text" || typeof part.text !== "string") return;
            const role = part.role || message.role;
            if (role === "user" || role === "assistant") {
              const session = sessions.get(sessionID) || {};
              session[role] = stripInjectedContext(part.text);
              sessions.set(sessionID, session);
            }
            return;
          }

          const sessionID = properties.sessionID || properties.sessionId || properties.info?.id || properties.session?.id;
          if (type === "session.idle") await capture(sessionID);
          if (type === "session.compacted" || type === "session.deleted" || type === "session.error") {
            await capture(sessionID);
            await commit(sessionID);
            if (type === "session.deleted") sessions.delete(sessionID);
          }
        } catch {
          // OpenCode work must continue when local memory is unavailable.
        }
      },

      "experimental.session.compacting": async (input) => {
        try {
          const sessionID = input?.sessionID || input?.sessionId || input?.session?.id;
          await capture(sessionID);
          await commit(sessionID);
        } catch {
          // Compaction remains fail-open.
        }
      },

      dispose: async () => {
        for (const sessionID of sessions.keys()) {
          try {
            await capture(sessionID);
            await commit(sessionID);
          } catch {
            // OpenCode shutdown remains fail-open.
          }
        }
      },
    };
  };
}

function readManifest(manifestPath) {
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string" && part.synthetic !== true)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function stripInjectedContext(value) {
  return String(value || "")
    .replace(/<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi, "")
    .trim()
    .slice(0, 12_000);
}

function sessionKey(workspaceId, sessionID) {
  return `opencode-${workspaceId}-${sessionID}`;
}
