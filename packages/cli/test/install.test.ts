import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVE_DENY,
  claudeMcpAddCommand,
  homeConfigYaml,
  launchdPlist,
  nodeIdFrom,
  type Runner,
  registerClaudeMcp,
  systemdUnit,
  withApproveDenied,
  withHephMcp,
  withHephUnsandboxed,
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

describe("Claude Code's Bash sandbox", () => {
  test("heph runs outside it (it writes ~/.heph and talks to the daemon), keeping the rest", () => {
    expect(withHephUnsandboxed(undefined)).toEqual({ sandbox: { excludedCommands: ["heph"] } });
    const mine = { sandbox: { enabled: true, excludedCommands: ["docker"] }, model: "opus" };
    const once = withHephUnsandboxed(mine);
    expect(once).toEqual({
      sandbox: { enabled: true, excludedCommands: ["docker", "heph"] },
      model: "opus",
    });
    expect(withHephUnsandboxed(once)).toBe(once);
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

  test("both guides say to open the live run list right after dispatching a run", () => {
    const agents = readFileSync(join(root, "codex", "AGENTS.md"), "utf8");
    for (const text of [skill, agents])
      expect(text).toContain("Right after dispatching a run, call `heph_status` with no run");
  });

  test("Codex's AGENTS.md says the same as the skill", () => {
    const agents = readFileSync(join(root, "codex", "AGENTS.md"), "utf8");
    const body = skill.split("\n---\n")[1]?.trimStart();
    expect(agents.split("-->\n\n")[1]).toBe(body);
  });

  test("it tells the agent to explain and ask when a unit stalls", () => {
    expect(skill).toContain("**stalled**");
    expect(skill).toContain("failed the same way");
  });

  test("it never tells the agent to approve", () => {
    for (const line of skill.split("\n").filter((l) => l.includes("heph approve")))
      expect(line).not.toMatch(/^\s*heph approve/);
  });
});

describe("MCP registration", () => {
  const heph = "/home/u/.local/bin/heph";
  const add = claudeMcpAddCommand(heph);
  const fake = (get: { exitCode: number; stdout: string } | undefined, addOk = true) => {
    const calls: string[][] = [];
    const run: Runner = (cmd) => {
      calls.push(cmd);
      if (cmd[0] !== "claude") return undefined;
      if (cmd[2] === "get") return get;
      return { exitCode: addOk ? 0 : 1, stdout: "" };
    };
    return { run, calls };
  };

  test("Claude Code: registers when missing", () => {
    const f = fake({ exitCode: 1, stdout: "" });
    const r = registerClaudeMcp(f.run, heph);
    expect(r.done).toBe(true);
    expect(f.calls).toContainEqual(add);
    expect(add.join(" ")).toBe(`claude mcp add --scope user heph -- ${heph} mcp`);
  });

  test("Claude Code: skips when already registered with this command", () => {
    const f = fake({ exitCode: 0, stdout: `heph:\n  Command: ${heph}\n  Args: mcp\n` });
    const r = registerClaudeMcp(f.run, heph);
    expect(r.done).toBe(true);
    expect(f.calls).toEqual([["claude", "mcp", "get", "heph"]]);
  });

  test("Claude Code: a different command is removed and added again", () => {
    const f = fake({ exitCode: 0, stdout: "heph:\n  Command: /old/heph\n" });
    const r = registerClaudeMcp(f.run, heph);
    expect(r.message).toContain("differed");
    expect(f.calls).toContainEqual(["claude", "mcp", "remove", "--scope", "user", "heph"]);
    expect(f.calls).toContainEqual(add);
  });

  test("Claude Code: the same command with stale args is re-registered", () => {
    const f = fake({ exitCode: 0, stdout: `heph:\n  Command: ${heph}\n  Args: mcp --old\n` });
    const r = registerClaudeMcp(f.run, heph);
    expect(r.message).toContain("differed");
    expect(f.calls).toContainEqual(add);
  });

  test("Claude Code: user scope with the same command is left alone", () => {
    const f = fake({
      exitCode: 0,
      stdout: `heph:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: ${heph}\n  Args: mcp\n`,
    });
    expect(registerClaudeMcp(f.run, heph).done).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  for (const scope of [
    "Local config (private to you in this project)",
    "Project config (shared via .mcp.json)",
  ])
    test(`Claude Code: registered in another scope (${scope.split(" ")[0]}) is reported, not shadowed`, () => {
      const f = fake({
        exitCode: 0,
        stdout: `heph:\n  Scope: ${scope}\n  Type: stdio\n  Command: /elsewhere/heph\n  Args: mcp\n`,
      });
      const r = registerClaudeMcp(f.run, heph);
      expect(r.done).toBe(false);
      expect(r.message).toContain(`${(scope.split(" ")[0] ?? "").toLowerCase()} scope`);
      expect(r.message).toContain(add.join(" "));
      expect(f.calls).toEqual([["claude", "mcp", "get", "heph"]]);
    });

  test("Claude Code: absent, it prints the manual command and does not fail", () => {
    const f = fake(undefined);
    const r = registerClaudeMcp(f.run, heph);
    expect(r.done).toBe(false);
    expect(r.message).toContain(add.join(" "));
    expect(f.calls).toHaveLength(1);
  });

  test("Claude Code: a refused add prints the manual command", () => {
    const r = registerClaudeMcp(fake({ exitCode: 1, stdout: "" }, false).run, heph);
    expect(r.done).toBe(false);
    expect(r.message).toContain(add.join(" "));
  });
});

describe("Codex config.toml", () => {
  const heph = "/home/u/.local/bin/heph";
  const table = `[mcp_servers.heph]\ncommand = "${heph}"\nargs = ["mcp"]\ntool_timeout_sec = 120\n`;
  const parsedHeph = { command: heph, args: ["mcp"], tool_timeout_sec: 120 };

  test("a new file gets the table", () => {
    expect(withHephMcp(undefined, heph)).toBe(table);
    expect(withHephMcp("", heph)).toBe(table);
  });

  test("other content is kept, the table appended, with or without a trailing newline", () => {
    const mine = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n';
    expect(withHephMcp(mine, heph)).toBe(`${mine}\n${table}`);
    expect(withHephMcp(mine.trimEnd(), heph)).toBe(`${mine}\n${table}`);
  });

  test("it is idempotent", () => {
    const once = withHephMcp('model = "o3"\n', heph);
    expect(withHephMcp(once, heph)).toBe(once);
  });

  test("a stale heph table is replaced, neighbours kept", () => {
    const stale = `[a]\nx = 1\n\n[mcp_servers.heph]\ncommand = "/old/heph"\nargs = ["mcp", "--x"]\n\n[mcp_servers.heph.env]\nK = "v"\n\n[b]\ny = 2\n`;
    const out = withHephMcp(stale, heph);
    expect(out).toBe(`[a]\nx = 1\n\n[b]\ny = 2\n\n${table}`);
    expect(Bun.TOML.parse(out)).toEqual({
      a: { x: 1 },
      b: { y: 2 },
      mcp_servers: { heph: parsedHeph },
    });
  });

  test("an inline heph in [mcp_servers] is replaced, never duplicated", () => {
    const inline = `[mcp_servers]\nheph = { command = "/old/heph", args = ["mcp"] }\nother = { command = "x" }\n`;
    const out = withHephMcp(inline, heph);
    expect(Bun.TOML.parse(out)).toEqual({
      mcp_servers: { other: { command: "x" }, heph: parsedHeph },
    });
    expect(out).not.toContain("/old/heph");
  });

  test("dotted heph keys, under [mcp_servers] or at the root, are replaced", () => {
    const dotted = `[mcp_servers]\nheph.command = "/old/heph"\nheph.args = [\n  "mcp",\n]\nother.command = "x"\n`;
    const out = withHephMcp(dotted, heph);
    expect(Bun.TOML.parse(out)).toEqual({
      mcp_servers: { other: { command: "x" }, heph: parsedHeph },
    });
    const root = `mcp_servers.heph.command = "/old/heph"\nmodel = "o3"\n`;
    expect(Bun.TOML.parse(withHephMcp(root, heph))).toEqual({
      model: "o3",
      mcp_servers: { heph: parsedHeph },
    });
  });

  test("a multi-line array inside the heph table does not end the skip early", () => {
    const multi = `[mcp_servers.heph]\ncommand = "/old/heph"\nargs = [\n  ["nested"],\n  "mcp",\n]\nenv_vars = ["A"]\n\n[b]\ny = 2\n`;
    const out = withHephMcp(multi, heph);
    expect(out).toBe(`[b]\ny = 2\n\n${table}`);
  });

  test("a multi-line array elsewhere is kept whole", () => {
    const multi = `[a]\nxs = [\n  [1],\n  [2],\n]\n`;
    const out = withHephMcp(multi, heph);
    expect(Bun.TOML.parse(out)).toEqual({
      a: { xs: [[1], [2]] },
      mcp_servers: { heph: parsedHeph },
    });
  });

  describe("multi-line strings", () => {
    const headerCount = (s: string) =>
      s.split("\n").filter((l) => l === "[mcp_servers.heph]").length;

    test("a header-looking line inside a string is not a table; one is added once", () => {
      const src = `notes = """\n[mcp_servers.heph]\ncommand = "/fake"\n"""\nmodel = "o3"\n`;
      const out = withHephMcp(src, heph);
      expect(out.startsWith(src.trimEnd())).toBe(true);
      expect(headerCount(out.replace(src.trimEnd(), ""))).toBe(1);
      const parsed = Bun.TOML.parse(out) as Record<string, unknown>;
      expect(parsed.notes).toBe('[mcp_servers.heph]\ncommand = "/fake"\n');
      expect(parsed.mcp_servers).toEqual({ heph: parsedHeph });
    });

    test("an unbalanced [ inside a string before the real table leaves one table", () => {
      const src = `notes = """\nsee [this\n"""\n\n[mcp_servers.heph]\ncommand = "/old"\n\n[b]\ny = 2\n`;
      const out = withHephMcp(src, heph);
      expect(headerCount(out)).toBe(1);
      expect(out).not.toContain("/old");
      expect(Bun.TOML.parse(out)).toEqual({
        notes: "see [this\n",
        b: { y: 2 },
        mcp_servers: { heph: parsedHeph },
      });
    });

    test("an existing real table is updated, not duplicated, after a string with brackets", () => {
      const src = `a = '''\n[b]\n[[c]]\n'''\n[mcp_servers.heph]\ncommand = "/old"\n`;
      const out = withHephMcp(src, heph);
      expect(headerCount(out)).toBe(1);
      expect(Bun.TOML.parse(out)).toEqual({ a: "[b]\n[[c]]\n", mcp_servers: { heph: parsedHeph } });
    });

    test("a ''' literal string hides a heph table header too", () => {
      const src = `x = '''\n[mcp_servers.heph]\n'''\n`;
      const out = withHephMcp(src, heph);
      expect(headerCount(out.replace(src.trimEnd(), ""))).toBe(1);
      expect((Bun.TOML.parse(out) as { x: string }).x).toBe("[mcp_servers.heph]\n");
    });

    test("a one-line triple-quoted string does not start a string", () => {
      const src = `a = """x"""\n[mcp_servers.heph]\ncommand = "/old"\n\n[b]\ny = 2\n`;
      const out = withHephMcp(src, heph);
      expect(Bun.TOML.parse(out)).toEqual({
        a: "x",
        b: { y: 2 },
        mcp_servers: { heph: parsedHeph },
      });
    });

    test("a string ending in four quotes inside an array keeps the depth right", () => {
      for (const q of ['"""', "'''"]) {
        const src =
          `a = [${q}x${q}", "b"]\n\n[mcp_servers.heph]\ncommand = "/old"\n\n[b]\ny = 2\n`.replace(
            `${q}", "b"]`,
            `${q}${q[0]}, "b"]`,
          );
        const out = withHephMcp(src, heph);
        expect(headerCount(out)).toBe(1);
        expect(out).not.toContain("/old");
        expect(Bun.TOML.parse(out)).toMatchObject({
          b: { y: 2 },
          mcp_servers: { heph: parsedHeph },
        });
      }
    });

    test("a multi-line string inside the heph table is skipped whole", () => {
      const src = `[mcp_servers.heph]\ncommand = "/old"\nnote = """\n[b]\n"""\n\n[c]\nz = 1\n`;
      const out = withHephMcp(src, heph);
      expect(Bun.TOML.parse(out)).toEqual({ c: { z: 1 }, mcp_servers: { heph: parsedHeph } });
    });

    test("a multi-line string closing before more array items keeps the array whole", () => {
      const src = `xs = [\n  """a\n[mcp_servers.heph]""",\n  "b",\n]\n`;
      const out = withHephMcp(src, heph);
      expect(Bun.TOML.parse(out)).toEqual({
        xs: ["a\n[mcp_servers.heph]", "b"],
        mcp_servers: { heph: parsedHeph },
      });
    });
  });

  test("CRLF input keeps CRLF line endings", () => {
    const crlf = `model = "o3"\r\n\r\n[mcp_servers.heph]\r\ncommand = "/old"\r\n`;
    const out = withHephMcp(crlf, heph);
    expect(out).toBe(`model = "o3"\r\n\r\n${table.replaceAll("\n", "\r\n")}`);
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
  });
});
