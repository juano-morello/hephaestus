// Step 0 planner prototype (SPEC section 19): run the planner N times on one Brief through OMP
// and measure how often its first answer passes every plan gate.
//
//   bun run packages/core/scripts/plan-proto.ts --brief <file> --workspace <file> [--runs N]
//     [--model opus] [--thinking high] [--prompt <file>] [--gates <file>] [--repo-maps <dir>]
//     [--out <dir>] [--workspace-root <dir>]
//
// --workspace-root points at the real repos (resolved like workspace.yaml's repo paths); the plan
// gates then check scopes against each project's tracked files.

import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CreateAgentSessionOptions,
  createAgentSession,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";
import { briefGate } from "../src/gates/brief.ts";
import type { ComplexityResult } from "../src/gates/plan.ts";
import { DEFAULT_LIMITS, type GateContext } from "../src/gates/types.ts";
import { deriveEdges, topoOrder } from "../src/graph/edges.ts";
import { type Evaluation, evaluatePlannerOutput } from "../src/planner/evaluate.ts";
import { Brief, briefHash } from "../src/schemas/brief.ts";
import { ProjectGates } from "../src/schemas/gates.ts";
import { Workspace } from "../src/schemas/workspace.ts";

type Thinking = CreateAgentSessionOptions["thinkingLevel"];

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

const promptPath = resolve(values.prompt ?? join(import.meta.dir, "..", "prompts", "planner.md"));
const template = await Bun.file(promptPath).text();
const prompt = template
  .replace("{{brief}}", JSON.stringify(brief, null, 2))
  .replace("{{workspace}}", workspaceFile.text.trim())
  .replace("{{project_gates}}", gatesFile.text.trim())
  .replace("{{repo_maps}}", repoMaps.join("\n\n"));

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

const ctx: GateContext = {
  brief,
  workspace,
  limits: DEFAULT_LIMITS,
  projectGates,
  ...(values["workspace-root"] ? { files: projectFiles(resolve(values["workspace-root"])) } : {}),
};

type Usage = { input: number; output: number; cacheRead: number; totalTokens: number };
type RunRecord = {
  run: number;
  model: string;
  duration_ms: number;
  usage?: Usage;
  stop_reason?: string;
  output: string;
  evaluation: Evaluation;
};

async function callPlanner(): Promise<Omit<RunRecord, "run" | "evaluation">> {
  const started = Date.now();
  const { session } = await createAgentSession({
    cwd: ROOT,
    modelPattern: values.model,
    thinkingLevel: values.thinking as Thinking,
    systemPrompt: ["You are the Hephaestus planner. You output one JSON object and nothing else."],
    toolNames: [],
    skills: [],
    contextFiles: [],
    enableMCP: false,
    enableLsp: false,
    disableExtensionDiscovery: true,
    sessionManager: SessionManager.inMemory(),
  });
  try {
    await session.prompt(prompt);
    const last = session.state.messages.findLast((m) => m.role === "assistant");
    const content = last && "content" in last && Array.isArray(last.content) ? last.content : [];
    const output = content
      .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
      .join("");
    const meta = (last ?? {}) as { usage?: Usage; stopReason?: string; errorMessage?: string };
    return {
      model: `${session.model?.provider}/${session.model?.id}`,
      duration_ms: Date.now() - started,
      ...(meta.usage ? { usage: meta.usage } : {}),
      ...(meta.stopReason ? { stop_reason: meta.stopReason } : {}),
      output: output || (meta.errorMessage ?? ""),
    };
  } finally {
    await session.dispose();
  }
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

const records: RunRecord[] = [];
for (let run = 1; run <= runs; run++) {
  let call: Omit<RunRecord, "run" | "evaluation">;
  try {
    call = await callPlanner();
  } catch (e) {
    call = { model: values.model, duration_ms: 0, output: `planner call failed: ${e}` };
  }
  const record = { run, ...call, evaluation: evaluatePlannerOutput(call.output, ctx, hash) };
  records.push(record);
  printRun(record);
  await Bun.write(join(outDir, `run-${run}.json`), JSON.stringify(record, null, 2));
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
  prompt: promptPath,
  runs,
  valid,
  validity_rate: runs ? valid / runs : 0,
  escalated,
  failures_by_gate: Object.fromEntries(Object.entries(histogram).sort(([, a], [, b]) => b - a)),
  complexity_bumps: bumps.length,
  tasks_per_plan: records.map((r) => r.evaluation.plan?.tasks.length ?? null),
  tokens: records.reduce((n, r) => n + (r.usage?.totalTokens ?? 0), 0),
  duration_ms: records.reduce((n, r) => n + r.duration_ms, 0),
};
await Bun.write(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log(
  `\n== ${briefName}: ${valid}/${runs} valid on first try (${Math.round(summary.validity_rate * 100)}%)`,
);
console.log(`   escalated: ${escalated}`);
for (const [gate, n] of Object.entries(summary.failures_by_gate))
  console.log(`   ${gate}: failed ${n}x`);
console.log(`   complexity bumps: ${bumps.length}`);
console.log(`   results: ${outDir}`);
process.exit(0);
