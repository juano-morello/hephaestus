// What the installer writes (packages/cli/scripts/install.ts): kept apart so tests check the
// files without installing anything.

/** The Claude Code permission rule that keeps an agent from approving its own work. */
export const APPROVE_DENY = "Bash(heph approve:*)";

export const LAUNCHD_LABEL = "dev.hephaestus.daemon";

export type Peer = { id: string; ssh: string; preferred?: boolean };

/** A stable node id from a host name: "Juanos-MacBook-Pro.local" -> "juanos-macbook-pro". */
export const nodeIdFrom = (host: string) =>
  host
    .replace(/\.local$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-");

/** `~/.heph/config.yaml` for a new node. */
export function homeConfigYaml(o: { nodeId: string; peers?: Peer[] }): string {
  const lines = [
    "# Written by the heph installer. Edit freely; heph doctor checks it.",
    `node: { id: ${o.nodeId} }`,
    "# Native: commands run on this machine's toolchains, confined (no network, no writes",
    "# outside the project and temp, credentials unreadable). Container mode needs an image",
    "# with each project's toolchain and its dependencies.",
    "sandbox: { mode: native }",
  ];
  if (o.peers?.length) {
    lines.push("nodes:");
    for (const p of o.peers)
      lines.push(
        `  ${p.id}: { ssh: ${p.ssh}, heph: ~/.local/bin/heph${p.preferred ? ", preferred: true" : ""} }`,
      );
  }
  return `${lines.join("\n")}\n`;
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A launchd agent: the daemon starts at login and is restarted if it exits. */
export function launchdPlist(o: { heph: string; path: string; log: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.heph)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/** A systemd user unit; with lingering on, it runs without a login session. */
export function systemdUnit(o: { heph: string; path: string }): string {
  return `[Unit]
Description=Hephaestus node daemon
After=network-online.target

[Service]
ExecStart=${o.heph} daemon
Environment="PATH=${o.path}"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

type Settings = {
  permissions?: { deny?: string[]; [k: string]: unknown };
  sandbox?: { excludedCommands?: string[]; [k: string]: unknown };
  [k: string]: unknown;
};

/**
 * Claude Code settings with heph run outside its Bash sandbox: heph writes its ledger in
 * ~/.heph and talks to the daemon's socket, which the sandbox refuses ("attempt to write a
 * readonly database"). heph confines its own commands; approvals stay denied.
 */
export function withHephUnsandboxed(settings: Settings | undefined): Settings {
  const s = settings ?? {};
  const excluded = s.sandbox?.excludedCommands ?? [];
  if (excluded.includes("heph")) return s;
  return { ...s, sandbox: { ...s.sandbox, excludedCommands: [...excluded, "heph"] } };
}

/** Claude Code settings with `heph approve` denied; everything else kept as it was. */
export function withApproveDenied(settings: Settings | undefined): Settings {
  const s = settings ?? {};
  const deny = s.permissions?.deny ?? [];
  if (deny.includes(APPROVE_DENY)) return s;
  return { ...s, permissions: { ...s.permissions, deny: [...deny, APPROVE_DENY] } };
}

/** Runs a command; undefined when it can't be started (not installed). */
export type Runner = (cmd: string[]) => { exitCode: number; stdout: string } | undefined;

/** The manual command that registers heph's MCP server with Claude Code. */
export const claudeMcpAddCommand = (heph: string) => [
  "claude",
  "mcp",
  "add",
  "--scope",
  "user",
  "heph",
  "--",
  heph,
  "mcp",
];

/**
 * Registers `heph mcp` with Claude Code through its CLI, once: nothing when it is already
 * registered with this command, a re-add when it differs, a manual command to print when
 * `claude` is not installed or refuses. Never throws.
 */
export function registerClaudeMcp(run: Runner, heph: string): { done: boolean; message: string } {
  const manual = claudeMcpAddCommand(heph).join(" ");
  const got = run(["claude", "mcp", "get", "heph"]);
  if (!got)
    return { done: false, message: `claude is not on PATH; register heph's tools with: ${manual}` };
  if (got.exitCode === 0) {
    const same = got.stdout.split("\n").some((l) => l.trim() === `Command: ${heph}`);
    if (same)
      return { done: true, message: "heph's MCP server already registered with Claude Code" };
    run(["claude", "mcp", "remove", "--scope", "user", "heph"]);
    const r = run(claudeMcpAddCommand(heph));
    return r?.exitCode === 0
      ? {
          done: true,
          message: "re-registered heph's MCP server with Claude Code (its command differed)",
        }
      : {
          done: false,
          message: `could not update heph's MCP server in Claude Code; run: ${manual}`,
        };
  }
  const r = run(claudeMcpAddCommand(heph));
  return r?.exitCode === 0
    ? { done: true, message: "registered heph's MCP server with Claude Code" }
    : {
        done: false,
        message: `could not register heph's MCP server with Claude Code; run: ${manual}`,
      };
}

const tomlString = (s: string) => JSON.stringify(s);

/**
 * Codex's config.toml with a `[mcp_servers.heph]` table running `heph mcp`: any existing heph
 * table (and its sub-tables) is replaced, everything else kept as it was.
 */
export function withHephMcp(toml: string | undefined, heph: string): string {
  const table = `[mcp_servers.heph]\ncommand = ${tomlString(heph)}\nargs = ["mcp"]\n`;
  const lines = (toml ?? "").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) skipping = /^mcp_servers\s*\.\s*"?heph"?(\s*\.|$)/.test(header[1] ?? "");
    if (!skipping) kept.push(line);
  }
  const rest = kept.join("\n").replace(/\s+$/, "");
  return rest === "" ? table : `${rest}\n\n${table}`;
}
