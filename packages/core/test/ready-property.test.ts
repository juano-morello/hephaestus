import { describe, expect, test } from "bun:test";
import { runPlanGates } from "../src/gates/plan.ts";
import { DEFAULT_LIMITS, type GateContext } from "../src/gates/types.ts";
import { deriveEdges, topoOrder } from "../src/graph/edges.ts";
import { readyUnits } from "../src/graph/ready.ts";
import type { Plan, Task } from "../src/schemas/plan.ts";
import { brief, gates, plan, task, workspace } from "./helpers.ts";

/** The plan's criteria are the brief's. */
const ctx = (p: Plan): GateContext => ({
  brief: brief({
    acceptance: [...new Set(p.tasks.flatMap((x) => x.covers))].map((id) => ({
      id,
      text: id,
      kind: "behavior" as const,
    })),
  }),
  workspace: workspace(),
  limits: DEFAULT_LIMITS,
  projectGates: gates(),
});

const t = (id: string, o: Partial<Task> = {}) =>
  task(id, { scope: [`${id.toLowerCase()}.go`], ...o });
const test_ = (id: string, covers: string[], o: Partial<Task> = {}) =>
  t(id, { kind: "test", covers, scope: [`${id.toLowerCase()}_test.go`], ...o });

/** Plans the plan gates accept (checked below), with the shapes that broke the scheduler. */
const plans: Record<string, Plan> = {
  // Found live: two independent chains in one project.
  live: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    t("T2", { covers: ["AC1"], consumes: ["test:a"] }),
    test_("T3", ["AC2"], { produces: ["test:b"] }),
    t("T4", { covers: ["AC2"], consumes: ["test:b"] }),
  ]),
  // Review case A: one implementation, two locked tests.
  oneImplTwoTests: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    test_("T2", ["AC2"], { produces: ["test:b"] }),
    t("T3", { covers: ["AC1", "AC2"], consumes: ["test:a", "test:b"] }),
  ]),
  // Review case B: two tests of one criterion.
  twoTestsOneCriterion: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    test_("T2", ["AC1"], { produces: ["test:b"] }),
    t("T3", { covers: ["AC1"], consumes: ["test:a", "test:b"] }),
  ]),
  // Review case C: chained tests.
  chainedTests: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    test_("T2", ["AC2"], { consumes: ["test:a"], produces: ["test:b"] }),
    t("T3", { covers: ["AC1", "AC2"], consumes: ["test:b"] }),
  ]),
  // A third test of an already-tested criterion that the implementation does not consume: run in
  // the sequential order it is red; if the implementation ran first it would already pass.
  extraUnconsumedTest: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    test_("T2", ["AC2"], { produces: ["test:b"] }),
    test_("T3", ["AC2"]),
    t("T4", { covers: ["AC1", "AC2"], consumes: ["test:a", "test:b"] }),
  ]),
  // Server and client chains, plus two independent server implementations.
  crossProject: plan([
    test_("T1", ["AC1"], { produces: ["test:s"] }),
    t("T2", { covers: ["AC1"], consumes: ["test:s"] }),
    test_("T3", ["AC2"], { project: "client", produces: ["test:c"] }),
    t("T4", { project: "client", covers: ["AC2"], consumes: ["test:c"] }),
    t("T5", { covers: ["AC1"], consumes: ["test:s"] }),
    test_("T6", ["AC3"], { project: "client", produces: ["test:c3"] }),
    t("T7", { project: "client", covers: ["AC3"], consumes: ["test:c3"] }),
  ]),
  // Interleaved chains in one project, plan order not grouped by chain.
  interleaved: plan([
    test_("T1", ["AC1"], { produces: ["test:a"] }),
    test_("T2", ["AC2"], { produces: ["test:b"] }),
    t("T3", { covers: ["AC1", "AC2"], consumes: ["test:a", "test:b"] }),
    test_("T4", ["AC3"], { produces: ["test:c"] }),
    t("T5", { covers: ["AC3"], consumes: ["test:c"] }),
    t("T6", { covers: ["AC1"], consumes: ["test:a"] }),
  ]),
};

const canonical = (p: Plan) => {
  const r = topoOrder(
    p.tasks.map((x) => x.id),
    deriveEdges(p.tasks).edges,
  );
  if (!r.ok) throw new Error("cycle");
  return r.order;
};

/** Runs the scheduler to the end, accepting the oldest (or youngest) in-flight unit each step. */
function simulate(p: Plan, free: number, pick: "oldest" | "youngest") {
  const byId = new Map(p.tasks.map((x) => [x.id, x]));
  const accepted = new Set<string>();
  const inFlight: string[] = [];
  const started: string[] = [];
  const problems: string[] = [];
  for (let step = 0; step < 100 && accepted.size < p.tasks.length; step++) {
    const ready = readyUnits(
      p,
      workspace(),
      { accepted, inFlight: new Set(inFlight), scopeOf: (id) => byId.get(id)?.scope ?? [] },
      free - inFlight.length,
    );
    inFlight.push(...ready);
    started.push(...ready);
    for (const project of new Set(inFlight.map((id) => byId.get(id)?.project))) {
      const mine = inFlight.filter((id) => byId.get(id)?.project === project);
      if (mine.length > 1 && mine.some((id) => byId.get(id)?.kind === "test"))
        problems.push(`a test unit in flight with others of ${project}: ${mine.join(", ")}`);
    }
    if (inFlight.length === 0) {
      problems.push(`no progress after ${[...accepted].join(", ")}`);
      break;
    }
    const done = pick === "oldest" ? inFlight.shift() : inFlight.pop();
    if (done) accepted.add(done);
  }
  return { started, accepted, problems };
}

describe("readyUnits over plans the plan gates accept", () => {
  for (const [name, p] of Object.entries(plans)) {
    test(`${name} passes the plan gates`, () => {
      const failed = runPlanGates(p, ctx(p)).filter((g) => g.verdict !== "pass");
      expect(failed.map((g) => `${g.gate}: ${g.evidence.join("; ")}`)).toEqual([]);
    });
    for (const free of [1, 2, 3])
      for (const pick of ["oldest", "youngest"] as const)
        test(`${name} finishes at free=${free}, accepting the ${pick} first`, () => {
          const r = simulate(p, free, pick);
          expect(r.problems).toEqual([]);
          expect(r.accepted.size).toBe(p.tasks.length);
          if (free === 1) expect(r.started).toEqual(canonical(p));
        });
  }
});
