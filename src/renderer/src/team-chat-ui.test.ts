import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const mainSource = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
const pageUrl = new URL("./features/team-chat/team-chat-page.tsx", import.meta.url);
const styleUrl = new URL("./styles/team-chat.css", import.meta.url);
const pageSource = existsSync(pageUrl) ? readFileSync(pageUrl, "utf8") : "";
const styleSource = existsSync(styleUrl) ? readFileSync(styleUrl, "utf8") : "";

describe("Team Chat page", () => {
  it("is a first-class primary tab mounted from the application shell", () => {
    expect(appSource).toContain("MessageCircleMore");
    expect(appSource).toContain('<button data-page="team-chat"');
    expect(appSource).toContain('<MessageCircleMore size={18} /><span>Chat</span>');
    expect(appSource).toContain('activePage === "team-chat" ? <TeamChatPage language={language} /> : null');
  });

  it("uses the automatically managed local database and releases its event listener", () => {
    expect(pageSource).toContain("export function TeamChatPage");
    expect(pageSource).toContain("window.sessionSearch.teamChat");
    expect(pageSource).toContain("getConnectionStatus()");
    expect(pageSource).toContain("api.connect()");
    expect(pageSource).toContain("const unsubscribe = api.onEvent");
    expect(pageSource).toContain("unsubscribe();");
    expect(pageSource).toContain('l("Local data", "本地数据")');
    expect(pageSource).toContain("No database setup is required.");
    expect(pageSource).not.toContain("External PostgreSQL");
    expect(pageSource).not.toContain('type="password"');
  });

  it("supports room creation from configured Agents and a chosen work directory", () => {
    expect(pageSource).toContain("snapshot.configuredAgents");
    expect(pageSource).toContain('type="checkbox"');
    expect(pageSource).toContain("api.createRoom");
    expect(pageSource).toContain("automationApi.pickDirectory");
    expect(pageSource).toContain("api.archiveRoom");
  });

  it("captures checkbox state before React runs the deferred member-selection update", () => {
    expect(pageSource).toContain("const checked = event.currentTarget.checked");
    expect(pageSource).not.toMatch(/setAgentIds\(\(current\) => event\.currentTarget\.checked/);
  });

  it("paginates messages, reconciles stream events, and provides send and stop controls", () => {
    expect(pageSource).toContain("api.listMessages");
    expect(pageSource).toContain("nextBefore");
    expect(pageSource).toContain('event.type === "dispatch-delta"');
    expect(pageSource).toContain("api.sendMessage");
    expect(pageSource).toContain("api.stopTurn");
    expect(pageSource).toContain("event.shiftKey");
    expect(pageSource).toContain("@${member.displayName}");
    expect(pageSource).toContain('role="listbox"');
    expect(pageSource).toContain("mentionCandidates");
    expect(pageSource).toContain("onMentionKeyDown");
    expect(pageSource).toContain("member.runtimeId");
  });

  it("routes Markdown links through the existing safe external-link boundary", () => {
    expect(pageSource).toContain("window.sessionSearch.openExternalLink");
    expect(pageSource).toContain("event.preventDefault()");
    expect(pageSource).toContain("components={{ a: TeamChatExternalLink }}");
  });

  it("keeps history pagination in place and clears stale turn controls when rooms change", () => {
    expect(pageSource).toContain("const skipNextAutoScrollRef = useRef(false)");
    expect(pageSource).toContain("skipNextAutoScrollRef.current = true");
    expect(pageSource).toContain("if (skipNextAutoScrollRef.current)");
    expect(pageSource).toContain("setActiveRootMessageId(undefined)");
  });

  it("shows safe per-Agent continuity state and can start a new conversation", () => {
    expect(pageSource).toContain("member.continuationAvailable");
    expect(pageSource).toContain("member.hasActiveConversation");
    expect(pageSource).toContain("api.resetAgentSession");
    expect(pageSource).toContain('event.type === "agent-session-changed"');
    expect(pageSource).toContain('l("Persistent context", "持续会话")');
    expect(pageSource).toContain('l("Start new conversation", "开始新会话")');
    expect(pageSource).not.toContain("runtimeConversation");
    expect(styleSource).toContain(".team-chat-member-row");
    expect(styleSource).toContain(".team-chat-member-reset");
  });

  it("uses a compact responsive three-pane layout", () => {
    expect(mainSource).toContain('import "./styles/team-chat.css";');
    expect(styleSource).toMatch(/\.team-chat-layout\s*\{[^}]*grid-template-columns:\s*208px\s+minmax\(0,\s*1fr\)\s+184px/);
    expect(styleSource).toContain("@media (max-width: 980px)");
    expect(styleSource).toContain("@media (max-width: 720px)");
    expect(styleSource).toMatch(/\.team-chat-transcript\s*\{[^}]*overflow-y:\s*auto/);
  });
});
