import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVE_DENY,
  homeConfigYaml,
  launchdPlist,
  nodeIdFrom,
  systemdUnit,
  withApproveDenied,
} from "../src/install-files.ts";

describe("installer files", () => {
  test("the starter config names the node, the sandbox, and any peer", () => {
    expect(homeConfigYaml({ nodeId: "mbp" })).toBe(
      [
        "# Written by the heph installer. Edit freely; heph doctor checks it.",
        "node: { id: mbp }",
        "# Native: commands run on this machine's toolchains, confined (no network, no writes",
        "# outside the project and temp, credentials unreadable). Container mode needs an image",
        "# with each project's toolchain and its dependencies.",
        "sandbox: { mode: native }",
        "",
      ].join("\n"),
    );
    const withPeer = homeConfigYaml({
      nodeId: "mbp",
      peers: [{ id: "denver", ssh: "denver", preferred: true }],
    });
    expect(withPeer).toContain(
      "nodes:\n  denver: { ssh: denver, heph: ~/.local/bin/heph, preferred: true }\n",
    );
    expect(Bun.YAML.parse(withPeer)).toEqual({
      node: { id: "mbp" },
      sandbox: { mode: "native" },
      nodes: { denver: { ssh: "denver", heph: "~/.local/bin/heph", preferred: true } },
    });
  });

  test("a node id comes from the host name, made stable", () => {
    expect(nodeIdFrom("Juanos-MacBook-Pro.local")).toBe("juanos-macbook-pro");
    expect(nodeIdFrom("denver")).toBe("denver");
  });

  test("launchd runs the daemon at login, keeps it up, with the installing shell's PATH", () => {
    const plist = launchdPlist({
      heph: "/Users/u/.local/bin/heph",
      path: "/Users/u/go/bin:/usr/bin",
      log: "/Users/u/.heph/daemon.log",
    });
    expect(plist).toContain("<string>dev.hephaestus.daemon</string>");
    expect(plist).toContain(
      "<array>\n    <string>/Users/u/.local/bin/heph</string>\n    <string>daemon</string>\n  </array>",
    );
    expect(plist).toContain("<key>PATH</key>\n    <string>/Users/u/go/bin:/usr/bin</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/Users/u/.heph/daemon.log</string>");
  });

  test("systemd runs the daemon as a user service and restarts it when it dies", () => {
    const unit = systemdUnit({ heph: "/home/u/.local/bin/heph", path: "/usr/bin:/bin" });
    expect(unit).toContain("ExecStart=/home/u/.local/bin/heph daemon");
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("Claude Code settings get heph approve denied, once, keeping everything else", () => {
    expect(APPROVE_DENY).toBe("Bash(heph approve:*)");
    expect(withApproveDenied(undefined)).toEqual({ permissions: { deny: [APPROVE_DENY] } });
    const mine = {
      model: "opus",
      permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm -rf:*)"] },
    };
    const once = withApproveDenied(mine);
    expect(once).toEqual({
      model: "opus",
      permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm -rf:*)", APPROVE_DENY] },
    });
    expect(withApproveDenied(once)).toEqual(once);
  });
});

describe("the agent guidance", () => {
  const root = join(import.meta.dir, "..", "..", "..", "integrations");
  const skill = readFileSync(join(root, "claude", "skills", "heph", "SKILL.md"), "utf8");

  test("the Claude Code skill names itself and says when to use it", () => {
    const front = Bun.YAML.parse(skill.split("---")[1] ?? "") as Record<string, string>;
    expect(front.name).toBe("heph");
    expect(front.description).toContain("Never approves anything");
  });

  test("Codex's AGENTS.md says the same as the skill", () => {
    const agents = readFileSync(join(root, "codex", "AGENTS.md"), "utf8");
    const body = skill.split("\n---\n")[1]?.trimStart();
    expect(agents.split("-->\n\n")[1]).toBe(body);
  });

  test("it never tells the agent to approve", () => {
    for (const line of skill.split("\n").filter((l) => l.includes("heph approve")))
      expect(line).not.toMatch(/^\s*heph approve/);
  });
});
