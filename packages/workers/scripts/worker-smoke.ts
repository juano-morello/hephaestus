// Live end-to-end check of v0 step 2.3: the engine runs a 2-task plan with the real OMP worker,
// every tool call inside a sandbox. Uses your OMP subscription; takes a few minutes.
//
//   bun run packages/workers/scripts/worker-smoke.ts [--model claude/sonnet] [--mode container|native]
//     [--image alpine:3.20] [--keep]

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Brief, briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import { builtinGates, createGit, type EngineConfig, runPlan } from "@hephaestus/engine";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk, type SandboxSpec } from "@hephaestus/sandbox";
import { createOmpWorker } from "../src/omp.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "claude/sonnet" },
    mode: { type: "string", default: "container" },
    image: { type: "string", default: "alpine:3.20" },
    keep: { type: "boolean", default: false },
  },
});

const base = process.platform === "darwin" ? join(homedir(), ".cache", "heph-tests") : tmpdir();
const root = mkdtempSync(join(base, "smoke-"));
const repoDir = join(root, "repo");
const sandboxFor = (hostDir: string): SandboxSpec =>
  values.mode === "native"
    ? { mode: "native", hostDir }
    : { mode: "container", hostDir, image: values.image };

// A tiny POSIX sh project, so the default alpine image has everything it needs.
await runOk(["mkdir", "-p", join(repoDir, "calc")]);
await Bun.write(join(repoDir, "calc", "README.md"), "# calc\n\n`add.sh A B` prints A + B.\n");
await Bun.write(join(repoDir, "NOTICE"), "outside the project\n");
const git = (...a: string[]) => runOk(["git", ...a], { cwd: repoDir });
await git("init", "-q", "-b", "main");
await git("config", "user.name", "Smoke");
await git("config", "user.email", "smoke@example.com");
await git("add", "-A");
await git("commit", "-q", "-m", "base");

const workspace: Workspace = {
  repos: { demo: "." },
  projects: { calc: { repo: "demo", path: "calc", stack: "sh" } },
};
const brief: Brief = {
  schema: 1,
  goal: "add.sh prints the sum of two integers",
  context: "A POSIX sh script, no bash-isms; it must run under busybox sh.",
  decisions: [
    "Usage: sh add.sh A B",
    "A non-integer argument prints an error to stderr and exits 1",
  ],
  constraints: ["POSIX sh only", "No files outside the task scope"],
  acceptance: [
    { id: "AC1", text: "sh add.sh 2 3 prints 5", kind: "behavior" },
    { id: "AC2", text: "sh add.sh -4 1 prints -3", kind: "behavior" },
    { id: "AC3", text: "sh add.sh 2 x exits 1 and prints an error to stderr", kind: "behavior" },
  ],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};
const task = (t: Partial<Task> & Pick<Task, "id" | "kind" | "scope" | "spec">): Task => ({
  title: t.id,
  project: "calc",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "small script with three cases",
  covers: ["AC1", "AC2", "AC3"],
  ...t,
});
const plan: Plan = {
  schema: 1,
  brief_hash: briefHash(brief),
  tasks: [
    task({
      id: "T1",
      kind: "test",
      scope: ["test_add.sh"],
      produces: ["test:Add"],
      spec: "Write test_add.sh, a POSIX sh script that runs `sh add.sh` for AC1, AC2 and AC3 and exits 0 only if every case behaves as specified, non-zero otherwise, printing which case failed. add.sh does not exist yet, so test_add.sh must fail now. Do not create add.sh.",
    }),
    task({
      id: "T2",
      kind: "implement",
      scope: ["add.sh"],
      consumes: ["test:Add"],
      spec: "Write add.sh so that `sh test_add.sh` passes. Follow the brief's decisions.",
    }),
  ],
  risks: [],
};

const config: EngineConfig = {
  routing: {
    test_author: { default: { model: values.model, effort: "medium" } },
    implementer: { default: { model: values.model, effort: "medium" } },
  },
  maxAttempts: 3,
  parallel: 1,
  budgetTokens: 20_000,
  tools: [],
  commands: { calc: { test: "sh test_add.sh" } },
};

const ledger = openLedger(join(root, "node"), { nodeId: "smoke" });
const worker = createOmpWorker({ sandbox: (i) => sandboxFor(i.workdir), timeoutMs: 10 * 60_000 });
console.log(
  `smoke: ${values.model}, ${values.mode} sandbox${values.mode === "container" ? ` (${values.image})` : ""}, in ${root}`,
);
const started = Date.now();
const outcome = await runPlan({
  ledger,
  workspace,
  workspaceRoot: repoDir,
  brief,
  plan,
  runId: "R1",
  changesetId: "C1",
  worker,
  gates: builtinGates(),
  gateSandbox: (workdir) => openSandbox(sandboxFor(workdir)),
  config,
  worktreesDir: join(root, "worktrees"),
});

console.log(
  `\noutcome: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""} in ${((Date.now() - started) / 1000).toFixed(0)}s`,
);
for (const u of ledger.units("R1")) {
  const attempts = ledger.attempts("R1", u.unit_id);
  console.log(
    `  ${u.unit_id} ${u.status}: ${attempts.map((a) => `a${a.attempt}=${a.outcome ?? a.status} ${((a.duration_ms ?? 0) / 1000).toFixed(0)}s`).join(", ")}`,
  );
}
for (const u of ledger.usage("R1")) {
  console.log(
    `  usage ${u.model}: in ${u.input} out ${u.output} cache_read ${u.cache_read} cache_write ${u.cache_write}`,
  );
}
for (const s of ledger.read({ types: ["gate.result", "unit.returned", "unit.escalated"] })) {
  const d = s.event.data as { gate?: string; verdict?: string; reason?: string };
  console.log(
    `  ${s.event.type} ${s.event.unit_id}/a${s.event.attempt ?? "-"} ${d.gate ?? ""} ${d.verdict ?? ""} ${d.reason ?? ""}`,
  );
}

const head = outcome.heads.demo as string;
const changed = (await createGit(repoDir).diff("main", head)).files;
console.log(`\nrun branch heph/R1 changes: ${changed.join(", ") || "(none)"}`);
console.log(`outside calc/: ${changed.filter((f) => !f.startsWith("calc/")).join(", ") || "none"}`);
for (const f of changed) console.log(`\n--- ${f}\n${await git("show", `${head}:${f}`)}`);

// Containment probe: what the agent's sandbox can and cannot reach.
const probe = await openSandbox(sandboxFor(join(repoDir, "calc")));
try {
  const r = await probe.exec(
    `ls ${homedir()}/.ssh 2>&1 | head -1; ls .. 2>&1 | head -3; wget -q -T 2 -O- http://1.1.1.1 >/dev/null 2>&1; echo net_exit=$?`,
  );
  console.log(`\nprobe (${probe.kind}):\n${r.stdout}`);
} finally {
  await probe.dispose();
}

ledger.close();
if (!values.keep) rmSync(root, { recursive: true, force: true });
process.exit(outcome.status === "built" ? 0 : 1);
