import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionAttachment } from "./types";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_SESSION_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export interface MaterializedAttachment extends Omit<SessionAttachment, "source"> {
  cachePath: string | null;
}

export function materializeSessionAttachment(
  attachment: SessionAttachment,
  options: {
    cacheRoot: string | null;
    sessionFilePath: string;
    attachmentId: string;
    remainingSessionBytes: number;
    /** Path sources name files on the machine that wrote the session; only honor them for local sessions. */
    allowPathSources: boolean;
  },
): MaterializedAttachment {
  const unavailable = (
    status: MaterializedAttachment["status"],
    sizeBytes?: number,
  ): MaterializedAttachment => ({
    id: options.attachmentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    previewKind: attachment.previewKind,
    status,
    sizeBytes,
    cachePath: null,
  });
  if (!options.cacheRoot || !attachment.source) return unavailable("missing");

  let bytes: Buffer;
  if (attachment.source.kind === "inline") {
    try {
      bytes = Buffer.from(attachment.source.value, "base64");
    } catch {
      return unavailable("missing");
    }
  } else {
    if (!options.allowPathSources) return unavailable("unsafe");
    const sourcePath = decodeAttachmentPath(attachment.source.value);
    if (!sourcePath || !isTrustedAttachmentPath(sourcePath, options.sessionFilePath)) {
      return unavailable("unsafe");
    }
    try {
      const stat = lstatSync(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return unavailable("unsafe");
      if (stat.size > MAX_ATTACHMENT_BYTES || stat.size > options.remainingSessionBytes) {
        return unavailable("too_large", stat.size);
      }
      bytes = Buffer.alloc(0);
      const cachePath = attachmentCachePath(options.cacheRoot, sourcePath, attachment.fileName);
      mkdirSync(path.dirname(cachePath), { recursive: true });
      if (!existsSync(cachePath)) copyFileSync(sourcePath, cachePath);
      return {
        id: options.attachmentId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        previewKind: attachment.previewKind,
        status: "available",
        sizeBytes: stat.size,
        cachePath,
      };
    } catch {
      return unavailable("missing");
    }
  }

  if (bytes.length > MAX_ATTACHMENT_BYTES || bytes.length > options.remainingSessionBytes) {
    return unavailable("too_large", bytes.length);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const extension = safeExtension(attachment.fileName);
  const cachePath = path.join(options.cacheRoot, `${digest}${extension}`);
  mkdirSync(options.cacheRoot, { recursive: true });
  if (!existsSync(cachePath)) writeFileSync(cachePath, bytes, { mode: 0o600 });
  return {
    id: options.attachmentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    previewKind: attachment.previewKind,
    status: "available",
    sizeBytes: bytes.length,
    cachePath,
  };
}

function decodeAttachmentPath(value: string): string | null {
  try {
    if (value.startsWith("file://")) return path.resolve(decodeURIComponent(new URL(value).pathname));
    if (!path.isAbsolute(value)) return null;
    return realpathSync(value);
  } catch {
    return null;
  }
}

function isTrustedAttachmentPath(candidate: string, sessionFilePath: string): boolean {
  const home = homedir();
  const roots = [
    path.dirname(sessionFilePath),
    path.join(home, ".codex"),
    path.join(home, ".claude"),
    path.join(home, ".cursor"),
    path.join(home, "Library", "Application Support", "Cursor"),
  ];
  return roots.some((root) => isWithin(candidate, root));
}

function isWithin(candidate: string, root: string): boolean {
  let canonicalRoot = path.resolve(root);
  try {
    if (existsSync(root)) canonicalRoot = realpathSync(root);
  } catch {
    // Keep the resolved root when it cannot be canonicalized.
  }
  const relative = path.relative(canonicalRoot, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function attachmentCachePath(cacheRoot: string, sourcePath: string, fileName: string): string {
  const stat = lstatSync(sourcePath);
  const digest = createHash("sha256")
    .update(`${sourcePath}\0${stat.size}\0${stat.mtimeMs}`)
    .digest("hex");
  return path.join(cacheRoot, `${digest}${safeExtension(fileName)}`);
}

// Extensions the OS would run rather than display; never cache or open attachments under them.
const EXECUTABLE_EXTENSIONS = new Set([
  ".app", ".application", ".bat", ".chm", ".cmd", ".com", ".command", ".cpl", ".exe", ".gadget",
  ".hlp", ".hta", ".inf", ".jar", ".js", ".jse", ".lnk", ".msc", ".msi", ".msp", ".pif", ".pkg",
  ".ps1", ".psm1", ".reg", ".scf", ".scpt", ".scr", ".sh", ".terminal", ".tool", ".url", ".vb",
  ".vbe", ".vbs", ".workflow", ".ws", ".wsc", ".wsf", ".wsh",
]);

export function isExecutableAttachmentPath(filePath: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function shouldRevealExecutableAttachment(fileName: string, cachePath: string): boolean {
  return isExecutableAttachmentPath(fileName) || isExecutableAttachmentPath(cachePath);
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(extension)) return "";
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}
