import { parse as parseYaml } from "yaml";

import type { EvaluationStageDefinition } from "./case-graph";
import type { EvaluationStageBoundaryKind } from "./nodes/contracts";

/**
 * The stages a SKILL.md declares for its own evaluation.
 *
 * A skill that walks through fixed phases knows what they are; asking the person
 * creating a suite to retype them gets them wrong in the way that is hardest to
 * notice — a stage that never matches reports itself as not found, which reads
 * like the agent's run going off script.
 *
 * Frontmatter rather than a side file because a run is already attributed to the
 * exact SKILL.md bytes it was injected with, so the stages it was segmented by
 * follow the same version for free. A side file would be a second thing to
 * fingerprint and a second way for the two to drift apart.
 *
 * This is a seed, not a contract that keeps applying: the stages are read once,
 * when a suite is created, and after that the suite's own plan is the only
 * authority. Re-reading the skill on every save would silently undo edits made
 * in the plan editor.
 */

/** The bounds the save path enforces, so a seeded plan can always be saved again. */
const MAX_DECLARED_STAGES = 10;
const MAX_NAME = 120;
const MAX_PATTERN = 200;
const MAX_WILDCARDS = 16;

const BOUNDARY_KINDS: readonly EvaluationStageBoundaryKind[] = [
  "file_written",
  "tool_called",
  "message_contains",
];

const STAGE_KEYS: readonly string[] = ["name", "boundaryKind", "pattern"];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * The declared stages, in the order the skill lists them.
 *
 * Empty when the skill declares none, which is the common case and not an error.
 * Anything the skill *did* declare but got wrong throws instead: a dropped entry
 * would leave the author with a suite that silently segments differently from
 * what they wrote, and nothing downstream would say why.
 */
export function parseDeclaredSkillStages(markdown: string): EvaluationStageDefinition[] {
  const match = markdown.match(FRONTMATTER);
  if (!match) return [];

  let document: unknown;
  try {
    document = parseYaml(match[1]!);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `SKILL.md frontmatter is not valid YAML: ${detail}${aliasHint(detail)}`,
    );
  }

  const declared = asRecord(document)?.["eval-stages"];
  if (declared === undefined || declared === null) return [];
  if (!Array.isArray(declared)) {
    throw new Error("SKILL.md `eval-stages` must be a list of stages.");
  }
  if (declared.length > MAX_DECLARED_STAGES) {
    throw new Error(
      `SKILL.md declares ${declared.length} stages; a plan holds at most ${MAX_DECLARED_STAGES}.`,
    );
  }
  return declared.map((entry, position) => declaredStage(entry, position));
}

/**
 * One declared stage.
 *
 * The id is the position rather than anything derived from the name: it goes into
 * the rubric fingerprint, so it has to survive a rename — renaming a stage is the
 * same measurement with a better label — and it has to change when the order
 * changes, because the order *is* the segmentation.
 */
function declaredStage(entry: unknown, position: number): EvaluationStageDefinition {
  const fields = asRecord(entry);
  if (!fields) throw stageError(position, `must be a mapping with ${quoted(STAGE_KEYS)}`);

  const unknown = Object.keys(fields).filter((key) => !STAGE_KEYS.includes(key));
  if (unknown.length > 0) {
    // Loud rather than ignored: an author who writes a key this does not read
    // expects it to do something, and a suite that silently declares less than
    // the file says is worse than one that refuses to be created.
    throw stageError(position, `has ${quoted(unknown)}, which ${quoted(STAGE_KEYS)} does not include`);
  }

  const name = asString(fields.name);
  if (!name) throw stageError(position, "needs a name");
  if (name.length > MAX_NAME) {
    throw stageError(position, `has a name longer than ${MAX_NAME} characters`);
  }

  const boundaryKind = asBoundaryKind(fields.boundaryKind);
  if (!boundaryKind) {
    throw stageError(
      position,
      `needs a boundaryKind of ${quoted(BOUNDARY_KINDS)}, not ${shown(fields.boundaryKind)}`,
    );
  }

  const pattern = asString(fields.pattern);
  if (!pattern) throw stageError(position, "needs a pattern");
  if (pattern.length > MAX_PATTERN) {
    throw stageError(position, `has a pattern longer than ${MAX_PATTERN} characters`);
  }
  // Only the file kind is compiled to a regular expression, which runs with no
  // timeout and cannot be interrupted mid-match, so only it needs a wildcard cap.
  if (boundaryKind === "file_written" && pattern.split("*").length - 1 > MAX_WILDCARDS) {
    throw stageError(position, `has more than ${MAX_WILDCARDS} wildcards in its pattern`);
  }

  return { id: `stage-${position + 1}`, name, boundaryKind, pattern };
}

function stageError(position: number, reason: string): Error {
  return new Error(`SKILL.md stage ${position + 1} ${reason}.`);
}

/**
 * The one YAML rule a stage pattern runs into without looking wrong.
 *
 * A leading asterisk starts an alias node, so the globs that read most naturally
 * here — one star before an extension, or a double-star prefix — are exactly the
 * ones that need quoting, and "Unresolved alias" is not what an author would
 * connect to the pattern they wrote.
 */
function aliasHint(detail: string): string {
  return detail.includes("alias")
    ? ' A value that starts with "*" must be quoted, because YAML reads a leading "*" as an alias.'
    : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBoundaryKind(value: unknown): EvaluationStageBoundaryKind | null {
  if (typeof value !== "string") return null;
  return (BOUNDARY_KINDS as readonly string[]).includes(value)
    ? (value as EvaluationStageBoundaryKind)
    : null;
}

/** A non-empty scalar, trimmed; anything else counts as missing. */
function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

/** How a value the author wrote reads back in an error. */
function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
