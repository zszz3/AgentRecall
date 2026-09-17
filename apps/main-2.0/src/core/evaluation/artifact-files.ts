import type { EvaluationArtifactFile } from "./nodes/contracts";

/**
 * What a run did, read from its trace: which files it touched and which tools it
 * called.
 *
 * A fresh run's artifact is not only its answer: an agent asked to fix a bug
 * produces a diff, and a judge that can only see the final message cannot tell a
 * real fix from a description of one. The session trace is where that becomes
 * observable, because every write went through a tool call.
 *
 * This is deliberately an observation rather than a guarantee. It reads the tool
 * calls it recognises — the file tools by their path argument, and `apply_patch`
 * bodies by their own markers — and says nothing about the rest. A file written
 * by a shell redirect is not reported, and the artifact contract says as much:
 * an absent file list means "not observed", never "nothing was touched". Guessing
 * would be worse than admitting the gap, because a judge that fails a case over
 * an unseen file blames the agent for AgentRecall's blind spot.
 */

/** The part of a trace event this reads; `SessionTraceEvent` satisfies it. */
export interface ArtifactFileTraceEvent {
  kind: string;
  title: string;
  detail?: string;
  attributes?: Record<string, unknown> | undefined;
}

/**
 * Tools that write a whole file, so the path is new as far as the run is
 * concerned. A `Write` over an existing file is reported as `added` too: the
 * trace does not say whether the path existed beforehand, and the alternative
 * would be to invent a before-state.
 */
const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "create_file",
  "createfile",
]);

/** Tools that change part of an existing file. */
const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "notebookedit",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "update_file",
  "apply_diff",
  "patch_file",
]);

const DELETE_TOOLS = new Set(["delete_file", "remove_file", "rm_file"]);

/** Keys the runtimes use for the path a file tool acts on. */
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath", "target_file"];

const MAX_FILES = 500;

/**
 * What one trace event did to files.
 *
 * Empty when the event is not a tool call this recognises, which is the honest
 * answer rather than a guess. One event can touch several paths — an
 * `apply_patch` body names every file in the patch — and when it does the patch
 * wins, because its header lines say what happened to each path, which is more
 * than a path argument would have told us.
 *
 * This is the half a stage boundary needs: "which event first wrote a path
 * matching this glob" is a question about one event, and the folding below
 * cannot answer it.
 */
export function filesTouchedByEvent(
  event: ArtifactFileTraceEvent,
): EvaluationArtifactFile[] {
  if (event.kind !== "tool_call") return [];
  const input = inputOf(event);
  const patched = applyPatchTargets(event, input);
  if (patched.length > 0) return patched;
  const tool = toolNameOf(event.title);
  const status = WRITE_TOOLS.has(tool)
    ? "added" as const
    : EDIT_TOOLS.has(tool)
      ? "modified" as const
      : DELETE_TOOLS.has(tool)
        ? "deleted" as const
        : null;
  if (!status) return [];
  const path = pathOf(input) ?? summaryOf(event.title);
  return path ? [{ path, status }] : [];
}

/**
 * The tool one trace event called, in the lowercase name runtimes report.
 *
 * Null when the event is not a tool call. Read here rather than in the stage
 * segmentation so that "which event first called `apply_patch`" and "which event
 * wrote this path" cannot disagree about what an event was: both go through the
 * same title parsing and the same `tool_call` test.
 */
export function toolCalledByEvent(event: ArtifactFileTraceEvent): string | null {
  if (event.kind !== "tool_call") return null;
  return toolNameOf(event.title) || null;
}

/**
 * Each path's end state, in path order.
 *
 * Folding is what makes the list an artifact rather than a log: a file the run
 * created and then edited is still a file the run produced, and a path deleted
 * at the end is reported as deleted however it got there. Feeding it a prefix of
 * a run's touches therefore yields the state as of that point, which is what a
 * stage's cumulative artifact is.
 */
export function artifactFilesEndState(
  touches: readonly EvaluationArtifactFile[],
): EvaluationArtifactFile[] {
  const byPath = new Map<string, EvaluationArtifactFile["status"]>();
  for (const touch of touches) {
    const trimmed = touch.path.trim();
    // The cap stops admitting new paths, and it drops updates to paths already
    // listed too — so a run over the cap can report a file it deleted last as
    // `added`. Left exactly as it was: the list is an observation with a budget,
    // and quietly changing what stored artifacts say is worse than the wart.
    if (!trimmed || byPath.size >= MAX_FILES) continue;
    const seen = byPath.get(trimmed);
    // An edit after a create still reads as "added": the run produced the file.
    // Anything else takes the later action.
    if (seen === "added" && touch.status === "modified") continue;
    byPath.set(trimmed, touch.status);
  }

  return [...byPath.entries()]
    .map(([path, status]) => ({ path, status }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function artifactFilesFromTrace(
  events: readonly ArtifactFileTraceEvent[],
): EvaluationArtifactFile[] {
  return artifactFilesEndState(events.flatMap(filesTouchedByEvent));
}

/** `"Write · /tmp/a.ts"` → `"write"`. */
function toolNameOf(title: string): string {
  return title.split(" · ")[0]!.trim().toLowerCase();
}

/** The summary a loader appended to the tool name, which for file tools is the path. */
function summaryOf(title: string): string | null {
  const parts = title.split(" · ");
  return parts.length > 1 ? parts.slice(1).join(" · ").trim() || null : null;
}

/**
 * The tool's arguments.
 *
 * Trace details are truncated for display, so this may fail to parse on a large
 * argument. That costs the path for that one call rather than the whole list,
 * which is why the title's summary is kept as a fallback.
 */
function inputOf(event: ArtifactFileTraceEvent): Record<string, unknown> | null {
  const attribute = event.attributes?.input;
  if (attribute && typeof attribute === "object") return attribute as Record<string, unknown>;
  if (typeof attribute === "string") return parseObject(attribute);
  return typeof event.detail === "string" ? parseObject(event.detail) : null;
}

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pathOf(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Files named by an `apply_patch` body.
 *
 * Codex writes through a shell call whose argument is a patch, so the file tools
 * above never see it. The patch's own header lines say what happened to each
 * path, which is more than a path argument would have told us.
 */
const PATCH_MARKERS: Array<[RegExp, EvaluationArtifactFile["status"]]> = [
  [/^\*\*\*\s*Add File:\s*(.+)$/i, "added"],
  [/^\*\*\*\s*Update File:\s*(.+)$/i, "modified"],
  [/^\*\*\*\s*Delete File:\s*(.+)$/i, "deleted"],
];

function applyPatchTargets(
  event: ArtifactFileTraceEvent,
  input: Record<string, unknown> | null,
): EvaluationArtifactFile[] {
  const body = [
    typeof input?.command === "string" ? input.command : "",
    Array.isArray(input?.command) ? input.command.join("\n") : "",
    typeof input?.input === "string" ? input.input : "",
    typeof input?.patch === "string" ? input.patch : "",
    event.detail ?? "",
  ].join("\n");
  if (!body.includes("*** ")) return [];
  const files: EvaluationArtifactFile[] = [];
  for (const line of body.split("\n")) {
    for (const [pattern, status] of PATCH_MARKERS) {
      const match = pattern.exec(line.trim());
      if (match) files.push({ path: match[1]!.trim(), status });
    }
  }
  return files;
}
