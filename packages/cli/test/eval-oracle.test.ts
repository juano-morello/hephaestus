import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Oracle, Workspace } from "@hephaestus/core";
import type { Sandbox } from "@hephaestus/sandbox";
import { checkOracle } from "../src/eval/oracle.ts";

let root: string;
let taskDir: string;
let checkout: string;
let base: string;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-oracle-"));
  taskDir = join(root, "evals");
  checkout = join(root, "checkout");
  put(join(taskDir, "tests", "hidden_test.go"), "package server\n");
  put(join(checkout, "server", "main.go"), "package server\n");
  put(join(checkout, "server", "persistence", "db.go"), "package persistence\n");
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "base");
  base = git(checkout, "rev-parse", "HEAD");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The run's result on top of the pin: commits the given files. */
const change = (files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) put(join(checkout, p), c);
  git(checkout, "add", "-A");
  git(checkout, "commit", "-qm", "result");
};

const workspace = (path = "server"): Workspace => ({
  repos: { game: "./game" },
  projects: { server: { repo: "game", path, stack: "go" } },
});

const oracle = (o: Partial<Oracle> = {}): Oracle => ({
  hidden_tests: [{ project: "server", from: "tests/hidden_test.go", to: "hidden_test.go" }],
  must_pass: [{ project: "server", run: "go test ./..." }],
  must_not_touch: [],
  ...o,
});

type Script = { codes?: Record<string, number>; timedOut?: string[] };
function scripted(script: Script = {}) {
  const log: { hostDir: string; command: string; timeoutMs?: number; disposed: boolean }[] = [];
  const sandboxOf = async (hostDir: string): Promise<Sandbox> => {
    const entry = { hostDir, command: "", disposed: false } as (typeof log)[number];
    log.push(entry);
    return {
      kind: "native",
      root: hostDir,
      async exec(command, opts) {
        entry.command = command;
        if (opts?.timeoutMs !== undefined) entry.timeoutMs = opts.timeoutMs;
        const timedOut = script.timedOut?.includes(command) ?? false;
        return { code: script.codes?.[command] ?? 0, stdout: "", stderr: "", timedOut };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
      async dispose() {
        entry.disposed = true;
      },
    };
  };
  return { log, sandboxOf };
}

const check = (o: Oracle, script?: Script, ws = workspace()) => {
  const s = scripted(script);
  return {
    s,
    run: () =>
      checkOracle({
        oracle: o,
        taskDir,
        workspace: ws,
        checkoutOf: () => checkout,
        base: { game: base },
        sandboxOf: s.sandboxOf,
        timeoutMs: 1234,
      }),
  };
};

describe("checkOracle", () => {
  test("a passing run is solved and every sandbox is disposed", async () => {
    change({ "server/main.go": "package server // done\n" });
    const c = check(oracle());
    expect(await c.run()).toEqual({ solved: true, failures: [] });
    expect(c.s.log).toHaveLength(1);
    expect(c.s.log[0]).toMatchObject({
      hostDir: join(checkout, "server"),
      command: "go test ./...",
      timeoutMs: 1234,
      disposed: true,
    });
  });

  test("a must_pass that exits non-zero fails and names the command", async () => {
    change({ "server/main.go": "x\n" });
    const r = await check(oracle(), { codes: { "go test ./...": 2 } }).run();
    expect(r.solved).toBe(false);
    expect(r.failures).toEqual(["must_pass server: go test ./... exited 2"]);
  });

  test("every must_pass runs, so every failure is named", async () => {
    change({ "server/main.go": "x\n" });
    const o = oracle({
      must_pass: [
        { project: "server", run: "go vet ./..." },
        { project: "server", run: "go test ./..." },
      ],
    });
    const c = check(o, { codes: { "go vet ./...": 1, "go test ./...": 2 } });
    const r = await c.run();
    expect(r.failures).toEqual([
      "must_pass server: go vet ./... exited 1",
      "must_pass server: go test ./... exited 2",
    ]);
    expect(c.s.log.every((l) => l.disposed)).toBe(true);
  });

  test("a timed out command fails with timed out", async () => {
    change({ "server/main.go": "x\n" });
    const r = await check(oracle(), { timedOut: ["go test ./..."] }).run();
    expect(r.failures).toEqual(["must_pass server: go test ./... timed out"]);
  });

  test("a changed forbidden path fails and names the project-relative file", async () => {
    change({ "server/persistence/db.go": "package persistence // edited\n" });
    const o = oracle({ must_not_touch: [{ project: "server", paths: ["persistence/**"] }] });
    const r = await check(o).run();
    expect(r.solved).toBe(false);
    expect(r.failures).toEqual(["must_not_touch server: persistence/db.go"]);
  });

  test("a file outside the project is not a violation of that project's paths", async () => {
    change({ "README.md": "hello\n" });
    const o = oracle({ must_not_touch: [{ project: "server", paths: ["**"] }] });
    expect((await check(o).run()).solved).toBe(true);
  });

  test("the hidden tests the oracle adds do not count as violations", async () => {
    change({ "server/main.go": "x\n" });
    const o = oracle({ must_not_touch: [{ project: "server", paths: ["**/*_test.go"] }] });
    expect(await check(o).run()).toEqual({ solved: true, failures: [] });
  });

  test("hidden tests land at <project path>/<to>, created with their directories", async () => {
    change({ "server/main.go": "x\n" });
    const o = oracle({
      hidden_tests: [{ project: "server", from: "tests/hidden_test.go", to: "deep/er/h_test.go" }],
    });
    let seen = false;
    const c = checkOracle({
      oracle: o,
      taskDir,
      workspace: workspace(),
      checkoutOf: () => checkout,
      base: { game: base },
      timeoutMs: 1,
      sandboxOf: async (hostDir) => {
        seen = existsSync(join(hostDir, "deep", "er", "h_test.go"));
        return (await scripted().sandboxOf(hostDir)) as Sandbox;
      },
    });
    await c;
    expect(seen).toBe(true);
    expect(existsSync(join(checkout, "server", "deep", "er", "h_test.go"))).toBe(true);
  });

  test("a project at the repo root ('.') maps files unchanged", async () => {
    change({ "server/persistence/db.go": "edited\n" });
    const o = oracle({
      hidden_tests: [{ project: "server", from: "tests/hidden_test.go", to: "h_test.go" }],
      must_not_touch: [{ project: "server", paths: ["server/persistence/*"] }],
    });
    const c = check(o, undefined, workspace("."));
    const r = await c.run();
    expect(r.failures).toEqual(["must_not_touch server: server/persistence/db.go"]);
    expect(c.s.log[0]?.hostDir).toBe(checkout);
  });
});
