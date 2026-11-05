// Live check of landing via pull requests: two real GitHub repos, a scripted worker (no model),
// runPlan -> landChangeset (push + 2 PRs) -> mergeChangeset (gh merges both) -> verify on GitHub.
// Creates private repos <owner>/heph-sandbox-proto and <owner>/heph-sandbox-server if missing
// and archives them at the end. Outward-facing: run it deliberately.
//
//   bun run packages/engine/scripts/pr-smoke.ts --owner <github-user-or-org> [--keep-open]
//
// --stacked (design 3.2-3.3) runs stacks of two runs in server instead, same repos and worker:
// A staged, B built and staged on A (B's PR based on heph/A), B not ready while A is unmerged,
// A merged, B restacked as the CLI does after a parent lands (its PR base now main, not merged),
// then B merged. A second stack A2/B2 has A2 squash-merged by hand on GitHub, then
// checkChangeset(A2) and the restack: B2 must restack without conflict onto main. With
// --keep-open it stops after staging the first stack (both PRs left open, nothing archived).
//
//   bun run packages/engine/scripts/pr-smoke.ts --owner <github-user-or-org> --stacked [--keep-open]

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Brief, briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { run, runOk } from "@hephaestus/sandbox";
import type { EngineConfig } from "../src/config.ts";
import { type RunPlanOptions, runPlan } from "../src/engine.ts";
import { checkChangeset, landChangeset, mergeChangeset } from "../src/land.ts";
import { ghPullRequests } from "../src/prs.ts";
import { restackChildren } from "../src/stack.ts";
import type { Worker } from "../src/worker.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "keep-open": { type: "boolean", default: false },
    stacked: { type: "boolean", default: false },
  },
});
if (!values.owner) {
  console.error("usage: pr-smoke.ts --owner <github-user-or-org> [--stacked] [--keep-open]");
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

if (values.stacked) {
  try {
    await stackedSmoke();
  } catch (e) {
    // Left as they are (repos not archived, the ledger kept) so what went wrong can be looked at.
    console.error(`FAILED: ${e instanceof Error ? e.message : e}`);
    console.error(`ledger and clones kept in ${root}; repos left unarchived`);
    ledger.close();
    process.exit(1);
  }
  ledger.close();
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

/**
 * --stacked: two stacks of two runs, each run one new file in server. The ledger is this
 * script's, so a child's `stack_on` is recorded on its run.created the way the CLI's newRun
 * does (createRun with stackOn, through runPlan); landing and merging read it from there.
 */
async function stackedSmoke(): Promise<void> {
  const serverDir = join(root, "server");
  const check = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "ok" : "FAIL"}: ${what}`);
    if (!ok) throw new Error(what);
  };
  const prField = async (url: string, field: string, jq = `.${field}`) =>
    (
      await runOk(["gh", "pr", "view", url, "--json", field, "--jq", jq], { cwd: serverDir })
    ).trim();
  const onMain = async (path: string) =>
    (await run(["gh", "api", `repos/${repos.server}/contents/${path}`, "--jq", ".name"])).code ===
    0;

  /** Per run: its options as the CLI's landOptions gives them (no stackOn: the ledger has it). */
  const runs = new Map<string, RunPlanOptions & { file: string }>();
  const optionsOf = (id: string) => {
    const o = runs.get(id);
    if (!o) throw new Error(`no run ${id}`);
    return o;
  };
  const define = (tag: string) => {
    const id = `${runId}${tag}`;
    const file = `${id}.sh`;
    const b: Brief = { ...brief, goal: `PR landing smoke ${id} (stacked)` };
    files[`S${tag}`] = { [file]: `echo ${id}\n` };
    const p: Plan = {
      schema: 1,
      brief_hash: briefHash(b),
      tasks: [task({ id: `S${tag}`, project: "server", scope: [file] })],
      risks: [],
    };
    runs.set(id, { ...opts, brief: b, plan: p, runId: id, changesetId: id, file });
    return id;
  };
  /** Builds the run (stacked on `stackOn` if given) and stages it: its server PR's URL. */
  const buildAndStage = async (id: string, stackOn?: string) => {
    const o = optionsOf(id);
    const built = await runPlan({ ...o, ...(stackOn ? { stackOn } : {}) });
    console.log(
      `run ${id}${stackOn ? ` on ${stackOn}` : ""}: ${built.status}${built.reason ? ` (${built.reason})` : ""}`,
    );
    check(built.status === "built", `${id} built`);
    check(
      (ledger.run(id)?.stack_on ?? undefined) === stackOn,
      `${id} run.created stack_on is ${stackOn ?? "none"}`,
    );
    const staged = await landChangeset(o);
    console.log(`landing ${id}: ${staged.status}${staged.reason ? ` (${staged.reason})` : ""}`);
    check(staged.status === "staged", `${id} staged`);
    const url = staged.prs?.server;
    check(url !== undefined, `${id} has a server PR`);
    console.log(`  server: ${url}`);
    return url as string;
  };
  /** mergeChangeset, retried while GitHub is still computing mergeability. */
  const merge = async (id: string) => {
    let merged = await mergeChangeset(optionsOf(id));
    for (let i = 0; i < 12 && merged.status === "not_ready"; i++) {
      console.log(`  not ready yet: ${merged.reasons.join("; ")}`);
      await Bun.sleep(5000);
      merged = await mergeChangeset(optionsOf(id));
    }
    console.log(`merge ${id}: ${JSON.stringify(merged)}`);
    check(merged.status === "merged", `${id} merged`);
    check(ledger.run(id)?.status === "finished", `${id} finished`);
  };
  /** What the CLI does once a parent landed (Runtime's `restacked`): restackChildren. */
  const restackAfter = async (parentId: string, childId: string, childUrl: string) => {
    const out = await restackChildren({ ledger, parentId, options: optionsOf });
    console.log(`restack after ${parentId}: ${JSON.stringify(out)}`);
    const r = out[childId];
    check(
      r?.status === "staged",
      `${childId} restacked without conflict (${r?.status ?? "no entry"}${r?.reason ? `: ${r.reason}` : ""})`,
    );
    check(ledger.run(childId)?.status === "staged", `${childId} still staged, not merged`);
    check((await prField(childUrl, "baseRefName")) === "main", `${childId} PR base is now main`);
    check((await prField(childUrl, "state")) === "OPEN", `${childId} PR still open`);
  };

  // 1-2. A on main, B on A: B's PR is based on heph/A.
  console.log("\n== stack 1: A <- B, merged with mergeChangeset ==");
  const a = define("A");
  const b = define("B");
  const aUrl = await buildAndStage(a);
  check((await prField(aUrl, "baseRefName")) === "main", `${a} PR base is main`);
  const bUrl = await buildAndStage(b, a);
  check((await prField(bUrl, "baseRefName")) === `heph/${a}`, `${b} PR base is heph/${a}`);

  // 3. B waits for A.
  const early = await mergeChangeset(optionsOf(b));
  console.log(`merge ${b} before ${a}: ${JSON.stringify(early)}`);
  check(
    early.status === "not_ready" && early.reasons.join("; ") === `waiting for ${a}`,
    `${b} not_ready, waiting for ${a}`,
  );
  if (values["keep-open"]) {
    console.log(`--keep-open: ${aUrl} and ${bUrl} left open, repos not archived`);
    return;
  }

  // 4. A merges; B, staged before A landed, is refused until restacked.
  await merge(a);
  const stale = await mergeChangeset(optionsOf(b));
  console.log(`merge ${b} before its restack: ${JSON.stringify(stale)}`);
  check(
    stale.status === "not_ready" && stale.reasons.some((r) => r.includes(`staged before ${a}`)),
    `${b} not_ready until restacked (staged before ${a} landed)`,
  );

  // 5. The restack: B onto main, its PR retargeted, not merged.
  await restackAfter(a, b, bUrl);

  // 6. B merges.
  await merge(b);
  for (const id of [a, b]) {
    const has = await onMain(optionsOf(id).file);
    check(has, `${repos.server} main has ${optionsOf(id).file}`);
  }

  // Squash variant: A2 squash-merged by hand on GitHub (its commits rewritten), then
  // checkChangeset(A2) and the restack; replaying only B2's own commits must not conflict.
  console.log("\n== stack 2: A2 <- B2, A2 squash-merged on GitHub ==");
  const a2 = define("A2");
  const b2 = define("B2");
  const a2Url = await buildAndStage(a2);
  const b2Url = await buildAndStage(b2, a2);
  check((await prField(b2Url, "baseRefName")) === `heph/${a2}`, `${b2} PR base is heph/${a2}`);
  // No --delete-branch: GitHub would then retarget B2's PR by itself, hiding the restack.
  for (let i = 0; ; i++) {
    console.log(`gh pr merge ${a2Url} --squash`);
    const r = await run(["gh", "pr", "merge", a2Url, "--squash"], { cwd: serverDir });
    if (r.code === 0) break;
    if (i >= 12) throw new Error(`gh pr merge --squash failed: ${r.stderr.trim()}`);
    console.log(`  not yet: ${r.stderr.trim()}`);
    await Bun.sleep(5000);
  }
  let checked = await checkChangeset(optionsOf(a2));
  for (let i = 0; i < 12 && checked.status === "open"; i++) {
    await Bun.sleep(5000);
    checked = await checkChangeset(optionsOf(a2));
  }
  console.log(`merge status ${a2}: ${JSON.stringify(checked)}`);
  check(checked.status === "merged", `${a2} merged by hand, checkChangeset finishes it`);
  check(ledger.run(a2)?.status === "finished", `${a2} finished`);
  await restackAfter(a2, b2, b2Url);
  check(
    (await prField(b2Url, "commits", ".commits | length")) === "1",
    `${b2} PR carries only its own commit`,
  );
  await merge(b2);
  for (const id of [a2, b2]) {
    const has = await onMain(optionsOf(id).file);
    check(has, `${repos.server} main has ${optionsOf(id).file}`);
  }

  for (const full of Object.values(repos)) await run(["gh", "repo", "archive", full, "--yes"]);
  console.log("\nall stacked checks passed; archived both repos (delete them on GitHub when done)");
}

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
