# macOS application packaging

AgentRecall V2 can build a standalone App and guided drag-install DMG from already installed dependencies. This is an offline local release-candidate workflow: it creates a new temporary output directory and never installs, publishes, or changes the source Electron runtime.

From `apps/main-2.0`, run:

```sh
npm run package:rc:macos
```

The command builds the current checkout, stages the installed production dependency closure, and produces `AgentRecall.app`, `AgentRecall.dmg`, and an adjacent `release-candidate.json` report. The dependencies must be actual installed directories inside the package tree, matching its lockfile; linked dependency trees are rejected. Reports and test profiles remain outside the App and DMG.

## Application and data identity

The visible App, Dock, and menu name is `AgentRecall`. The npm package, CLI commands, and Electron internal name remain `agent-recall-v2`. Before settings or PostgreSQL services start, the application pins its default data directory to `appData/agent-recall-v2`; an explicit `AGENT_RECALL_USER_DATA_DIR` still takes precedence. Changing the display name must not select a new database or migrate existing data.

The npm-generated launcher retains the filename `agent-recall-v2.app` and bundle ID `com.agent-recall-v2.launcher`, so refresh and uninstall continue to identify their own wrapper. These are distinct from the standalone App.

The standalone candidate uses `dev.zszz3.agent-recall-v2.local-review`. A production bundle ID, V1/V2 installation coexistence policy, real-keychain acceptance, and native-app update policy require team decisions. The existing npm release/update channel does not distribute or update this DMG.

## Packaging and signing boundary

The pipeline copies the Electron App, stages runtime resources and production dependencies, sets the plist/icon/executable, signs nested code inside-out, signs the outer App, verifies and audits its contents, then creates and verifies the DMG. Runtime staging excludes development dependencies, tests, local evidence, source maps, and native build intermediates while retaining runtime assets and license notices.

Current signatures are ad-hoc, with timestamps disabled. No signing identity, certificate credentials, notarization, or stapling options are accepted. Developer ID, entitlements, hardened-runtime policy, notarization, Gatekeeper acceptance, and release publication remain separate production work. Ad-hoc verification alone does not establish that a downloaded App will pass Gatekeeper.

The DMG displays the App and an `Applications -> /Applications` shortcut with a generated bilingual arrow background. Hidden Finder metadata defines the fixed icon layout. Native `hdiutil` stores the root auto-open folder; packaging never scripts Finder windows or changes global Finder preferences.

A private writable-image pass fills the existing layout with image-owned catalog identifiers, then removes only makehybrid-added FinderInfo attributes from the copied App without following symlinks or re-signing it. No files are added during that pass. The App signature is checked there and again from the final read-only image. Verification always ejects its owned mounts; if mount state or cleanup cannot be established, the backing image is retained for recovery.

## Isolated native verification

```sh
node scripts/smoke-local-macos.mjs <generated-appPath>
node scripts/verify-macos-upgrade.mjs <previous-generated-appPath> <candidate-appPath>
```

Both commands accept generated temporary bundles only. They use synthetic HOME/application-data paths, a kernel sandbox denying access to the real home tree, loopback-only networking, a mock keychain, and disabled update checks. Chromium's nested sandbox is disabled only for these test launches because the outer sandbox owns process-tree isolation. Run these commands with the same `TMPDIR` used to package their inputs.

Core smoke verifies application identity, renderer loading, a running PostgreSQL server in the owned temporary data directory, successful core IPC requests, settled automation/initial indexing, graceful quit, and server shutdown. It tests quitting a ready application, not interrupting startup. The unsupported `--ui-quality` option is rejected before bundle access or application launch; UI layout requires manual acceptance.

Both probes remove the previous result when a validated run starts and publish a new PASS only after verification and cleanup finish. Surviving application helpers fail the run even if failure recovery subsequently terminates them; forced cleanup is not evidence of a successful ordinary quit.

The upgrade probe protects the transition from the previous `agent-recall-v2` visible name to `AgentRecall`. It copies the previous App into a synthetic Applications-like directory, seeds a database/settings marker, replaces only that copy with the candidate, and reopens it twice. The check asserts that the default data path and markers survive, no duplicate `AgentRecall` data directory appears, and PostgreSQL stops after each run. It does not test arbitrary future release transitions, real credentials, quarantine, or the production updater.

For focused packaging regressions, run `node --test scripts/package-release-macos.test.mjs scripts/macos-runtime-dependencies.test.mjs scripts/macos-release-audit.test.mjs scripts/macos-dmg.test.mjs scripts/macos-finder-layout.test.mjs`. Native image tests require macOS and Command Line Tools and use synthetic signed fixtures only.

Finder double-click, Dock appearance, menu appearance, Quit/reopen, and DMG presentation still require explicit manual acceptance in an isolated profile. Never use a real user profile or drag an unapproved candidate into the real Applications directory during unattended validation.
