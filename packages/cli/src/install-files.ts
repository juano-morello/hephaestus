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
 * registered with this command and args, a re-add when they differ, a manual command to print
 * when `claude` is not installed or refuses, and a message (no add) when heph is registered in
 * another scope, where a user-scope copy would only be shadowed. Never throws.
 *
 * Reads `claude mcp get heph`'s human output, whose format `claude mcp --help` does not state:
 * lines like `Scope: User config (...)`, `Command: /path/heph`, `Args: mcp`. An Args line that
 * is absent is not compared, and a Scope line that is absent counts as user scope; if Claude
 * Code changes the format, the worst case is a needless re-add, never a failed install.
 */
export function registerClaudeMcp(run: Runner, heph: string): { done: boolean; message: string } {
  const manual = claudeMcpAddCommand(heph).join(" ");
  const got = run(["claude", "mcp", "get", "heph"]);
  if (!got)
    return { done: false, message: `claude is not on PATH; register heph's tools with: ${manual}` };
  if (got.exitCode === 0) {
    const field = (name: string) =>
      got.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith(`${name}:`))
        ?.slice(name.length + 1)
        .trim();
    const scope = field("Scope");
    const scopeName = scope?.split(" ")[0]?.toLowerCase();
    if (scopeName && scopeName !== "user")
      return {
        done: false,
        message: `heph's MCP server is registered in Claude Code's ${scopeName} scope (${scope}), which wins over a user-scope one, so it was left as is; to use this heph everywhere, remove that one (claude mcp remove --scope ${scopeName} heph) and run: ${manual}`,
      };
    const args = field("Args");
    const same = field("Command") === heph && (args === undefined || args === "mcp");
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

/** How far a line opens (+) or closes (-) brackets, outside strings and comments. */
type Multi = '"""' | "'''" | undefined;

/**
 * Scans one line of TOML from inside (`str`) or outside a multi-line string: the net change in
 * bracket depth outside strings and comments, and whether a multi-line string is open at the end.
 * Opening and closing a `"""` or `'''` string on one line leaves nothing open.
 */
function scanLine(line: string, str: Multi): { depth: number; str: Multi } {
  let d = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === "\\" && str === '"""') i++;
      else if (line.startsWith(str, i)) {
        // Up to two more quotes belong to the string's end (`"""x""""` is `x"`).
        i += 2;
        for (let extra = 0; extra < 2 && line[i + 1] === str[0]; extra++) i++;
        str = undefined;
      }
    } else if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) {
        str = c === '"' ? '"""' : "'''";
        i += 2;
      } else quote = c;
    } else if (c === "#") break;
    else if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return { depth: d, str };
}

/**
 * Codex's config.toml with a `[mcp_servers.heph]` table running `heph mcp`: any existing heph
 * definition (its table and sub-tables, an inline `heph = {...}` or dotted `heph.x = ...` keys
 * under `[mcp_servers]`, or `mcp_servers.heph.x = ...` at the root) is replaced, everything else
 * kept as it was, CRLF line endings included. `tool_timeout_sec` lifts Codex's 60 s tool
 * default above heph_watch's long poll (at most about 40 s).
 */
export function withHephMcp(toml: string | undefined, heph: string): string {
  const eol = toml?.includes("\r\n") ? "\r\n" : "\n";
  const table = [
    "[mcp_servers.heph]",
    `command = ${tomlString(heph)}`,
    'args = ["mcp"]',
    "tool_timeout_sec = 120",
    "",
  ].join(eol);
  const kept: string[] = [];
  let section = ""; // the table a line is in ("" for the root)
  let skippingTable = false;
  let depth = 0; // > 0 inside a multi-line value
  let skippingValue = false;
  let str: Multi; // inside a multi-line string: its lines are values, never headers or keys
  for (const line of (toml ?? "").split(/\r?\n/)) {
    const inside = depth > 0 || str !== undefined;
    const scanned = scanLine(line, str);
    str = scanned.str;
    if (inside) {
      depth += scanned.depth;
      if (!(skippingTable || skippingValue)) kept.push(line);
      if (depth <= 0 && !str) skippingValue = false;
      continue;
    }
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      section = (header[1] ?? "").replace(/\s+/g, "");
      skippingTable = /^mcp_servers\."?heph"?(\.|$)/.test(section);
      if (!skippingTable) kept.push(line);
      continue;
    }
    depth = Math.max(0, scanned.depth);
    const key = line.replace(/\s+/g, "");
    skippingValue =
      (section === "mcp_servers" && /^"?heph"?[.=]/.test(key)) ||
      (section === "" && /^mcp_servers\."?heph"?[.=]/.test(key));
    if (!(skippingTable || skippingValue)) kept.push(line);
    if (depth === 0 && !str) skippingValue = false;
  }
  const rest = kept.join(eol).replace(/\s+$/, "");
  return rest === "" ? table : `${rest}${eol}${eol}${table}`;
}
