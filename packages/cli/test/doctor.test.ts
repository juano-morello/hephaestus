import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DoctorEnv, doctor, doctorText } from "../src/doctor.ts";

let root: string;
let home: string;
let ws: string;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-doctor-"));
  home = join(root, "home");
  ws = join(root, "calc");
  put(join(ws, "add.sh"), "echo $(($1 + $2))\n");
  put(join(ws, "test_add.sh"), 'test "$(sh add.sh 2 3)" = 5\n');
  sh(["git", "init", "-q", "-b", "main"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "add", "-A"], ws);
  sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qm", "base"], ws);
  put(
    join(ws, ".heph", "workspace.yaml"),
    "name: calc\nrepos: { calc: . }\nprojects:\n  calc: { repo: calc, path: ., stack: sh }\n",
  );
  put(
    join(ws, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  put(
    join(home, "config.yaml"),
    "node: { id: mbp }\nsandbox: { mode: native }\nnodes:\n  denver: { ssh: denver }\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Everything answers; a test overrides what it breaks. */
const env = (over: Partial<DoctorEnv> = {}): DoctorEnv => ({
  probeModel: async (p) => ({ model: `anthropic ${p}-1` }),
  daemonUp: async () => true,
  helloNode: async () => ({ version: "0.1.0" }),
  ghLoggedIn: async () => true,
  ...over,
});

const byArea = (r: Awaited<ReturnType<typeof doctor>>) =>
  Object.fromEntries(r.checks.map((c) => [c.area, c]));

describe("heph doctor", () => {
  test("all good: every check passes and says what it found", async () => {
    const r = await doctor({ home, cwd: ws, tests: false, env: env() });
    expect(r.ok).toBe(true);
    const c = byArea(r);
    expect(c.config).toMatchObject({
      state: "ok",
      detail: `node mbp (${join(home, "config.yaml")})`,
    });
    expect(c.workspace).toMatchObject({ state: "ok", detail: "calc: calc (test: sh test_add.sh)" });
    expect(c.models?.state).toBe("ok");
    expect(c.models?.detail).toContain("claude/claude-opus-5-5: anthropic claude-opus-5-5-1");
    expect(c.sandbox).toMatchObject({ state: "ok" });
    expect(c.daemon).toMatchObject({ state: "ok", detail: "running" });
    expect(c["node denver"]).toMatchObject({ state: "ok", detail: "heph 0.1.0" });
    expect(c.tests).toMatchObject({ state: "skip" });
  });

  test("what's broken fails with a fix; what only slows you down warns", async () => {
    const r = await doctor({
      home,
      cwd: ws,
      tests: false,
      env: env({
        probeModel: async (p) =>
          p === "claude-sonnet-5-5"
            ? { error: "No API key found for anthropic." }
            : { model: `x ${p}` },
        daemonUp: async () => false,
        helloNode: async () => {
          throw new Error("ssh: connect to host denver port 22: Connection refused");
        },
      }),
    });
    expect(r.ok).toBe(false);
    const c = byArea(r);
    expect(c.models).toMatchObject({ state: "fail" });
    expect(c.models?.detail).toContain("claude/claude-sonnet-5-5: No API key found for anthropic.");
    expect(c.models?.fix).toContain("omp");
    expect(c.daemon).toMatchObject({ state: "warn" });
    expect(c["node denver"]).toMatchObject({
      state: "fail",
      detail: "ssh: connect to host denver port 22: Connection refused",
    });
  });

  test("a node on another version warns", async () => {
    const r = await doctor({
      home,
      cwd: ws,
      tests: false,
      env: env({ helloNode: async () => ({ version: "0.0.9" }) }),
    });
    expect(byArea(r)["node denver"]).toMatchObject({
      state: "warn",
      detail: expect.stringContaining("heph 0.0.9"),
    });
  });

  test("gh is checked only when a repo has a remote", async () => {
    const noGh = env({ ghLoggedIn: async () => false });
    expect(byArea(await doctor({ home, cwd: ws, tests: false, env: noGh })).gh).toMatchObject({
      state: "ok",
      detail: "not needed: no repo has a remote",
    });
    sh(["git", "remote", "add", "origin", "https://github.com/acme/calc.git"], ws);
    const c = byArea(await doctor({ home, cwd: ws, tests: false, env: noGh }));
    expect(c.gh).toMatchObject({ state: "fail" });
    expect(c.gh?.fix).toContain("gh auth login");
  });

  test("--tests runs each project's test command in the sandbox on a clean checkout of its target", async () => {
    const pass = byArea(await doctor({ home, cwd: ws, tests: true, env: env() }));
    expect(pass.tests).toMatchObject({ state: "ok" });
    expect(pass.tests?.detail).toMatch(/^calc: passes in the native sandbox \(\d+(\.\d)? s\)$/);

    // Uncommitted changes don't count: runs build from the target branch.
    put(join(ws, "add.sh"), "echo nope\n");
    expect(byArea(await doctor({ home, cwd: ws, tests: true, env: env() })).tests?.state).toBe(
      "ok",
    );

    sh(["git", "-c", "user.name=T", "-c", "user.email=t@x", "commit", "-qam", "break"], ws);
    const fail = byArea(await doctor({ home, cwd: ws, tests: true, env: env() }));
    expect(fail.tests).toMatchObject({ state: "fail" });
    expect(fail.tests?.detail).toContain("calc: sh test_add.sh exited 1");
    expect(
      Bun.spawnSync(["git", "worktree", "list"], { cwd: ws }).stdout.toString().trim().split("\n"),
    ).toHaveLength(1);
  }, 60_000);

  test("outside a workspace it says how to make one", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "heph-nows-"));
    const c = byArea(await doctor({ home, cwd: elsewhere, tests: false, env: env() }));
    expect(c.workspace).toMatchObject({
      state: "skip",
      fix: "cd into your repo and run heph init",
    });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a broken config is a FAIL line, not a crash", async () => {
    put(join(ws, ".heph", "config.yaml"), "projects:\n  calc:\n    commands: { test: 5 }\n");
    const r = await doctor({ home, cwd: ws, tests: false, env: env() });
    expect(r.ok).toBe(false);
    expect(byArea(r).workspace).toMatchObject({
      state: "fail",
      detail: expect.stringContaining("config.yaml:3: projects.calc.commands.test"),
    });
  });

  test("renders one line per check, a fix under each problem", async () => {
    const r = await doctor({
      home,
      cwd: ws,
      tests: false,
      env: env({ daemonUp: async () => false }),
    });
    const text = doctorText(r);
    expect(text).toStartWith("heph 0.1.0");
    expect(text).toContain("on node mbp\n");
    expect(text).toMatch(/\n {2}ok {3}config {5}node mbp/);
    expect(text).toMatch(/\n {2}warn {1}daemon {5}not running/);
    expect(text).toMatch(/\n {18}fix: /);
  });
});
