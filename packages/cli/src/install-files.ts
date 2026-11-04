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

type Settings = { permissions?: { deny?: string[]; [k: string]: unknown }; [k: string]: unknown };

/** Claude Code settings with `heph approve` denied; everything else kept as it was. */
export function withApproveDenied(settings: Settings | undefined): Settings {
  const s = settings ?? {};
  const deny = s.permissions?.deny ?? [];
  if (deny.includes(APPROVE_DENY)) return s;
  return { ...s, permissions: { ...s.permissions, deny: [...deny, APPROVE_DENY] } };
}
