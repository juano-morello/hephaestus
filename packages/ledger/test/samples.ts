import type { Plan } from "@hephaestus/core";
import type { EventDraft, EventType } from "../src/events.ts";

const base = { run_id: "R1", changeset_id: "C1", actor: "engine", config_hash: "cfg1" } as const;
const unit = { ...base, project: "server", unit_id: "T2", attempt: 1 } as const;
const attemptInfo = {
  role: "implementer",
  tier: "standard",
  model: "claude/sonnet",
  provider: "claude",
} as const;

export const plan: Plan = {
  schema: 1,
  brief_hash: "b".repeat(64),
  tasks: [
    {
      id: "T1",
      title: "tests",
      kind: "test",
      project: "server",
      lane: "contained",
      complexity: "standard",
      complexity_reason: "cases",
      scope: ["a_test.go"],
      covers: ["AC1"],
      produces: ["test:A"],
      spec: "write tests",
    },
    {
      id: "T2",
      title: "impl",
      kind: "implement",
      project: "server",
      lane: "contained",
      complexity: "standard",
      complexity_reason: "logic",
      scope: ["a.go"],
      covers: ["AC1"],
      consumes: ["test:A"],
      spec: "make tests pass",
    },
  ],
  risks: [],
};

/** One valid draft per v0 event type. */
export const samples: { [K in EventType]: EventDraft<K> } = {
  "run.created": {
    ...base,
    type: "run.created",
    data: { owner_node: "devserver", brief_hash: "b".repeat(64), eval: false },
  },
  "run.plan_ready": { ...base, type: "run.plan_ready", data: { plan } },
  "plan.answer": {
    ...base,
    type: "plan.answer",
    graph_node: "plan",
    data: { attempt: 1, outcome: "invalid", failures: ["criteria_covered"] },
  },
  "run.plan_escalated": {
    ...base,
    type: "run.plan_escalated",
    data: { reasons: ["AC2 is not checkable"] },
  },
  "run.paused": {
    ...base,
    type: "run.paused",
    data: { reason: "rate_limit", retry_after: "2026-11-03T21:00:00.000Z" },
  },
  "run.resumed": { ...base, type: "run.resumed", data: { reason: "rate_limit" } },
  "run.handed_off": { ...base, type: "run.handed_off", data: { to: "mbp" } },
  "run.adopted": {
    ...base,
    type: "run.adopted",
    data: { from: "devserver", reason: "unreachable" },
  },
  "run.finished": { ...base, type: "run.finished", data: {} },
  "run.failed": { ...base, type: "run.failed", data: { reason: "merge conflict" } },
  "node.started": { ...base, type: "node.started", graph_node: "build", data: {} },
  "node.finished": { ...base, type: "node.finished", graph_node: "build", data: { outcome: "ok" } },
  "unit.attempt.started": {
    ...unit,
    actor: "worker",
    type: "unit.attempt.started",
    data: attemptInfo,
  },
  "unit.attempt.finished": {
    ...unit,
    actor: "worker",
    type: "unit.attempt.finished",
    data: {
      ...attemptInfo,
      usage: { input: 1200, output: 800, cache_read: 9000, cache_write: 0 },
      duration_ms: 42_000,
      outcome: "green",
    },
  },
  "unit.attempt.interrupted": {
    ...unit,
    type: "unit.attempt.interrupted",
    data: { reason: "rate_limit" },
  },
  "gate.result": {
    ...unit,
    actor: "gate",
    type: "gate.result",
    data: { gate: "tests", verdict: "pass", reason: "all green", evidence: [] },
  },
  "unit.returned": {
    ...unit,
    type: "unit.returned",
    data: {
      schema: 1,
      unit_id: "T2",
      attempt: 1,
      verdict: "red",
      reasons: [{ gate: "tests", reason: "1 failed", evidence: ["a_test.go:12"] }],
      scope: ["a.go"],
      instruction: "fix only the listed failures; do not modify locked paths",
    },
  },
  "unit.accepted": { ...unit, type: "unit.accepted", data: {} },
  "unit.escalated": { ...unit, type: "unit.escalated", data: { reason: "blocked: test is wrong" } },
  "unit.stalled": {
    ...unit,
    type: "unit.stalled",
    data: {
      signature: "a1b2c3d4e5f6",
      attempts: [1, 2],
      failing: [{ gate: "tests", reason: "1 failed" }],
    },
  },
  "unit.needs_input": { ...unit, type: "unit.needs_input", data: { reason: "context ceiling" } },
  "merge.staged": { ...base, type: "merge.staged", data: { refs: { server: "a1b2c3d" } } },
  "merge.committed": { ...base, type: "merge.committed", data: { refs: { server: "a1b2c3d" } } },
  "merge.aborted": { ...base, type: "merge.aborted", data: { reason: "remote unreachable" } },
  "human.input": {
    ...base,
    actor: "human",
    type: "human.input",
    data: { kind: "hint", text: "use the fake clock" },
  },
  "effect.intended": {
    ...base,
    repo: "server",
    unit_id: "T2",
    attempt: 1,
    type: "effect.intended",
    data: {
      effect: "run_branch_advance",
      key: "run_branch_advance:server:T2:a1",
      target: "heph/R1",
      before: "a1b2c3d",
      after: "b2c3d4e",
    },
  },
  "effect.done": {
    ...base,
    repo: "server",
    type: "effect.done",
    data: {
      effect: "pr_open",
      key: "pr_open:server",
      state: "confirmed",
      url: "https://github.com/o/server/pull/7",
    },
  },
  "context.pack_built": {
    ...unit,
    type: "context.pack_built",
    data: { size_tokens: 18_000, truncated: ["repo_map"], expansions: 0 },
  },
};
