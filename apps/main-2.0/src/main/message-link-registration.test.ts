import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_LINK_SCHEME } from "../core/message-tools";

const mocks = vi.hoisted(() => ({ getPath: vi.fn(), register: vi.fn(() => true), execFile: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: mocks.getPath, setAsDefaultProtocolClient: mocks.register } }));
vi.mock("node:child_process", () => {
  Object.defineProperty(mocks.execFile, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      mocks.execFile(...args, (error: Error | null, stdout: string, stderr: string) =>
        error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { execFile: mocks.execFile };
});
import { registerMessageLinks } from "./message-link-registration";

let root: string;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "message-link-test-"));
  mocks.getPath.mockReturnValue(root); mocks.register.mockReturnValue(true); mocks.execFile.mockReset();
});
afterEach(async () => { Object.defineProperty(process, "platform", originalPlatform); await rm(root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe("native message links", () => {
  it("registers the Windows scheme with argument arrays and reports registration failure", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    await registerMessageLinks();
    expect(mocks.register).toHaveBeenCalledWith(MESSAGE_LINK_SCHEME, process.execPath, expect.any(Array));
    mocks.register.mockReturnValue(false);
    await expect(registerMessageLinks()).rejects.toThrow("Could not register");
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it("builds a macOS Apple Event handler with a version-specific scheme, quoting incoming URLs", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mocks.execFile.mockImplementation((file: string, args: string[], _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      void (async () => {
        if (file.endsWith("osacompile")) {
          const plist = join(args[1], "Contents", "Info.plist");
          await mkdir(join(dirname(plist), "Resources"), { recursive: true });
          await writeFile(plist, '<plist><dict><key>CFBundleIdentifier</key><string>old</string></dict></plist>');
        }
        callback(null, file.endsWith("osascript") ? "0\n" : "", "");
      })().catch((error: Error) => callback(error, "", ""));
    });
    await registerMessageLinks();
    const bundle = join(root, "message-links", "Message Links.app", "Contents");
    const source = await readFile(join(bundle, "Resources", "launcher-source.txt"), "utf8");
    expect(source).toContain("on open location incomingURL");
    expect(source).toContain("quoted form of incomingURL");
    expect(source).toContain(`${MESSAGE_LINK_SCHEME}://message?`);
    const plist = await readFile(join(bundle, "Info.plist"), "utf8");
    expect(plist).toContain("CFBundleURLSchemes");
    expect(plist).toContain(`<string>${MESSAGE_LINK_SCHEME}</string>`);
    await registerMessageLinks();
    expect(mocks.execFile.mock.calls.filter(([command]) => command.endsWith("osacompile"))).toHaveLength(1);
  });
});
