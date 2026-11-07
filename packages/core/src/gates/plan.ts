import { deriveEdges, reachability, topoOrder } from "../graph/edges.ts";
import type { Complexity, Plan, Task } from "../schemas/plan.ts";
import { globsOverlap } from "./glob.ts";
import { closestNames } from "./names.ts";
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
      if (c.projects?.length) {
        for (const p of new Set(c.projects)) {
          if (!tests.some((t) => t.project === p && t.covers.includes(c.id))) {
            evidence.push(`${c.id}: no test task in project ${p} covers it`);
          }
        }
      } else if (!tests.some((t) => t.covers.includes(c.id))) {
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

export function testPrecedesImplement(plan: Plan, ctx: GateContext): GateResult {
  const { reach } = graph(plan);
  const gated = new Set(ctx.brief.acceptance.filter((c) => c.check).map((c) => c.id));
  const tests = plan.tasks.filter((t) => t.kind === "test");
  const evidence: string[] = [];

  for (const impl of plan.tasks.filter((t) => t.kind === "implement")) {
    if (impl.covers.length === 0) {
      evidence.push(`${impl.id}: implement task covers no criteria`);
      continue;
    }
    // Gate-checked criteria cannot lock an implementation; only test-checked ones count.
    const testable = impl.covers.filter((c) => !gated.has(c));
    if (testable.length === 0) {
      evidence.push(
        `${impl.id}: implement task covers only gate-checked criteria (${impl.covers.join(", ")}); it needs a test-checked criterion`,
      );
      continue;
    }
    // Strict (decided 2026-11-03): each test-checked criterion needs its own preceding test.
    const sameProject = tests.filter((t) => t.project === impl.project);
    const precedes = (t: (typeof tests)[number]) => reach.get(t.id)?.has(impl.id) === true;
    const uncovered = testable.filter((c) => !sameProject.some((t) => t.covers.includes(c)));
    if (uncovered.length) {
      evidence.push(
        `${impl.id}: no test task in project ${impl.project} covers ${uncovered.join(", ")}`,
      );
    }
    const unordered = testable.filter(
      (c) =>
        !uncovered.includes(c) && !sameProject.some((t) => t.covers.includes(c) && precedes(t)),
    );
    for (const t of sameProject) {
      const shared = t.covers.filter((c) => unordered.includes(c));
      if (!shared.length) continue;
      const hint = t.produces?.length
        ? `consume one of: ${t.produces.join(", ")}`
        : `${t.id} produces nothing to consume`;
      evidence.push(
        `${impl.id}: test ${t.id} covers ${shared.join(", ")} but does not precede it (${hint})`,
      );
    }
  }

  return result(
    "test_precedes_implement",
    evidence,
    "every implement task follows a matching test task",
    "implement tasks are not preceded by matching tests",
  );
}

const WILDCARD = /[*?[{]/;
const prefixOf = (projectPath: string | undefined) =>
  !projectPath || projectPath === "."
    ? ""
    : `${projectPath.replace(/^\.\//, "").replace(/\/$/, "")}/`;
const matches = (glob: string, files: string[]) => files.filter((f) => globsOverlap(glob, f));

/** An accepted test checking criteria (`missing`) that only remaining work covers. */
type Stale = { test: Task; missing: string[] };

/** Accepted tests in the candidate's project that check criteria no finished work covers yet. */
function staleTests(tasks: Task[], accepted: ReadonlySet<string>, candidate: Task): Stale[] {
  if (candidate.kind === "test") return [];
  const impl = tasks.filter((t) => t.kind !== "test");
  const finished = impl.filter((t) => accepted.has(t.id) || t.id === candidate.id);
  const later = impl.filter((t) => !accepted.has(t.id) && t.id !== candidate.id);
  const done = new Set(finished.flatMap((t) => t.covers));
  return tasks
    .filter((t) => t.kind === "test" && accepted.has(t.id) && t.project === candidate.project)
    .flatMap((test) => {
      const missing = test.covers.filter(
        (c) => !done.has(c) && later.some((u) => u.covers.includes(c)),
      );
      return missing.length ? [{ test, missing }] : [];
    });
}

/**
 * Every task must pass its project's tests: running `candidate` is fine only if each accepted test
 * in its project checks criteria that finished work (accepted tasks, plus the candidate) covers,
 * or that no remaining task covers.
 */
export function testsPassableAfter(
  tasks: Task[],
  accepted: ReadonlySet<string>,
  candidate: Task,
): boolean {
  return staleTests(tasks, accepted, candidate).length === 0;
}

/** Whether two repo-relative scope sets can touch the same file; roots are project paths. */
export function scopesOverlap(
  a: string[],
  b: string[],
  repoRootA: string,
  repoRootB: string,
): boolean {
  const [pa, pb] = [prefixOf(repoRootA), prefixOf(repoRootB)];
  return a.some((ga) => b.some((gb) => globsOverlap(pa + ga, pb + gb)));
}

/**
 * Every task must pass its project's tests, so a test task may only check what the tasks run by
 * then have done. A criterion tested early but covered by a later task fails every task between
 * them, however good their work. Order is the execution order (topological, plan order on ties).
 */
export function testsPassable(plan: Plan, _ctx: GateContext): GateResult {
  const { edges } = graph(plan);
  const order = topoOrder(ids(plan), edges);
  if (!order.ok) return result("tests_passable", [], "skipped: the plan has a cycle", "");
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const run = order.order.flatMap((id) => byId.get(id) ?? []);
  const evidence: string[] = [];
  const reported = new Set<string>();

  run.forEach((x, i) => {
    const accepted = new Set(run.slice(0, i).map((t) => t.id));
    for (const { test: t, missing: all } of staleTests(plan.tasks, accepted, x)) {
      const missing = all.filter((c) => !reported.has(`${t.id}:${c}`));
      if (!missing.length) continue;
      for (const c of missing) reported.add(`${t.id}:${c}`);
      const list = missing.join(", ");
      const later = run.slice(i + 1).filter((u) => u.kind !== "test");
      const by = later.filter((u) => u.covers.some((c) => missing.includes(c))).map((u) => u.id);
      evidence.push(
        `${x.id}: runs after test ${t.id}, which checks ${list}, but ${list} ${missing.length > 1 ? "are" : "is"} covered only by ${by.join(", ")}, which ${by.length > 1 ? "run" : "runs"} later. Every task must pass its project's tests, so cover ${list} in ${x.id} or earlier, or test ${list} in a test task after ${x.id}`,
      );
    }
  });

  return result(
    "tests_passable",
    evidence,
    "every task's tests check only work done by then",
    "a task must pass tests for work that runs after it",
  );
}

/**
 * Parallel tasks (no produces/consumes path between them) in the same repo must not share files.
 * Scopes are compared repo-relative, so projects with nested roots in one repo are covered too.
 * With the project's file list, globs that match existing files are compared on those files;
 * a glob that matches no file yet may create new ones, so it is compared as a glob.
 */
export function parallelScopesDisjoint(plan: Plan, ctx: GateContext): GateResult {
  const { reach } = graph(plan);
  const ordered = (a: Task, b: Task) => reach.get(a.id)?.has(b.id) || reach.get(b.id)?.has(a.id);
  const project = (t: Task) => ctx.workspace.projects[t.project];
  const repoOf = (t: Task) => project(t)?.repo ?? `project:${t.project}`;
  const evidence: string[] = [];

  plan.tasks.forEach((a, i) => {
    for (const b of plan.tasks.slice(i + 1)) {
      if (repoOf(a) !== repoOf(b) || ordered(a, b)) continue;
      const files = a.project === b.project ? ctx.files?.[a.project] : undefined;
      const [pa, pb] = [prefixOf(project(a)?.path), prefixOf(project(b)?.path)];
      for (const ga of a.scope) {
        for (const gb of b.scope) {
          if (files) {
            const [ma, mb] = [matches(ga, files), matches(gb, files)];
            const shared = ma.find((f) => mb.includes(f));
            if (shared) {
              evidence.push(`${a.id} x ${b.id}: ${ga} and ${gb} both match ${shared}`);
              continue;
            }
            if (ma.length && mb.length) continue;
          }
          if (scopesOverlap([ga], [gb], project(a)?.path ?? "", project(b)?.path ?? ""))
            evidence.push(`${a.id} x ${b.id}: ${pa + ga} overlaps ${pb + gb}`);
        }
      }
    }
  });

  return result(
    "parallel_scope_disjoint",
    evidence,
    "parallel tasks have disjoint scopes",
    "parallel tasks have overlapping scopes",
  );
}

/**
 * Scopes against the project's real files (needs `ctx.files`). A path or glob matching nothing is
 * new work: fine when its directory exists, when the task is a test task, or when its top-level
 * directory exists (a new subdirectory). Otherwise it is almost always a guess (a typo). Paths
 * leaving the project always fail. New files are listed in the evidence either way.
 */
export function scopePaths(plan: Plan, ctx: GateContext): GateResult {
  if (!ctx.files)
    return { gate: "scope_paths", verdict: "pass", reason: "skipped: no file list", evidence: [] };
  const failures: string[] = [];
  const notes: string[] = [];
  for (const t of plan.tasks) {
    const files = ctx.files[t.project] ?? [];
    const dirExists = (dir: string) => dir === "" || files.some((f) => f.startsWith(dir));
    const creates = new Set(t.creates ?? []);
    for (const c of creates) {
      if (c.startsWith("./")) continue; // reported below with the scope entries
      if (files.includes(c)) failures.push(`${t.id}: ${c} is in creates but already exists`);
      else if (!t.scope.some((g) => globsOverlap(g, c)))
        failures.push(`${t.id}: ${c} is in creates but outside the task scope`);
    }
    for (const g of [...t.scope, ...[...creates].filter((c) => !t.scope.includes(c))]) {
      if (g.startsWith("./")) {
        failures.push(`${t.id}: ${g} is not project-relative; drop the leading ./`);
        continue;
      }
      if (!t.scope.includes(g)) continue; // creates entries outside scope are already reported
      if (matches(g, files).length) continue;
      if (g.startsWith("/") || g.split("/").includes("..")) {
        failures.push(`${t.id}: ${g} leaves the project; scopes are project-relative`);
        continue;
      }
      const wild = g.search(WILDCARD);
      const dir =
        wild < 0
          ? g.includes("/")
            ? g.slice(0, g.lastIndexOf("/") + 1)
            : ""
          : g.slice(0, g.lastIndexOf("/", wild) + 1);
      if (wild < 0) {
        // A literal path that is not there must be declared as new, or it is a guess.
        if (creates.has(g)) notes.push(`${t.id}: new file ${g}`);
        else if (!dirExists(dir))
          failures.push(`${t.id}: ${g} is in a directory that does not exist (${dir})`);
        else {
          const near = closestNames(g, files);
          failures.push(
            `${t.id}: ${g} does not exist and is not in creates${near.length ? ` (closest existing: ${near.join(", ")})` : ""}`,
          );
        }
        continue;
      }
      // Globs: test tasks create their files and fixtures; others may add subdirectories to a real one.
      const top = g.includes("/") ? `${g.slice(0, g.indexOf("/"))}/` : "";
      const mayCreate = t.kind === "test" || dirExists(dir) || (top !== "" && dirExists(top));
      if (!mayCreate) failures.push(`${t.id}: ${g} matches no files and ${dir} does not exist`);
    }
  }
  return failures.length
    ? {
        gate: "scope_paths",
        verdict: "fail",
        reason: "scopes point at paths that do not exist or are not declared in creates",
        evidence: failures,
      }
    : { gate: "scope_paths", verdict: "pass", reason: "scopes match the repo", evidence: notes };
}

/**
 * A test task's outputs are locked for later implement tasks, so a wildcard scope entry that
 * matches existing files would lock all of them. Existing test files must be listed literally;
 * wildcards are for directories that have no files yet. Needs `ctx.files`.
 */
export function testScopeNarrow(plan: Plan, ctx: GateContext): GateResult {
  if (!ctx.files)
    return {
      gate: "test_scope_narrow",
      verdict: "pass",
      reason: "skipped: no file list",
      evidence: [],
    };
  const evidence: string[] = [];
  for (const t of plan.tasks) {
    if (t.kind !== "test") continue;
    const files = ctx.files[t.project] ?? [];
    for (const g of t.scope) {
      if (!WILDCARD.test(g)) continue;
      const hit = matches(g, files).sort();
      if (!hit.length) continue;
      const shown = hit.slice(0, 5).join(", ");
      const more = hit.length > 5 ? `, +${hit.length - 5} more` : "";
      evidence.push(
        `${t.id}: ${g} matches ${hit.length} existing file${hit.length === 1 ? "" : "s"} (${shown}${more}); list the files you change literally and declare new ones in creates`,
      );
    }
  }
  return result(
    "test_scope_narrow",
    evidence,
    "test scopes match no existing files by wildcard",
    "test scopes lock existing files by wildcard",
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
    testPrecedesImplement(plan, ctx),
    testsPassable(plan, ctx),
    parallelScopesDisjoint(plan, ctx),
    migrationIrreversible(plan),
    complexitySanity(plan, ctx),
    sizeLimits(plan, ctx),
    scopePaths(plan, ctx),
    testScopeNarrow(plan, ctx),
  ];
}
