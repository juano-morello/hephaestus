#!/usr/bin/env bun
// Installs heph on this machine, or on another one over SSH: builds the binary, puts it in
// ~/.local/share/heph with a ~/.local/bin/heph link, writes ~/.heph/config.yaml if there is
// none, runs the daemon as a service (launchd on macOS, systemd --user on Linux), installs the
// Claude Code skill and its deny rule (this machine only), then runs heph doctor. Run it again
// after pulling changes: it replaces the binary and restarts the daemon (running builds resume).
//
//   bun run install:heph                                  this machine
//   bun run install:heph -- --peer denver --preferred denver
//   bun run install:heph -- --remote denver               another machine, over ssh
//
// Options: --node-id <id> (default: from the host name, or the ssh host), --peer <ssh host>
// (repeatable; adds it under nodes:), --preferred <peer>, --no-service, --no-claude.
// --peer and --preferred apply only when the config is written (it is never overwritten).
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  homeConfigYaml,
  LAUNCHD_LABEL,
  launchdPlist,
  nodeIdFrom,
  type Runner,
  registerClaudeMcp,
  systemdUnit,
  withApproveDenied,
  withHephMcp,
  withHephUnsandboxed,
} from "../src/install-files.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const MAIN = join(REPO, "packages", "cli", "src", "main.ts");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    remote: { type: "string" },
    "node-id": { type: "string" },
    peer: { type: "string", multiple: true, default: [] },
    preferred: { type: "string" },
    "no-service": { type: "boolean", default: false },
    "no-claude": { type: "boolean", default: false },
  },
});

const say = (s: string) => console.log(`heph install: ${s}`);

function sh(cmd: string[], o: { cwd?: string; stdin?: string; quiet?: boolean } = {}): string {
  const r = Bun.spawnSync(cmd, {
    cwd: o.cwd ?? REPO,
    stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(" ")} exited ${r.exitCode}: ${r.stderr.toString().trim()}`);
  return out;
}

/** Runs a shell script on the remote host as you; stdin optional. */
const ssh = (host: string, script: string, stdin?: string) =>
  sh(["ssh", "-o", "BatchMode=yes", host, script], stdin === undefined ? {} : { stdin });

/** Builds heph for a Bun target into a fresh directory; Linux gets OMP's native addon too. */
function build(target: string, platform: string): string {
  const out = join(REPO, "dist", "install", platform);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const commit = sh(["git", "describe", "--always", "--dirty"]).trim();
  say(`building ${platform} from ${commit}`);
  sh([
    "bun",
    "build",
    "--compile",
    `--target=${target}`,
    MAIN,
    "--outfile",
    join(out, "heph"),
    "--external",
    "omp-legacy-pi-modules",
    "--define",
    `HEPH_BUILD=${JSON.stringify(commit)}`,
  ]);
  if (platform.startsWith("linux"))
    sh(["bun", join(REPO, "packages", "cli", "scripts", "fetch-natives.ts"), platform, out]);
  return out;
}

async function installHere() {
  const home = homedir();
  const platform = `${process.platform}-${process.arch}`;
  const out = build(`bun-${platform}`, platform);

  // The binary (and addons) replace the old ones by rename: a running daemon keeps its copy.
  const share = join(home, ".local", "share", "heph");
  mkdirSync(share, { recursive: true });
  for (const f of readdirSync(out)) {
    copyFileSync(join(out, f), join(share, `${f}.new`));
    renameSync(join(share, `${f}.new`), join(share, f));
  }
  chmodSync(join(share, "heph"), 0o755);
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const heph = join(bin, "heph");
  rmSync(heph, { force: true });
  symlinkSync(join(share, "heph"), heph);
  say(`installed ${heph} -> ${join(share, "heph")}`);
  if (!(process.env.PATH ?? "").split(":").includes(bin))
    say(`note: ${bin} is not on your PATH; add it in your shell profile`);

  const hephHome = join(home, ".heph");
  const config = join(hephHome, "config.yaml");
  mkdirSync(hephHome, { recursive: true });
  if (existsSync(config)) say(`kept ${config}`);
  else {
    writeFileSync(
      config,
      homeConfigYaml({
        nodeId: values["node-id"] ?? nodeIdFrom(hostname()),
        peers: (values.peer ?? []).map((p) => ({
          id: p,
          ssh: p,
          ...(values.preferred === p ? { preferred: true } : {}),
        })),
      }),
    );
    say(`wrote ${config}`);
  }

  if (!values["no-service"]) {
    // The daemon gets this shell's PATH, so it finds git, gh, go, docker as you do.
    const path = process.env.PATH ?? "/usr/bin:/bin";
    if (process.platform === "darwin") {
      const plist = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
      mkdirSync(join(plist, ".."), { recursive: true });
      writeFileSync(plist, launchdPlist({ heph, path, log: join(hephHome, "daemon.log") }));
      // bootout returns before the old agent is gone; bootstrap fails (error 5) until it is.
      const domain = `gui/${process.getuid?.()}`;
      const target = `${domain}/${LAUNCHD_LABEL}`;
      Bun.spawnSync(["launchctl", "bootout", target]);
      for (let i = 0; i < 100 && Bun.spawnSync(["launchctl", "print", target]).exitCode === 0; i++)
        await Bun.sleep(100);
      for (let attempt = 1; ; attempt++) {
        const r = Bun.spawnSync(["launchctl", "bootstrap", domain, plist], { stderr: "pipe" });
        if (r.exitCode === 0) break;
        if (attempt === 10)
          throw new Error(`launchctl bootstrap ${plist}: ${r.stderr.toString().trim()}`);
        await Bun.sleep(500);
      }
      say(`daemon running under launchd (${plist}; log ${join(hephHome, "daemon.log")})`);
    } else {
      const unit = join(home, ".config", "systemd", "user", "heph.service");
      mkdirSync(join(unit, ".."), { recursive: true });
      writeFileSync(unit, systemdUnit({ heph, path }));
      sh(["systemctl", "--user", "daemon-reload"]);
      sh(["systemctl", "--user", "enable", "heph.service"]);
      sh(["systemctl", "--user", "restart", "heph.service"]);
      say(`daemon running under systemd (${unit}; logs: journalctl --user -u heph)`);
    }
    await waitForDaemon(join(hephHome, "daemon.sock"));
  }

  const claude = join(home, ".claude");
  if (!values["no-claude"] && existsSync(claude)) {
    const skill = join(claude, "skills", "heph");
    mkdirSync(skill, { recursive: true });
    copyFileSync(
      join(REPO, "integrations", "claude", "skills", "heph", "SKILL.md"),
      join(skill, "SKILL.md"),
    );
    const settingsFile = join(claude, "settings.json");
    const settings = existsSync(settingsFile)
      ? JSON.parse(readFileSync(settingsFile, "utf8"))
      : undefined;
    const next = withHephUnsandboxed(withApproveDenied(settings));
    if (next !== settings) writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
    say(
      `Claude Code: skill in ${skill}; in ${settingsFile}, heph approve denied and heph run outside the Bash sandbox`,
    );
  }

  // The MCP server (`heph mcp`) for the agents' hosts: Claude Code through its CLI, Codex in config.toml.
  if (!values["no-claude"]) {
    const run: Runner = (cmd) => {
      try {
        // A `claude mcp get` that hangs (a health check that never ends) must not hang the install.
        const r = Bun.spawnSync(cmd, {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 20_000,
        });
        return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString() };
      } catch {
        return undefined;
      }
    };
    say(registerClaudeMcp(run, heph).message);
    const codex = join(home, ".codex");
    if (existsSync(codex)) {
      const file = join(codex, "config.toml");
      try {
        const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
        const after = withHephMcp(before, heph);
        if (after !== before) writeFileSync(file, after);
        say(`Codex: heph's MCP server in ${file}`);
      } catch (e) {
        say(
          `warning: could not update ${file} (${e instanceof Error ? e.message : String(e)}); add [mcp_servers.heph] with command = "${heph}", args = ["mcp"] yourself`,
        );
      }
    }
  }

  say(sh([heph, "--version"]).trim());
  const doctor = Bun.spawnSync([heph, "doctor"], { stdout: "inherit", stderr: "inherit" });
  if (doctor.exitCode !== 0) say("doctor found something to fix (the FAIL lines above)");
}

async function waitForDaemon(sock: string) {
  for (let i = 0; i < 50; i++) {
    if (existsSync(sock)) return;
    await Bun.sleep(100);
  }
  say(`warning: the daemon didn't create ${sock}; check its log`);
}

async function installRemote(host: string) {
  const arch = ssh(host, "uname -m").trim();
  const platform = arch === "aarch64" || arch === "arm64" ? "linux-arm64" : "linux-x64";
  const out = build(`bun-${platform}`, platform);

  // Uploaded beside, then renamed into place: a running daemon's binary can't be overwritten.
  ssh(host, "mkdir -p ~/.local/share/heph/incoming ~/.local/bin ~/.heph");
  const files = readdirSync(out);
  sh([
    "scp",
    "-q",
    "-o",
    "BatchMode=yes",
    ...files.map((f) => join(out, f)),
    `${host}:.local/share/heph/incoming/`,
  ]);
  ssh(
    host,
    [
      "cd ~/.local/share/heph",
      "chmod +x incoming/heph",
      ...files.map((f) => `mv -f incoming/${f} ${f}`),
      "rmdir incoming",
      "ln -sfn ~/.local/share/heph/heph ~/.local/bin/heph",
    ].join(" && "),
  );
  say(`installed ${host}:~/.local/bin/heph`);

  const nodeId = values["node-id"] ?? host;
  if (ssh(host, "test -f ~/.heph/config.yaml && echo yes || true").trim() === "yes")
    say(`kept ${host}:~/.heph/config.yaml`);
  else {
    ssh(host, "cat > ~/.heph/config.yaml", homeConfigYaml({ nodeId }));
    say(`wrote ${host}:~/.heph/config.yaml (node ${nodeId})`);
  }

  if (!values["no-service"]) {
    // A login shell's PATH there, plus ~/.local/bin.
    const path = `${ssh(host, "bash -lc 'echo $PATH'").trim()}:${ssh(host, "echo $HOME").trim()}/.local/bin`;
    const remoteHome = ssh(host, "echo $HOME").trim();
    ssh(
      host,
      "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/heph.service",
      systemdUnit({ heph: `${remoteHome}/.local/bin/heph`, path }),
    );
    ssh(
      host,
      "systemctl --user daemon-reload && systemctl --user enable heph.service && systemctl --user restart heph.service",
    );
    const linger = ssh(host, "loginctl show-user $USER -p Linger || true").trim();
    if (linger !== "Linger=yes") {
      const r = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", host, "loginctl enable-linger $USER"]);
      if (r.exitCode !== 0)
        say(
          `warning: the daemon stops when you log out of ${host}; run there: sudo loginctl enable-linger $USER`,
        );
    }
    say(`daemon running under systemd on ${host} (logs: journalctl --user -u heph)`);
  }

  say(ssh(host, "~/.local/bin/heph --version").trim());
  const doctor = Bun.spawnSync(["ssh", "-o", "BatchMode=yes", host, "~/.local/bin/heph doctor"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (doctor.exitCode !== 0) say(`doctor found something to fix on ${host} (the FAIL lines above)`);
}

try {
  if (values.remote) await installRemote(values.remote);
  else await installHere();
} catch (e) {
  console.error(`heph install: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
