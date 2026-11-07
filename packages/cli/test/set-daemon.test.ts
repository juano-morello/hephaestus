import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../src/daemon.ts";
import { type Io, run } from "../src/main.ts";
import { deps } from "./fixtures/deps.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-set-"));
  writeFileSync(join(root, "config.yaml"), "node: { id: mbp }\nsandbox: { mode: native }\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const heph = async (args: string[], withDeps: boolean) => {
  let out = "";
  const io: Io = {
    cwd: root,
    env: { HEPH_HOME: root },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
    ...(withDeps ? { deps } : {}),
  };
  const code = await run([...args, "--json"], io);
  return { env: JSON.parse(out) as { ok: boolean; error?: { message: string } }, code };
};

describe("--set with a daemon", () => {
  test("is accepted when heph runs in-process", async () => {
    const r = await heph(["nodes", "--set", "limits.attempts_per_unit=4"], true);
    expect(r.env.ok).toBe(true);
  });

  test("is refused when a daemon would serve the command", async () => {
    const host = {
      node: "mbp",
      api: { call: async () => ({ nodes: [], daemon: false }) },
      resumeOnStart: async () => [],
      syncAll: async () => [],
    } as unknown as Parameters<typeof startDaemon>[0];
    const d = await startDaemon(host, { home: root, intervalS: 60 });
    try {
      const r = await heph(["nodes", "--set", "limits.attempts_per_unit=4"], false);
      expect(r.env.ok).toBe(false);
      expect(r.env.error?.message).toBe(
        "--set only applies when heph runs in-process; stop the daemon, or set the value in a config file",
      );
      // Without --set the same daemon answers.
      expect((await heph(["nodes"], false)).env.ok).toBe(true);
    } finally {
      await d.stop();
    }
  });
});
