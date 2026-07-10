import { describe, expect, it } from "vitest";
import { buildSshArgs, normalizeManualSshInput, parseSshConfigHosts } from "./ssh-config";

describe("ssh config helpers", () => {
  it("extracts concrete hosts and ignores wildcard patterns", () => {
    const config = `
Host *
  ServerAliveInterval 60

Host devbox
  HostName devbox.example.com
  User alice
  Port 2222
  IdentityFile ~/.ssh/devbox

Host *.internal
  User ignored

Host review git.example.com
  HostName git.example.com
`;

    expect(parseSshConfigHosts(config)).toEqual([
      {
        alias: "devbox",
        hostName: "devbox.example.com",
        user: "alice",
        port: 2222,
        identityFile: "~/.ssh/devbox",
      },
      { alias: "review", hostName: "git.example.com", user: null, port: null, identityFile: null },
      { alias: "git.example.com", hostName: "git.example.com", user: null, port: null, identityFile: null },
    ]);
  });

  it("deduplicates repeated concrete aliases from ssh config", () => {
    const config = `
Host dev dev
  HostName dev.example.com

Host dev
  HostName later.example.com

Host review dev
  HostName review.example.com
`;

    expect(parseSshConfigHosts(config).map((host) => host.alias)).toEqual(["dev", "review"]);
  });

  it("normalizes manual host input", () => {
    expect(
      normalizeManualSshInput({
        label: "",
        host: "bob@example.com",
        port: "2222",
        authMode: "identityFile",
        identityFile: "~/.ssh/id_ed25519",
      }),
    ).toEqual({
      label: "example.com",
      host: "example.com",
      user: "bob",
      port: 2222,
      authMode: "identityFile",
      identityFile: "~/.ssh/id_ed25519",
    });
  });

  it("normalizes manual host input using the last at-sign as the delimiter", () => {
    expect(
      normalizeManualSshInput({
        label: "",
        host: "alice@example.com@bastion",
        port: "",
        authMode: "none",
        identityFile: "",
      }),
    ).toEqual({
      label: "bastion",
      host: "bastion",
      user: "alice@example.com",
      port: null,
      authMode: "none",
      identityFile: null,
    });
  });

  it("builds alias and manual ssh argv without shell joining", () => {
    expect(
      buildSshArgs({ hostAlias: "devbox", host: null, user: null, port: null, authMode: "none", identityFile: null }, "echo ok"),
    ).toEqual(["--", "devbox", "echo ok"]);
    expect(
      buildSshArgs(
        { hostAlias: null, host: "example.com", user: "bob", port: 2222, authMode: "identityFile", identityFile: "~/.ssh/key" },
        "echo ok",
      ),
    ).toEqual(["-i", "~/.ssh/key", "-p", "2222", "--", "bob@example.com", "echo ok"]);
  });

  it("places destinations beginning with dashes after the ssh option terminator", () => {
    expect(
      buildSshArgs({ hostAlias: "-oProxyCommand=bad", host: null, user: null, port: null, authMode: "none", identityFile: null }, "echo ok"),
    ).toEqual(["--", "-oProxyCommand=bad", "echo ok"]);
  });

  it("preserves hash characters in config values while stripping comments", () => {
    const config = `
Host hashbox
  HostName hash.example.com # trailing comment
  User bob#ops
  IdentityFile "/tmp/key#prod"
`;

    expect(parseSshConfigHosts(config)).toEqual([
      {
        alias: "hashbox",
        hostName: "hash.example.com",
        user: "bob#ops",
        port: null,
        identityFile: "/tmp/key#prod",
      },
    ]);
  });

  it("keeps Match stanza options isolated from preceding Host blocks", () => {
    const config = `
Host clean
  User before
  IdentityFile /tmp/before
Match host other
  User after
  IdentityFile /tmp/after
Host next
  User next-user
`;

    expect(parseSshConfigHosts(config)).toEqual([
      { alias: "clean", hostName: null, user: "before", port: null, identityFile: "/tmp/before" },
      { alias: "next", hostName: null, user: "next-user", port: null, identityFile: null },
    ]);
  });

  it("parses ssh config key=value syntax", () => {
    const config = `
Host=eqbox
HostName=eq.example.com
User=alice
Port=2200
IdentityFile="/tmp/key#eq"
`;

    expect(parseSshConfigHosts(config)).toEqual([
      {
        alias: "eqbox",
        hostName: "eq.example.com",
        user: "alice",
        port: 2200,
        identityFile: "/tmp/key#eq",
      },
    ]);
  });

  it("parses ssh config key = value syntax with optional whitespace", () => {
    const config = `
Host = eqspace
HostName = eqspace.example.com
User = alice
Port = 2200
IdentityFile = "/tmp/key#space"
`;

    expect(parseSshConfigHosts(config)).toEqual([
      {
        alias: "eqspace",
        hostName: "eqspace.example.com",
        user: "alice",
        port: 2200,
        identityFile: "/tmp/key#space",
      },
    ]);
  });

  it("keeps blank manual ports optional", () => {
    expect(
      normalizeManualSshInput({
        label: "example",
        host: "example.com",
        port: " ",
        authMode: "none",
        identityFile: "",
      }),
    ).toEqual({
      label: "example",
      host: "example.com",
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
    });
  });

  it("rejects invalid non-empty manual ports", () => {
    for (const port of ["abc", "1e3", "0x16"]) {
      expect(() =>
        normalizeManualSshInput({
          label: "example",
          host: "example.com",
          port,
          authMode: "none",
          identityFile: "",
        }),
      ).toThrow(/Invalid SSH port/);
    }
  });
});
