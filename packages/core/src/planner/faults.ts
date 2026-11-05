import type { Plan, Task } from "../schemas/plan.ts";

/**
 * Known planner mistakes, one per plan-gate failure type. Each takes a valid Plan and returns
 * the broken answer text; `expect` is the failure name the evaluation must report. Used by
 * `plan-proto --seed-faults` to exercise the correction edge on every kind of gate evidence.
 */
export type Fault = { name: string; expect: string; apply: (plan: Plan) => string };

const edit = (plan: Plan, fn: (p: Plan) => unknown) => JSON.stringify(fn(structuredClone(plan)));
const taskAt = (plan: Plan, i: number) => {
  const t = plan.tasks[i];
  if (!t) throw new Error(`fault needs task ${i}`);
  return t;
};
const firstOf = (plan: Plan, kind: string) => plan.tasks.findIndex((t) => t.kind === kind);

export const FAULTS: Fault[] = [
  {
    name: "unknown_project",
    expect: "projects_exist",
    apply: (p) =>
      edit(p, (x) => {
        taskAt(x, 0).project = "nope";
        return x;
      }),
  },
  {
    name: "uncover_criterion",
    expect: "criteria_covered",
    apply: (p) =>
      edit(p, (x) => {
        for (const t of x.tasks) t.covers = [];
        return x;
      }),
  },
  {
    name: "dangling_consume",
    expect: "consumes_resolve",
    apply: (p) =>
      edit(p, (x) => {
        const i = firstOf(x, "implement");
        taskAt(x, Math.max(i, 0)).consumes = ["test:DoesNotExist"];
        return x;
      }),
  },
  {
    name: "drop_consumes",
    expect: "test_precedes_implement",
    apply: (p) =>
      edit(p, (x) => {
        for (const t of x.tasks) if (t.kind === "implement") t.consumes = [];
        return x;
      }),
  },
  {
    name: "unbounded_scope",
    expect: "size_limits",
    apply: (p) =>
      edit(p, (x) => {
        taskAt(x, 0).scope = ["**"];
        return x;
      }),
  },
  {
    name: "migration_not_irreversible",
    expect: "migration_irreversible",
    apply: (p) =>
      edit(p, (x) => {
        const i = firstOf(x, "implement");
        const t = taskAt(x, Math.max(i, 0));
        t.kind = "migration";
        t.lane = "contained";
        return x;
      }),
  },
  {
    name: "missing_field",
    expect: "schema",
    apply: (p) =>
      edit(p, (x) => {
        delete (taskAt(x, 0) as Partial<Task>).spec;
        return x;
      }),
  },
  {
    name: "truncated_json",
    expect: "json_parse",
    apply: (p) => JSON.stringify(p).slice(0, Math.floor(JSON.stringify(p).length / 2)),
  },
];
