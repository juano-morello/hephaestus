// Live check of landing via pull requests: two real GitHub repos, a scripted worker (no model),
// runPlan -> landChangeset (push + 2 PRs) -> mergeChangeset (gh merges both) -> verify on GitHub.
// Creates private repos <owner>/heph-sandbox-proto and <owner>/heph-sandbox-server if missing
// and archives them at the end. Outward-facing: run it deliberately.
//
//   bun run packages/engine/scripts/pr-smoke.ts --owner <github-user-or-org> [--keep-open]

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Brief, briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { run, runOk } from "@hephaestus/sandbox";
import type { EngineConfig } from "../src/config.ts";
import { runPlan } from "../src/engine.ts";
import { landChangeset, mergeChangeset } from "../src/land.ts";
import { ghPullRequests } from "../src/prs.ts";
import type { Worker } from "../src/worker.ts";

const { values } = parseArgs({
  options: { owner: { type: "string" }, "keep-open": { type: "boolean", default: false } },
});
if (!values.owner) {
  console.error("usage: pr-smoke.ts --owner <github-user-or-org>");
  process.exit(2);
}
const owner = values.owner;
const repos = { proto: `${owner}/heph-sandbox-proto`, server: `${owner}/heph-sandbox-server` };

const base = process.platform === "darwin" ? join(homedir(), ".cache", "heph-tests") : tmpdir();
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, "pr-smoke-"));
const runId = `R${Date.now().toString(36)}`;

for (const [name, full] of Object.entries(repos)) {
  const exists = (await run(["gh", "repo", "view", full, "--json", "name"])).code === 0;
  if (!exists) {
    await runOk([
      "gh",
      "repo",
      "create",
      full,
      "--private",
      "--add-readme",
      "--description",
      "Hephaestus PR landing smoke test (safe to delete)",
    ]);
    console.log(`created ${full}`);
  } else {
    await run(["gh", "repo", "unarchive", full, "--yes"]);
  }
  await runOk(["gh", "repo", "clone", full, join(root, name), "--", "-q"]);
  await runOk(["git", "config", "user.name", "Hephaestus smoke"], { cwd: join(root, name) });
  await runOk(["git", "config", "user.email", "heph@localhost"], { cwd: join(root, name) });
}

const workspace: Workspace = {
  repos: { proto: "./proto", server: "./server" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
  },
};
const brief: Brief = {
  schema: 1,
  goal: `PR landing smoke ${runId}`,
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "both repos change together", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};
const task = (t: Partial<Task> & Pick<Task, "id" | "project" | "scope">): Task => ({
  title: t.id,
  kind: "implement",
  lane: "contained",
  complexity: "trivial",
  complexity_reason: "smoke",
  covers: ["AC1"],
  spec: t.id,
  ...t,
});
const plan: Plan = {
  schema: 1,
  brief_hash: briefHash(brief),
  tasks: [
    task({
      id: "P1",
      project: "proto",
      kind: "codegen",
      covers: [],
      scope: [`${runId}.txt`],
      produces: ["proto:Smoke"],
    }),
    task({ id: "S1", project: "server", scope: [`${runId}.sh`], consumes: ["proto:Smoke"] }),
  ],
  risks: [],
};
const files: Record<string, Record<string, string>> = {
  P1: { [`${runId}.txt`]: "message Smoke {}\n" },
  S1: { [`${runId}.sh`]: "echo smoke\n" },
};
const worker: Worker = {
  async spawn(input) {
    const f = files[input.brief.task.id] ?? {};
    for (const [p, c] of Object.entries(f)) await Bun.write(join(input.workdir, p), c);
    return {
      output: { schema: 1, summary: "smoke", claims: [], touched: Object.keys(f) },
      transcript: "",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};
const config: EngineConfig = {
  routing: { implementer: { default: { model: "none/scripted" } } },
  maxAttempts: 1,
  parallel: 1,
  budgetTokens: 1000,
  tools: [],
  commands: {},
};

const ledger = openLedger(join(root, "node"), { nodeId: "smoke" });
const prs = ghPullRequests();
const opts = {
  ledger,
  workspace,
  workspaceRoot: root,
  brief,
  plan,
  runId,
  changesetId: runId,
  worker,
  gates: [],
  config,
  worktreesDir: join(root, "worktrees"),
  prs,
};

const built = await runPlan(opts);
console.log(`run ${runId}: ${built.status}`);
if (built.status !== "built") process.exit(1);

const staged = await landChangeset(opts);
console.log(`landing: ${staged.status}${staged.reason ? ` (${staged.reason})` : ""}`);
for (const [r, url] of Object.entries(staged.prs ?? {})) console.log(`  ${r}: ${url}`);
if (staged.status !== "staged") process.exit(1);

if (!values["keep-open"]) {
  // GitHub computes mergeability asynchronously; retry while it says so.
  let merged = await mergeChangeset(opts);
  for (let i = 0; i < 12 && merged.status === "not_ready"; i++) {
    console.log(`  not ready yet: ${merged.reasons.join("; ")}`);
    await Bun.sleep(5000);
    merged = await mergeChangeset(opts);
  }
  console.log(`merge: ${JSON.stringify(merged)}`);
  for (const [name, full] of Object.entries(repos)) {
    const path = name === "proto" ? `${runId}.txt` : `${runId}.sh`;
    const r = await run(["gh", "api", `repos/${full}/contents/${path}`, "--jq", ".name"]);
    console.log(`  ${full} main has ${path}: ${r.code === 0 ? "yes" : "no"}`);
  }
  console.log(`run status: ${ledger.run(runId)?.status}`);
  for (const full of Object.values(repos)) await run(["gh", "repo", "archive", full, "--yes"]);
  console.log("archived both repos (delete them on GitHub when done)");
}

ledger.close();
rmSync(root, { recursive: true, force: true });
