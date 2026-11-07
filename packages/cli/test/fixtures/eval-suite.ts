// A tiny golden-task suite on a tiny git repo, with a scripted planner and worker, for the eval
// runner's tests. The native sandbox cannot nest inside the agent sandbox, so commands run on the
// host in the directory (`plainSandbox`), unconfined: fine for these shell one-liners.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SpawnInput, SpawnOutput, Worker } from "@hephaestus/engine";
import { run as procRun, type Sandbox, type SandboxSpec } from "@hephaestus/sandbox";
import { type PlannerInput, type PlannerSession, runPlanner } from "@hephaestus/workers";

export const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=T", "-c", "user.email=t@x", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
export const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export const BRIEF = `schema: 1
source: cli
goal: add.sh prints the sum of two integers
context: ""
decisions: [Usage is sh add.sh A B]
constraints: [POSIX sh only]
acceptance:
  - { id: AC1, text: "sh add.sh 2 3 prints 5", kind: behavior }
out_of_scope: []
open_questions: []
`;

const task = (t: Record<string, unknown>) => ({
  lane: "contained",
  complexity: "standard",
  complexity_reason: "small",
  covers: ["AC1"],
  project: "calc",
  ...t,
});
export const PLAN = JSON.stringify({
  schema: 1,
  tasks: [
    task({
      id: "T1",
      title: "tests",
      kind: "test",
      scope: ["test_add.sh"],
      creates: ["test_add.sh"],
      produces: ["test:Add"],
      spec: "write test_add.sh",
    }),
    task({
      id: "T2",
      title: "impl",
      kind: "implement",
      scope: ["add.sh"],
      creates: ["add.sh"],
      consumes: ["test:Add"],
      spec: "write add.sh",
    }),
  ],
  risks: [],
});
export const ESCALATE = JSON.stringify({ schema: 1, escalate: ["AC1 contradicts decision 1"] });

/** The real planner on a fake session; the last reply repeats once the others are used. */
export function planner(replies: string[]) {
  const calls = { n: 0 };
  const fn = (input: PlannerInput) => {
    calls.n++;
    return runPlanner({
      ...input,
      createSession: async () => {
        const text = (replies.length > 1 ? replies.shift() : replies[0]) ?? "";
        const session: PlannerSession = {
          async prompt() {
            return true;
          },
          async abort() {},
          getLastAssistantMessage: () => ({
            stopReason: "stop",
            content: [{ type: "text", text }],
          }),
          getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
          messages: [],
          async dispose() {},
        };
        return { session };
      },
    });
  };
  return { fn, calls };
}

const FILES: Record<string, Record<string, string>> = {
  T1: { "test_add.sh": '[ "$(sh add.sh 2 3)" = "5" ]\n' },
  T2: { "add.sh": "echo $(($1 + $2))\n" },
};
export function worker() {
  const calls = { n: 0 };
  const w: Worker = {
    async spawn(input: SpawnInput): Promise<SpawnOutput> {
      calls.n++;
      const files = FILES[input.brief.task.id] ?? {};
      for (const [p, c] of Object.entries(files)) put(join(input.workdir, p), c);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { w, calls };
}

export async function plainSandbox(hostDir: string): Promise<Sandbox> {
  return {
    kind: "native",
    root: hostDir,
    exec: (command, opts) =>
      procRun(["sh", "-c", command], {
        cwd: opts?.cwd ? join(hostDir, opts.cwd) : hostDir,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }),
    async readFile(p) {
      return readFileSync(join(hostDir, p), "utf8");
    },
    async writeFile(p, c) {
      put(join(hostDir, p), c);
    },
    async dispose() {},
  };
}
/** For `Deps.sandbox`: gates (and the oracle, by default) run in the plain sandbox. */
export const sandbox = (spec: SandboxSpec) => plainSandbox(spec.hostDir);

/**
 * `<root>/calc` is the real repo (one commit, an uncommitted .heph/config.yaml, a dead remote),
 * `<root>/suite` the suite: tasks solve (fast), unsolved (slow), forbid, should-escalate (esc),
 * todo (needs an oracle) and broken.yaml (invalid). `<root>/real-home` is the node's home.
 */
export function createEvalSuite(root: string) {
  const real = join(root, "calc");
  const suiteDir = join(root, "suite");
  const realHome = join(root, "real-home");
  put(join(real, "README.md"), "# calc\n");
  git(real, "init", "-q", "-b", "main");
  git(real, "add", "-A");
  git(real, "commit", "-qm", "base");
  const pin = git(real, "rev-parse", "HEAD");
  git(real, "remote", "add", "origin", join(root, "nowhere.git"));
  put(
    join(real, ".heph", "config.yaml"),
    "projects:\n  calc:\n    commands: { test: sh test_add.sh }\n",
  );
  put(join(realHome, "config.yaml"), "node: { id: eval-test }\nsandbox: { mode: native }\n");
  put(
    join(suiteDir, "workspace.yaml"),
    "repos: { calc: ../calc }\nprojects:\n  calc: { repo: calc, path: ., stack: sh }\n",
  );
  put(join(suiteDir, "gates.yaml"), "calc: [tests]\n");
  put(join(suiteDir, "briefs", "b.yaml"), BRIEF);
  put(join(suiteDir, "evals", "oracle", "good.sh"), '[ "$(sh add.sh 7 8)" = "15" ]\n');
  put(join(suiteDir, "evals", "oracle", "bad.sh"), '[ "$(sh add.sh 7 8)" = "99" ]\n');
  const evalYaml = (id: string, body: string, tags: string[] = []) =>
    `id: ${id}\nworkspace_ref: { calc: "${pin}" }\nbrief: ../briefs/b.yaml\n${body}\ntags: [${tags.join(", ")}]\n`;
  const oracleYaml = (check: string, extra = "") =>
    `oracle:\n  hidden_tests:\n    - { project: calc, from: ./oracle/${check}, to: check.sh }\n  must_pass:\n    - { project: calc, run: sh check.sh }\n${extra}`;
  put(join(suiteDir, "evals", "solve.yaml"), evalYaml("solve", oracleYaml("good.sh"), ["fast"]));
  put(
    join(suiteDir, "evals", "unsolved.yaml"),
    evalYaml("unsolved", oracleYaml("bad.sh"), ["slow"]),
  );
  put(
    join(suiteDir, "evals", "forbid.yaml"),
    evalYaml(
      "forbid",
      oracleYaml("good.sh", "  must_not_touch:\n    - { project: calc, paths: [add.sh] }\n"),
    ),
  );
  put(
    join(suiteDir, "evals", "should-escalate.yaml"),
    evalYaml("should-escalate", "expect: escalate", ["esc"]),
  );
  put(join(suiteDir, "evals", "todo.yaml"), evalYaml("todo", oracleYaml("missing.sh")));
  put(join(suiteDir, "evals", "broken.yaml"), "id: broken\nnonsense: true\n");
  return { real, suiteDir, realHome, pin };
}
