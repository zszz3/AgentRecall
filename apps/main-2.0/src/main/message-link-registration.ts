import { app } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { MESSAGE_LINK_SCHEME } from "../core/message-tools";

const run = promisify(execFile);
const appleString = (value: string): string => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;

/** macOS needs a bundle that receives Apple Events; a shell-only launcher cannot receive URLs. */
export async function registerMessageLinks(): Promise<void> {
  const args = process.defaultApp && process.argv[1] ? [resolve(process.argv[1])] : [];
  if (process.platform !== "darwin") {
    if (!app.setAsDefaultProtocolClient(MESSAGE_LINK_SCHEME, process.execPath, args)) {
      throw new Error("Could not register message links. Try the installed desktop app.");
    }
    return;
  }
  const root = join(app.getPath("userData"), "message-links");
  const bundle = join(root, "Message Links.app");
  const bundleId = `local.${MESSAGE_LINK_SCHEME}.message-links`;
  const source = `on open location incomingURL
  if incomingURL does not start with ${appleString(`${MESSAGE_LINK_SCHEME}://message?`)} then return
  do shell script ${[process.execPath, ...args].map((part) => `quoted form of ${appleString(part)}`).join(' & " " & ')} & " " & quoted form of incomingURL & " > /dev/null 2>&1 &"
end open location
`;
  await mkdir(root, { recursive: true });
  let installedSource: string | null = null;
  try { installedSource = await readFile(join(bundle, "Contents", "Resources", "launcher-source.txt"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (installedSource !== source) {
    const stage = await mkdtemp(join(root, "build-"));
    try {
      const script = join(stage, "handler.applescript");
      const stagedBundle = join(stage, "Message Links.app");
      await writeFile(script, source, "utf8");
      await run("/usr/bin/osacompile", ["-o", stagedBundle, script], { timeout: 30_000 });
      const plistPath = join(stagedBundle, "Contents", "Info.plist");
      await run("/usr/bin/plutil", ["-convert", "xml1", plistPath], { timeout: 10_000 });
      let plist = await readFile(plistPath, "utf8");
      plist = plist.replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/u, "");
      plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/u,
        `<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Message location</string><key>CFBundleURLSchemes</key><array><string>${MESSAGE_LINK_SCHEME}</string></array></dict></array>
<key>LSUIElement</key><true/></dict></plist>`);
      await writeFile(plistPath, plist, "utf8");
      await writeFile(join(stagedBundle, "Contents", "Resources", "launcher-source.txt"), source, "utf8");
      // Only replace the dedicated generated handler inside this version's userData directory.
      await rm(bundle, { force: true, recursive: true });
      await rename(stagedBundle, bundle);
    } finally { await rm(stage, { force: true, recursive: true }); }
  }
  await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", bundle], { timeout: 10_000 });
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e",
    `ObjC.import('CoreServices'); $.LSSetDefaultHandlerForURLScheme($('${MESSAGE_LINK_SCHEME}'), $('${bundleId}'))`], { timeout: 10_000 });
  if (stdout.trim() !== "0") throw new Error("Could not register the macOS message-link handler.");
}
