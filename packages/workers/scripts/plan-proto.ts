// Step 0 planner prototype (SPEC section 19): run the planner N times on one Brief through OMP
// and measure how often its first answer passes every plan gate.
//
//   bun run packages/workers/scripts/plan-proto.ts --brief <file> --workspace <file> [--runs N]
//     [--model opus] [--thinking high] [--prompt <file>] [--gates <file>] [--repo-maps <dir>]
//     [--out <dir>] [--workspace-root <dir>] [--correct] [--seed-faults]
//
// --correct: when the first answer is invalid, send its output and gate evidence back once and
// report first-try, second-try and overall validity (the planner correction edge).
// --seed-faults: also take each valid first answer, break it with one known fault, and run only
// the correction. A mechanism test of the edge; reported apart from the model's natural rate.
//
// --workspace-root points at the real repos (resolved like workspace.yaml's repo paths); the plan
// gates then check scopes against each project's tracked files.

import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  answerOutcome,
  Brief,
  briefGate,
  briefHash,
  type ComplexityResult,
  type CorrectionRecord,
  correctionStats,
  DEFAULT_LIMITS,
  deriveEdges,
  type Evaluation,
  evaluatePlannerOutput,
  type GateResult,
  type Plan,
  ProjectGates,
  topoOrder,
  Workspace,
} from "@hephaestus/core";
import type { Usage } from "@hephaestus/ledger";
import { PLANNER_PROMPT, runPlanner } from "../src/planner.ts";

const { values } = parseArgs({
  options: {
    brief: { type: "string" },
    workspace: { type: "string" },
    runs: { type: "string", default: "1" },
    model: { type: "string", default: "opus" },
    thinking: { type: "string", default: "high" },
    prompt: { type: "string" },
    gates: { type: "string" },
    "repo-maps": { type: "string" },
    out: { type: "string" },
    "workspace-root": { type: "string" },
    correct: { type: "boolean", default: false },
    "seed-faults": { type: "boolean", default: false },
  },
});

if (!values.brief || !values.workspace) {
  console.error("usage: plan-proto.ts --brief <file> --workspace <file> [--runs N]");
  process.exit(2);
}

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const briefPath = resolve(values.brief);
const workspacePath = resolve(values.workspace);
const runs = Number.parseInt(values.runs, 10);
const gatesPath = resolve(values.gates ?? join(dirname(workspacePath), "gates.yaml"));
const repoMapsDir = resolve(values["repo-maps"] ?? join(dirname(workspacePath), "repo-maps"));
const briefName = basename(briefPath, extname(briefPath));
const outDir = join(
  resolve(values.out ?? join(ROOT, "out")),
  briefName,
  new Date().toISOString().replace(/[:.]/g, "-"),
);

const loadData = async (path: string) => {
  const text = await Bun.file(path).text();
  return { text, data: path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text) };
};

const workspaceFile = await loadData(workspacePath);
const workspace = Workspace.parse(workspaceFile.data);
const gatesFile = await loadData(gatesPath);
const projectGates = ProjectGates.parse(gatesFile.data);
const brief = Brief.parse((await loadData(briefPath)).data);
const briefCheck = briefGate(brief, workspace, projectGates);
if (briefCheck.verdict === "fail") {
  console.error(`brief gate failed: ${briefCheck.reason}`);
  for (const e of briefCheck.evidence) console.error(`  - ${e}`);
  process.exit(1);
}

const hash = briefHash(brief);
const repoMaps: string[] = [];
for (const name of Object.keys(workspace.projects)) {
  const file = Bun.file(join(repoMapsDir, `${name}.md`));
  if (await file.exists()) repoMaps.push((await file.text()).trim());
}

/** Tracked files per project, project-relative, read with git from the real repos. */
function projectFiles(root: string): Record<string, string[]> {
  const byRepo = new Map<string, string[]>();
  for (const [repo, path] of Object.entries(workspace.repos)) {
    const r = Bun.spawnSync(["git", "ls-files"], { cwd: resolve(root, path) });
    if (r.exitCode !== 0) throw new Error(`git ls-files failed in ${path}: ${r.stderr.toString()}`);
    byRepo.set(repo, r.stdout.toString().split("\n").filter(Boolean));
  }
  return Object.fromEntries(
    Object.entries(workspace.projects).map(([name, p]) => {
      const prefix = p.path === "." ? "" : `${p.path.replace(/^\.\//, "").replace(/\/$/, "")}/`;
      const files = (byRepo.get(p.repo) ?? [])
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length));
      return [name, files];
    }),
  );
}

const files = values["workspace-root"]
  ? projectFiles(resolve(values["workspace-root"]))
  : undefined;

type RunRecord = {
  run: number;
  model: string;
  duration_ms: number;
  usage?: Usage;
  stop_reason?: string;
  output: string;
  evaluation: Evaluation;
};

async function callPlanner(correction?: {
  feedback: GateResult[];
  previousOutput: string;
}): Promise<Omit<RunRecord, "run">> {
  const started = Date.now();
  const r = await runPlanner({
    ...(correction ?? {}),
    brief,
    workspace,
    projectGates,
    ...(files ? { files } : {}),
    repoMap: repoMaps.join("\n\n"),
    route: { model: values.model, effort: values.thinking },
    promptPath: resolve(values.prompt ?? PLANNER_PROMPT),
  });
  return {
    model: values.model,
    duration_ms: Date.now() - started,
    usage: r.usage,
    output: r.output,
    evaluation: r.evaluation,
  };
}

function printRun(r: RunRecord) {
  const { evaluation: ev } = r;
  const tokens = r.usage ? `in ${r.usage.input} out ${r.usage.output}` : "no usage";
  const secs = (r.duration_ms / 1000).toFixed(1);
  const verdict = ev.escalate ? "ESCALATED" : ev.valid ? "VALID" : "INVALID";
  console.log(`\nrun ${r.run}/${runs}  ${r.model}  ${secs}s  ${tokens}  ${verdict}`);
  for (const reason of ev.escalate ?? []) console.log(`  - ${reason}`);
  if (ev.error) console.log(`  ${ev.failures[0]}: ${ev.error}`);
  for (const g of ev.gates) {
    console.log(`  ${g.verdict === "pass" ? "PASS" : "FAIL"} ${g.gate}: ${g.reason}`);
    if (g.verdict === "fail" || g.gate === "complexity_sanity") {
      for (const e of g.evidence) console.log(`       - ${e}`);
    }
  }
  if (!ev.plan) return;
  for (const t of ev.plan.tasks) {
    const flow = [
      t.consumes?.length ? `<- ${t.consumes.join(", ")}` : "",
      t.produces?.length ? `-> ${t.produces.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(
      `    ${t.id} [${t.kind}/${t.project}/${t.lane}/${t.complexity}] ${t.title}  ${flow}`,
    );
  }
  const order = topoOrder(
    ev.plan.tasks.map((t) => t.id),
    deriveEdges(ev.plan.tasks).edges,
  );
  console.log(
    `    order: ${order.ok ? order.order.join(" -> ") : `cycle ${order.cycle.join(" -> ")}`}`,
  );
}

await mkdir(outDir, { recursive: true });
console.log(
  `planner prototype: ${briefName}, ${runs} run(s), model ${values.model}/${values.thinking}`,
);
console.log(`brief_hash ${hash}`);

const failedGates = (ev: Evaluation): GateResult[] => {
  const failed = ev.gates.filter((g) => g.verdict === "fail");
  if (ev.error)
    failed.unshift({
      gate: "plan_schema",
      verdict: "fail",
      reason: "the answer is not a valid Plan",
      evidence: [ev.error],
    });
  return failed;
};

/** One correction for an invalid answer: its output and gate evidence go back to the planner. */
async function correct(
  run: number,
  first: Omit<RunRecord, "run">,
  label: string,
): Promise<CorrectionRecord> {
  let call: Omit<RunRecord, "run">;
  try {
    call = await callPlanner({
      feedback: failedGates(first.evaluation),
      previousOutput: first.output,
    });
  } catch (e) {
    const error = `planner call failed: ${e}`;
    call = {
      model: values.model,
      duration_ms: 0,
      output: error,
      evaluation: { valid: false, failures: ["json_parse"], error, gates: [] },
    };
  }
  const record = { run, ...call };
  console.log(`\n-- ${label}`);
  printRun(record);
  await Bun.write(
    join(outDir, `run-${run}-${label.replace(/\W+/g, "-")}.json`),
    JSON.stringify(record, null, 2),
  );
  const before = new Set(first.evaluation.failures);
  const after = new Set(call.evaluation.failures);
  return {
    first: answerOutcome(first.evaluation),
    second: answerOutcome(call.evaluation),
    fixed: [...before].filter((f) => !after.has(f)),
    introduced: [...after].filter((f) => !before.has(f)),
  };
}

/** Known faults, each a plan edit the gates must catch. First one that breaks the plan wins. */
const FAULTS: { name: string; apply: (plan: Plan) => Plan }[] = [
  {
    name: "drop_consumes",
    apply: (p) => ({
      ...p,
      tasks: p.tasks.map((t) => (t.kind === "implement" ? { ...t, consumes: [] } : t)),
    }),
  },
  {
    name: "uncover_criterion",
    apply: (p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t, covers: t.covers.slice(1) })) }),
  },
  { name: "drop_tasks", apply: (p) => ({ ...p, tasks: p.tasks.slice(0, 1) }) },
];

async function seedFault(plan: Plan): Promise<(CorrectionRecord & { fault: string }) | undefined> {
  const ctx = {
    brief,
    workspace,
    limits: DEFAULT_LIMITS,
    projectGates,
    ...(files ? { files } : {}),
  };
  for (const fault of FAULTS) {
    const output = JSON.stringify(fault.apply(plan));
    const evaluation = evaluatePlannerOutput(output, ctx, hash);
    if (evaluation.valid) continue;
    const record = await correct(
      0,
      { model: values.model, duration_ms: 0, output, evaluation },
      `seeded ${fault.name}`,
    );
    return { ...record, first: "invalid", fault: fault.name };
  }
  return undefined;
}

const records: RunRecord[] = [];
const corrections: CorrectionRecord[] = [];
const seededRecords: (CorrectionRecord & { fault: string })[] = [];
for (let run = 1; run <= runs; run++) {
  let call: Omit<RunRecord, "run">;
  try {
    call = await callPlanner();
  } catch (e) {
    const error = `planner call failed: ${e}`;
    call = {
      model: values.model,
      duration_ms: 0,
      output: error,
      evaluation: { valid: false, failures: ["json_parse"], error, gates: [] },
    };
  }
  const record = { run, ...call };
  records.push(record);
  printRun(record);
  await Bun.write(join(outDir, `run-${run}.json`), JSON.stringify(record, null, 2));

  if (values.correct && !call.evaluation.valid && !call.evaluation.escalate) {
    const fixedRecord = await correct(run, call, `run ${run} correction`);
    corrections.push(fixedRecord);
  } else if (values.correct) {
    corrections.push({ first: answerOutcome(call.evaluation) });
  }
  if (values["seed-faults"] && call.evaluation.plan && call.evaluation.valid) {
    const seeded = await seedFault(call.evaluation.plan);
    if (seeded) seededRecords.push(seeded);
  }
}

const valid = records.filter((r) => r.evaluation.valid).length;
const escalated = records.filter((r) => r.evaluation.escalate).length;
const histogram: Record<string, number> = {};
for (const r of records) {
  for (const f of r.evaluation.failures) histogram[f] = (histogram[f] ?? 0) + 1;
}
const bumps = records.flatMap(
  (r) =>
    (r.evaluation.gates.find((g) => g.gate === "complexity_sanity") as ComplexityResult)?.bumps ??
    [],
);
const summary = {
  brief: briefName,
  brief_hash: hash,
  model: values.model,
  thinking: values.thinking,
  prompt: resolve(values.prompt ?? PLANNER_PROMPT),
  runs,
  valid,
  validity_rate: runs ? valid / runs : 0,
  escalated,
  failures_by_gate: Object.fromEntries(Object.entries(histogram).sort(([, a], [, b]) => b - a)),
  complexity_bumps: bumps.length,
  tasks_per_plan: records.map((r) => r.evaluation.plan?.tasks.length ?? null),
  tokens: records.reduce(
    (n, r) =>
      n + (r.usage ? r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write : 0),
    0,
  ),
  duration_ms: records.reduce((n, r) => n + r.duration_ms, 0),
  ...(values.correct ? { correction: correctionStats(corrections) } : {}),
  ...(values["seed-faults"]
    ? {
        seeded_faults: {
          ...correctionStats(seededRecords),
          faults: seededRecords.map((r) => `${r.fault}: ${r.second}`),
        },
      }
    : {}),
};
await Bun.write(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(
  `\n== ${briefName}: ${valid}/${runs} valid on first try (${Math.round(summary.validity_rate * 100)}%)`,
);
console.log(`   escalated: ${escalated}`);
const pct = (n: number | null) => (n === null ? "n/a" : `${Math.round(n * 100)}%`);
if (summary.correction) {
  const c = summary.correction;
  console.log(
    `   first-try ${pct(c.first_try_validity)}, second-try ${pct(c.second_try_validity)} (${c.second_try_valid}/${c.first_try_failures} failures fixed), overall ${pct(c.overall_validity)}`,
  );
}
if (summary.seeded_faults) {
  const c = summary.seeded_faults;
  console.log(
    `   seeded faults (mechanism test, not the natural rate): ${c.second_try_valid}/${c.first_try_failures} fixed by one correction`,
  );
}
for (const [gate, n] of Object.entries(summary.failures_by_gate))
  console.log(`   ${gate}: failed ${n}x`);
console.log(`   complexity bumps: ${bumps.length}`);
console.log(`   results: ${outDir}`);
process.exit(0);
