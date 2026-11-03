import { deriveEdges, reachability, topoOrder } from "../graph/edges.ts";
import type { Complexity, Plan, Task } from "../schemas/plan.ts";
import { globsOverlap } from "./glob.ts";
import { type GateContext, type GateResult, result } from "./types.ts";

const ids = (plan: Plan) => plan.tasks.map((t) => t.id);

function graph(plan: Plan) {
  const derived = deriveEdges(plan.tasks);
  return { ...derived, reach: reachability(ids(plan), derived.edges) };
}

export function projectsExist(plan: Plan, ctx: GateContext): GateResult {
  const evidence = plan.tasks
    .filter((t) => !(t.project in ctx.workspace.projects))
    .map((t) => `${t.id}: project "${t.project}" is not in the workspace`);
  return result(
    "projects_exist",
    evidence,
    "every task targets a workspace project",
    "tasks target unknown projects",
  );
}

export function criteriaCovered(plan: Plan, ctx: GateContext): GateResult {
  const criteria = new Map(ctx.brief.acceptance.map((c) => [c.id, c]));
  const tests = plan.tasks.filter((t) => t.kind === "test");
  const evidence: string[] = [];
  for (const c of ctx.brief.acceptance) {
    if (!c.check) {
      if (!tests.some((t) => t.covers.includes(c.id))) {
        evidence.push(`${c.id}: no test task covers it`);
      }
      continue;
    }
    const gate = c.check.gate;
    const covered = plan.tasks.some(
      (t) => t.covers.includes(c.id) && ctx.projectGates[t.project]?.includes(gate),
    );
    if (!covered) {
      evidence.push(
        `${c.id}: checked by gate "${gate}" but no task in a project with that gate covers it`,
      );
    }
  }
  for (const t of plan.tasks) {
    for (const id of t.covers) {
      const c = criteria.get(id);
      if (!c) evidence.push(`${t.id}: covers unknown criterion "${id}"`);
      else if (c.check && t.kind === "test") {
        evidence.push(
          `${t.id}: test task covers ${id}, which is checked by gate "${c.check.gate}"`,
        );
      }
    }
  }
  return result(
    "criteria_covered",
    evidence,
    "every criterion is covered by its check",
    "criteria are not covered by their checks",
  );
}

export function consumesResolve(plan: Plan): GateResult {
  const { edges, unresolved, duplicateProducers } = deriveEdges(plan.tasks);
  const evidence = [
    ...unresolved.map((u) => `${u.task}: consumes "${u.artifact}" but no task produces it`),
    ...duplicateProducers.map((d) => `"${d.artifact}" is produced by ${d.tasks.join(", ")}`),
  ];
  const order = topoOrder(ids(plan), edges);
  if (!order.ok) evidence.push(`cycle: ${order.cycle.join(" -> ")}`);
  return result(
    "consumes_resolve",
    evidence,
    "every consumes resolves to one producer and the graph is acyclic",
    "derived graph is broken",
  );
}

export function testPrecedesImplement(plan: Plan): GateResult {
  const { reach } = graph(plan);
  const tests = plan.tasks.filter((t) => t.kind === "test");
  const evidence: string[] = [];

  for (const impl of plan.tasks.filter((t) => t.kind === "implement")) {
    if (impl.covers.length === 0) {
      evidence.push(`${impl.id}: implement task covers no criteria`);
      continue;
    }
    const matching = tests.filter(
      (t) => t.project === impl.project && t.covers.some((c) => impl.covers.includes(c)),
    );
    if (matching.length === 0) {
      evidence.push(
        `${impl.id}: no test task in project ${impl.project} covers ${impl.covers.join(", ")}`,
      );
      continue;
    }
    if (matching.some((t) => reach.get(t.id)?.has(impl.id))) continue;
    for (const t of matching) {
      const shared = t.covers.filter((c) => impl.covers.includes(c)).join(", ");
      const hint = t.produces?.length
        ? `consume one of: ${t.produces.join(", ")}`
        : `${t.id} produces nothing to consume`;
      evidence.push(`${impl.id}: test ${t.id} covers ${shared} but does not precede it (${hint})`);
    }
  }

  return result(
    "test_precedes_implement",
    evidence,
    "every implement task follows a matching test task",
    "implement tasks are not preceded by matching tests",
  );
}

export function parallelScopesDisjoint(plan: Plan): GateResult {
  const { reach } = graph(plan);
  const ordered = (a: Task, b: Task) => reach.get(a.id)?.has(b.id) || reach.get(b.id)?.has(a.id);
  const evidence: string[] = [];

  plan.tasks.forEach((a, i) => {
    for (const b of plan.tasks.slice(i + 1)) {
      if (a.project !== b.project || ordered(a, b)) continue;
      for (const ga of a.scope) {
        for (const gb of b.scope) {
          if (globsOverlap(ga, gb)) evidence.push(`${a.id} x ${b.id}: ${ga} overlaps ${gb}`);
        }
      }
    }
  });

  return result(
    "parallel_scope_disjoint",
    evidence,
    "parallel tasks in each project have disjoint scopes",
    "parallel tasks in the same project have overlapping scopes",
  );
}

export function migrationIrreversible(plan: Plan): GateResult {
  const evidence = plan.tasks
    .filter((t) => t.kind === "migration" && t.lane !== "irreversible")
    .map((t) => `${t.id}: migration must be lane irreversible, got "${t.lane}"`);
  return result(
    "migration_irreversible",
    evidence,
    "every migration is in lane irreversible",
    "migrations outside lane irreversible",
  );
}

const RANK: Record<Complexity, number> = { trivial: 0, standard: 1, complex: 2 };

export type ComplexityBump = { task: string; from: Complexity; to: Complexity };
export type ComplexityResult = GateResult & { bumps: ComplexityBump[] };

/** Never fails and never lowers a tier: it reports the tier code would run each task at. */
export function complexitySanity(plan: Plan, ctx: GateContext): ComplexityResult {
  const projectOf = new Map(plan.tasks.map((t) => [t.id, t.project]));
  const { edges } = deriveEdges(plan.tasks);
  const evidence: string[] = [];
  const bumps: ComplexityBump[] = [];

  for (const t of plan.tasks) {
    const required: [Complexity, string][] = [];
    if (t.lane !== "contained") required.push(["standard", `lane ${t.lane}`]);
    const foreign = edges.find((e) => e.to === t.id && projectOf.get(e.from) !== t.project);
    if (foreign) {
      required.push([
        "standard",
        `consumes ${foreign.artifact} from project ${projectOf.get(foreign.from)}`,
      ]);
    }
    if (t.scope.length > ctx.limits.complexScopeGlobs) {
      required.push(["complex", `${t.scope.length} scope globs > ${ctx.limits.complexScopeGlobs}`]);
    }

    const top = Math.max(RANK[t.complexity], ...required.map(([c]) => RANK[c]));
    if (top <= RANK[t.complexity]) continue;
    const reasons = required.filter(([c]) => RANK[c] === top).map(([, r]) => r);
    const to = required.find(([c]) => RANK[c] === top)?.[0] as Complexity;
    bumps.push({ task: t.id, from: t.complexity, to });
    evidence.push(`${t.id}: ${t.complexity} -> ${to} (${reasons.join("; ")})`);
  }

  return {
    gate: "complexity_sanity",
    verdict: "pass",
    reason: bumps.length ? `${bumps.length} task(s) bumped up` : "no bumps",
    evidence,
    bumps,
  };
}

const UNBOUNDED = new Set(["**", "**/*", "./**", "./**/*"]);

export function sizeLimits(plan: Plan, ctx: GateContext): GateResult {
  const { maxTasks, maxScopeGlobs } = ctx.limits;
  const evidence: string[] = [];
  if (plan.tasks.length > maxTasks) evidence.push(`${plan.tasks.length} tasks > limit ${maxTasks}`);
  for (const t of plan.tasks) {
    if (t.scope.length === 0) evidence.push(`${t.id}: empty scope`);
    if (t.scope.length > maxScopeGlobs) {
      evidence.push(`${t.id}: ${t.scope.length} scope globs > limit ${maxScopeGlobs}`);
    }
    for (const g of t.scope.filter((g) => UNBOUNDED.has(g))) {
      evidence.push(`${t.id}: unbounded scope "${g}"`);
    }
  }
  return result(
    "size_limits",
    evidence,
    "plan is within size limits",
    "plan is too big: replan or split the brief",
  );
}

export function runPlanGates(plan: Plan, ctx: GateContext): GateResult[] {
  return [
    projectsExist(plan, ctx),
    criteriaCovered(plan, ctx),
    consumesResolve(plan),
    testPrecedesImplement(plan),
    parallelScopesDisjoint(plan),
    migrationIrreversible(plan),
    complexitySanity(plan, ctx),
    sizeLimits(plan, ctx),
  ];
}
