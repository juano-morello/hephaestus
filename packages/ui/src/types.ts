/** Mirror of `Dashboard` in packages/cli/src/output.ts (the UI does not import the CLI). A test in
 * packages/cli/test/ui-fixtures.test.ts keeps the fixtures, typed with this, in step with the
 * real schema. */
export type DashboardUnitPlan = {
  id: string;
  title: string;
  kind: string;
  project: string;
  depends_on: string[];
};

export type DashboardGate = {
  gate: string;
  verdict: string;
  reason: string;
  evidence: string[];
};

export type DashboardAttempt = {
  unit_id: string;
  attempt: number;
  status: string;
  model?: string;
  provider?: string;
  outcome?: string;
  duration_ms?: number;
  gates: DashboardGate[];
};

export type DashboardUnit = {
  unit_id: string;
  status: string;
  attempts: number;
  in_plan: boolean;
};

export type Dashboard = {
  schema: 1;
  run: { run_id: string; status: string; [k: string]: unknown };
  plan_approved: boolean;
  plan: { units: DashboardUnitPlan[] };
  units: DashboardUnit[];
  attempts: DashboardAttempt[];
  pauses: string[];
  stack_on?: { run_id: string; status: string };
  usage: { provider: string; model: string; [k: string]: unknown }[];
  stale?: string;
};

/** Mirror of `DiffSummary` in packages/cli/src/output.ts: file names and counts, never diff text. */
export type DiffFile = {
  path: string;
  added: number;
  removed: number;
  binary?: true;
  renamed_from?: string;
};

export type DiffSummary = {
  schema: 1;
  run_id: string;
  units: {
    unit_id: string;
    project: string;
    attempt?: number;
    status: "ok" | "unavailable";
    partial?: boolean;
    files: DiffFile[];
    added: number;
    removed: number;
  }[];
  projects: { project: string; files: number; added: number; removed: number }[];
  stale?: string;
};

/** Mirror of `PlanDetail` in packages/cli/src/output.ts. */
export type PlanDetail = {
  schema: 1;
  run_id: string;
  plan_id: string;
  approved: boolean;
  tasks: {
    id: string;
    title: string;
    kind: string;
    project: string;
    lane: string;
    complexity: string;
    complexity_reason: string;
    scope: string[];
    creates: string[];
    covers: string[];
    produces: string[];
    consumes: string[];
    spec: string;
  }[];
  risks: string[];
  criteria: {
    id: string;
    text: string;
    kind: string;
    check?: string;
    projects?: string[];
    covered_by: string[];
  }[];
  stale?: string;
};

/** Mirror of `RunCharts` in packages/cli/src/output.ts. */
export type RunCharts = {
  schema: 1;
  run_id: string;
  units: {
    unit_id: string;
    attempts: {
      attempt: number;
      outcome?: string;
      tier?: string;
      model?: string;
      role?: string;
      input: number;
      output: number;
      duration_ms?: number;
    }[];
  }[];
  tokens: {
    model: string;
    role: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  }[];
  escalations: number;
  stalls: number;
  stale?: string;
};

/** Mirror of `Overview` in packages/cli/src/output.ts. */
export type Overview = {
  schema: 1;
  runs: { status: string; count: number }[];
  tokens: {
    model: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  }[];
  escalations: number;
  stalls: number;
};
