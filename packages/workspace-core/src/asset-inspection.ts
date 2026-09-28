import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { skillFromFiles, type AssetSnapshot, type AssetChange } from "./asset-format.js";
import type { ConfigurationPreview } from "./configuration-format.js";

/** Read-only comparison against a pulled snapshot; publication still validates Git paths and the remote revision. */
export function inspectAssetChange(snapshot: AssetSnapshot, change: Exclude<AssetChange, { kind: "batch" }>): NonNullable<ConfigurationPreview["items"]>[number] {
  const files: ConfigurationPreview["files"] = [];
  let exists = false;
  const describe = (content: string) => {
    const bytes = Buffer.from(content, "base64");
    try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (!text.includes("\0")) return text; }
    catch { /* Binary content is represented by size and digest, never decoded lossily. */ }
    return `[Binary file · ${bytes.length} bytes · SHA-256 ${createHash("sha256").update(bytes).digest("hex")}]`;
  };
  if (change.kind === "skills") {
    const next = skillFromFiles(change.value.id, change.value.files), previous = snapshot.skills.find(item => item.id === next.id);
    exists = Boolean(previous);
    const before = new Map(previous?.files.map(file => [file.path, file])), after = new Map(next.files.map(file => [file.path, file]));
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(path), value = after.get(path);
      if (old?.content === value?.content && old?.executable === value?.executable) continue;
      files.push({ path, before: old ? describe(old.content) : null, after: value ? describe(value.content) : null, previousExecutable: old?.executable, executable: value?.executable });
    }
  } else if (change.kind === "documents" || change.kind === "instructions") {
    const previous = change.kind === "documents" ? ("documents" in snapshot ? snapshot.documents.find(item => item.id === change.value.id) : undefined)
      : snapshot.schemaVersion === 4 ? snapshot.instructions.find(item => item.id === change.value.id) : undefined;
    exists = Boolean(previous);
    if (previous?.content !== change.value.content) files.push({ path: previous?.path ?? `${change.kind === "documents" ? "docs" : "rules"}/${change.value.id}.md`, before: previous?.content ?? null, after: change.value.content });
    const { content: _content, ...nextMetadata } = change.value;
    const metadata = previous ? Object.fromEntries(Object.keys(nextMetadata).map(key => [key, Reflect.get(previous, key)])) : null;
    if (previous && !isDeepStrictEqual(metadata, nextMetadata)) files.push({ path: "agentrecall.json", before: JSON.stringify(metadata, null, 2), after: JSON.stringify(nextMetadata, null, 2) });
  } else {
    const previous = snapshot.schemaVersion !== 4 ? undefined : change.kind === "mcp" ? snapshot.mcpServers.find(item => item.id === change.value.id) : snapshot.environment.find(item => item.name === change.value.name);
    exists = Boolean(previous);
    if (!isDeepStrictEqual(previous, change.value)) files.push({ path: "agentrecall.json", before: previous ? JSON.stringify(previous, null, 2) : null, after: JSON.stringify(change.value, null, 2) });
  }
  return { key: `${change.kind}:${change.kind === "environment" ? change.value.name : change.value.id}`, name: change.value.name, status: !exists ? "added" : files.length ? "modified" : "unchanged", files };
}
