/** Typed fixture payloads shared by the view tests. */
export type RunRowFixture = {
  run_id: string;
  status: string;
  owner_node: string;
  stack_on?: string;
  created_at: string;
  updated_at: string;
};

export type StatusListFixture = { runs: RunRowFixture[] };

export const statusList: StatusListFixture = {
  runs: [
    {
      run_id: "r-old",
      status: "finished",
      owner_node: "n1",
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-01T11:00:00.000Z",
    },
    {
      run_id: "r-live",
      status: "running",
      owner_node: "n1",
      created_at: "2026-11-05T09:00:00.000Z",
      updated_at: "2026-11-05T09:30:00.000Z",
    },
    {
      run_id: "r/child 1",
      status: "paused",
      owner_node: "n1",
      stack_on: "r-live",
      created_at: "2026-11-04T09:00:00.000Z",
      updated_at: "2026-11-04T09:30:00.000Z",
    },
  ],
};

// ---- dashboard payloads (shape mirrors the daemon's `dashboard` method) ----

import type { Dashboard } from "../src/types.ts";

const row = (run_id: string, status: string, extra: Record<string, unknown> = {}) => ({
  run_id,
  status,
  owner_node: "n1",
  created_at: "2026-11-05T09:00:00.000Z",
  updated_at: "2026-11-05T09:30:00.000Z",
  ...extra,
});

const usage = [
  {
    provider: "anthropic",
    model: "sonnet",
    input: 1200,
    output: 340,
    cache_read: 0,
    cache_write: 0,
  },
];

/** Three units across two projects: api tests, api impl (running), web impl waiting on it. */
export const parallelRun: Dashboard = {
  schema: 1,
  run: row("r-par", "running"),
  plan_approved: true,
  plan: {
    units: [
      { id: "T1", title: "Test the add endpoint", kind: "test", project: "api", depends_on: [] },
      { id: "T2", title: "Implement add", kind: "impl", project: "api", depends_on: ["T1"] },
      { id: "T3", title: "Show the sum", kind: "impl", project: "web", depends_on: ["T2"] },
    ],
  },
  units: [
    { unit_id: "T1", status: "accepted", attempts: 1, in_plan: true },
    { unit_id: "T2", status: "running", attempts: 1, in_plan: true },
    { unit_id: "T3", status: "pending", attempts: 0, in_plan: true },
  ],
  attempts: [
    {
      unit_id: "T1",
      attempt: 1,
      status: "accepted",
      model: "sonnet",
      provider: "anthropic",
      outcome: "accepted",
      duration_ms: 4200,
      gates: [{ gate: "tests", verdict: "pass", reason: "all tests green", evidence: [] }],
    },
    { unit_id: "T2", attempt: 1, status: "running", gates: [] },
  ],
  pauses: [],
  usage,
};

const red = (n: number) => ({
  unit_id: "T2",
  attempt: n,
  status: "failed",
  model: "sonnet",
  provider: "anthropic",
  outcome: "gate failed",
  duration_ms: 9000,
  gates: [
    {
      gate: "tests",
      verdict: "fail",
      reason: "add.sh printed 0, expected 5",
      evidence: ["FAIL test_add.sh", "expected 5 got 0 <b>not html</b>"],
    },
  ],
});

/** A unit that failed the same way twice; the run paused. */
export const stalledRun: Dashboard = {
  schema: 1,
  run: row("r-stall", "paused"),
  plan_approved: true,
  plan: {
    units: [
      { id: "T1", title: "Test the add script", kind: "test", project: "api", depends_on: [] },
      { id: "T2", title: "Implement add", kind: "impl", project: "api", depends_on: ["T1"] },
    ],
  },
  units: [
    { unit_id: "T1", status: "accepted", attempts: 1, in_plan: true },
    { unit_id: "T2", status: "escalated", attempts: 2, in_plan: true },
  ],
  attempts: [
    {
      unit_id: "T1",
      attempt: 1,
      status: "accepted",
      gates: [{ gate: "tests", verdict: "pass", reason: "ok", evidence: [] }],
    },
    red(1),
    red(2),
  ],
  pauses: ["unit T2 stalled: two identical failures"],
  usage,
};

/** A child run staged on another run. */
export const stackedChild: Dashboard = {
  schema: 1,
  run: row("r/child 1", "paused", { stack_on: "r-par" }),
  plan_approved: false,
  plan: {
    units: [{ id: "C1", title: "Child work", kind: "impl", project: "api", depends_on: [] }],
  },
  units: [{ unit_id: "C1", status: "pending", attempts: 0, in_plan: true }],
  attempts: [],
  pauses: ["waiting for parent run r-par to land"],
  stack_on: { run_id: "r-par", status: "running" },
  usage: [],
  stale: "owner n2 unreachable",
};

/** A run that has no plan yet. */
export const noPlanRun: Dashboard = {
  schema: 1,
  run: row("r-new", "created"),
  plan_approved: false,
  plan: { units: [] },
  units: [],
  attempts: [],
  pauses: [],
  usage: [],
};

/** An earlier plan had X9; the latest plan dropped it. */
export const droppedUnitRun: Dashboard = {
  schema: 1,
  run: row("r-drop", "running"),
  plan_approved: true,
  plan: {
    units: [{ id: "A1", title: "Keep me", kind: "impl", project: "api", depends_on: [] }],
  },
  units: [
    { unit_id: "A1", status: "pending", attempts: 0, in_plan: true },
    { unit_id: "X9", status: "dropped", attempts: 1, in_plan: false },
  ],
  attempts: [
    {
      unit_id: "X9",
      attempt: 1,
      status: "failed",
      gates: [{ gate: "scope", verdict: "fail", reason: "touched too much", evidence: ["a.ts"] }],
    },
  ],
  pauses: [],
  usage: [],
};

/** Twelve units (the plan maximum) in a mix of shapes, for the layout and narrow-width tests. */
export const bigRun: Dashboard = {
  schema: 1,
  run: row("r-big", "running"),
  plan_approved: true,
  plan: {
    units: Array.from({ length: 12 }, (_, i) => ({
      id: `U${i + 1}`,
      title: `Unit number ${i + 1} with a rather long descriptive title`,
      kind: i % 2 ? "impl" : "test",
      project: i < 6 ? "api" : "web",
      depends_on: i === 0 ? [] : [`U${Math.ceil(i / 2)}`],
    })),
  },
  units: Array.from({ length: 12 }, (_, i) => ({
    unit_id: `U${i + 1}`,
    status: i === 0 ? "accepted" : i === 1 ? "running" : "pending",
    attempts: i < 2 ? 1 : 0,
    in_plan: true,
  })),
  attempts: [],
  pauses: [],
  usage: [],
};

export const dashboardFixtures = {
  parallelRun,
  stalledRun,
  stackedChild,
  noPlanRun,
  droppedUnitRun,
  bigRun,
};

// ---- read-view payloads (shape mirrors planDetail, diffSummary, runCharts, overview) ----

import type { DiffSummary } from "../src/types.ts";

export const diffSummaryOk: DiffSummary = {
  schema: 1,
  run_id: "r-live",
  units: [
    {
      unit_id: "T1",
      project: "calc",
      attempt: 1,
      status: "ok",
      files: [
        { path: "test_add.sh", added: 3, removed: 1 },
        { path: "lib/new-name.sh", added: 2, removed: 0, renamed_from: "lib/old-name.sh" },
        { path: "logo.png", added: 0, removed: 0, binary: true },
      ],
      added: 5,
      removed: 1,
    },
    {
      unit_id: "T2",
      project: "calc",
      attempt: 2,
      status: "ok",
      partial: true,
      files: [{ path: "add.sh", added: 1, removed: 0 }],
      added: 1,
      removed: 0,
    },
    { unit_id: "T3", project: "docs", status: "unavailable", files: [], added: 0, removed: 0 },
  ],
  projects: [
    { project: "calc", files: 4, added: 6, removed: 1 },
    { project: "docs", files: 0, added: 0, removed: 0 },
  ],
};

export const diffSummaryEmpty: DiffSummary = {
  schema: 1,
  run_id: "r-new",
  units: [],
  projects: [],
};

export const diffSummaryFixtures = { diffSummaryOk, diffSummaryEmpty };

import type { PlanDetail } from "../src/types.ts";

export const planDetailFull: PlanDetail = {
  schema: 1,
  run_id: "r-live",
  plan_id: "plan-1",
  approved: true,
  tasks: [
    {
      id: "T1",
      title: "Write the tests",
      kind: "test",
      project: "calc",
      lane: "contained",
      complexity: "standard",
      complexity_reason: "one new test file",
      scope: ["test_add.sh"],
      creates: ["test_add.sh"],
      covers: ["AC1"],
      produces: ["test:Add"],
      consumes: [],
      spec: "Write test_add.sh so it checks the sum.\nSecond line of the spec.",
    },
    {
      id: "T2",
      title: "Implement add",
      kind: "implement",
      project: "calc",
      lane: "contained",
      complexity: "trivial",
      complexity_reason: "one line",
      scope: ["add.sh"],
      creates: [],
      covers: ["AC1"],
      produces: [],
      consumes: ["test:Add"],
      spec: "Write add.sh.",
    },
  ],
  risks: ["POSIX sh differs between platforms"],
  criteria: [
    {
      id: "AC1",
      text: "sh add.sh 2 3 prints 5",
      kind: "behavior",
      projects: ["calc"],
      covered_by: ["T1", "T2"],
    },
    { id: "AC2", text: "stays POSIX", kind: "nonfunctional", check: "lint", covered_by: [] },
    { id: "AC3", text: "handles negatives", kind: "behavior", covered_by: [] },
  ],
};

export const planDetailEmpty: PlanDetail = {
  schema: 1,
  run_id: "r-new",
  plan_id: "plan-0",
  approved: false,
  tasks: [],
  risks: [],
  criteria: [],
};

export const planDetailFixtures = { planDetailFull, planDetailEmpty };
