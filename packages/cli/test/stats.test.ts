import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, openLedger } from "@hephaestus/ledger";
import { loadConfig } from "../src/config.ts";
import { type Io, run } from "../src/main.ts";
import { Stats } from "../src/output.ts";
import { openRuntime } from "../src/runtime.ts";
import { buildStats, classifyRun, FOOTER, parseSince } from "../src/stats.ts";

const ev = (type: string, data?: unknown) => ({ type, ...(data === undefined ? {} : { data }) });
const input = (kind: string, extra: object = {}) => ev("human.input", { kind, ...extra });
const PLAN = ev("run.plan_ready", { plan: {} });
const APPROVE = input("approve", { target: "plan" });

describe("classifyRun", () => {
  test("a staged run with one plan and only an approve input is clean", () => {
    const r = classifyRun({ status: "staged" }, [PLAN, APPROVE]);
    expect(r).toMatchObject({ class: "clean", reasons: [], hints: 0, replans: 0 });
  });
  test("a finished run is merge-ready", () => {
    expect(classifyRun({ status: "finished" }, [PLAN]).class).toBe("clean");
  });
  test("one hint makes it assisted", () => {
    const r = classifyRun({ status: "staged" }, [PLAN, input("hint", { text: "x" })]);
    expect(r).toMatchObject({ class: "assisted", hints: 1 });
    expect(r.reasons).toEqual(["1 hint"]);
  });
  test("budget_override and scope count as hints, plural reason", () => {
    const r = classifyRun({ status: "staged" }, [PLAN, input("budget_override"), input("scope")]);
    expect(r.hints).toBe(2);
    expect(r.reasons).toEqual(["2 hints"]);
  });
  test("two plans make it assisted: replanned", () => {
    const r = classifyRun({ status: "staged" }, [PLAN, PLAN]);
    expect(r).toMatchObject({ class: "assisted", replans: 1 });
    expect(r.reasons).toEqual(["replanned"]);
  });
  test("a plan_edit alone counts as a replan once", () => {
    const r = classifyRun({ status: "staged" }, [PLAN, input("plan_edit"), PLAN]);
    expect(r.replans).toBe(1);
  });
  test("an escalated unit or a stall makes it assisted", () => {
    const a = classifyRun({ status: "staged" }, [PLAN, ev("unit.escalated")]);
    expect(a).toMatchObject({ class: "assisted", escalations: 1 });
    expect(a.reasons).toEqual(["1 escalation"]);
    const b = classifyRun({ status: "staged" }, [PLAN, ev("unit.stalled")]);
    expect(b).toMatchObject({ class: "assisted", stalls: 1 });
    expect(b.reasons).toEqual(["1 stall"]);
  });
  test("built is open, as are created, planned, paused and running", () => {
    for (const status of ["built", "created", "planned", "paused", "running"])
      expect(classifyRun({ status }, [PLAN]).class).toBe("open");
  });
  test("a cancelled run did not merge", () => {
    const r = classifyRun({ status: "failed" }, [
      PLAN,
      ev("run.failed", { reason: "cancelled by user" }),
    ]);
    expect(r).toMatchObject({ class: "did_not_merge", reasons: ["cancelled"] });
  });
  test("a failed run did not merge", () => {
    const r = classifyRun({ status: "failed" }, [PLAN, ev("run.failed", { reason: "boom" })]);
    expect(r).toMatchObject({ class: "did_not_merge", reasons: ["failed"] });
  });
  test("an escalated run did not merge: planner escalated", () => {
    const r = classifyRun({ status: "escalated" }, []);
    expect(r).toMatchObject({ class: "did_not_merge", reasons: ["planner escalated"] });
  });
});

const row = (id: string, status: string, created_at: string, evalFlag = false) =>
  ({ run_id: id, status, created_at, eval: evalFlag }) as never;
const NOW = new Date("2026-11-07T00:00:00Z");
const SINCE = new Date("2026-10-10T00:00:00Z");
const inside = "2026-10-20T00:00:00.000Z";

describe("buildStats", () => {
  const events: Record<string, { type: string; data?: unknown }[]> = {
    c: [PLAN],
    a: [PLAN, input("hint"), ev("unit.stalled")],
    d: [PLAN, ev("run.failed", { reason: "x" })],
    o: [PLAN],
  };
  const eventsOf = (id: string) => events[id] ?? [];

  test("counts, rate and assisted totals over a mixed set", () => {
    const s = buildStats({
      runs: [
        row("c", "staged", inside),
        row("a", "finished", inside),
        row("d", "failed", inside),
        row("o", "built", inside),
      ],
      eventsOf,
      since: SINCE,
    });
    expect(s.counts).toEqual({ clean: 1, assisted: 1, did_not_merge: 1, open: 1 });
    expect(s.clean_rate).toBeCloseTo(1 / 3);
    expect(s.below_threshold).toBe(true);
    expect(s.assisted_totals).toEqual({ hints: 1, replans: 0, escalations: 0, stalls: 1 });
    expect(s.runs).toBeUndefined();
    expect(s.footer).toBe(FOOTER);
    expect(Stats.parse(s)).toBeDefined();
  });
  test("eval runs and runs before since are excluded; a run exactly at since is in", () => {
    const s = buildStats({
      runs: [
        row("c", "staged", inside, true),
        row("a", "staged", "2026-10-09T23:59:59.999Z"),
        row("d", "failed", SINCE.toISOString()),
      ],
      eventsOf,
      since: SINCE,
    });
    expect(s.counts).toEqual({ clean: 0, assisted: 0, did_not_merge: 1, open: 0 });
  });
  test("only open runs: null rate and null threshold", () => {
    const s = buildStats({ runs: [row("o", "built", inside)], eventsOf, since: SINCE });
    expect(s.clean_rate).toBeNull();
    expect(s.below_threshold).toBeNull();
  });
  test("below_threshold is true at 0.4 and false at 0.5", () => {
    const mk = (clean: number, bad: number) =>
      buildStats({
        runs: [
          ...Array.from({ length: clean }, (_, i) => row(`c${i}`, "staged", inside)),
          ...Array.from({ length: bad }, (_, i) => row(`d${i}`, "failed", inside)),
        ],
        eventsOf: (id) => (id.startsWith("c") ? [PLAN] : [PLAN, ev("run.failed", { reason: "x" })]),
        since: SINCE,
      });
    expect(mk(2, 3)).toMatchObject({ clean_rate: 0.4, below_threshold: true });
    expect(mk(1, 1)).toMatchObject({ clean_rate: 0.5, below_threshold: false });
  });
  test("list adds one entry per counted run", () => {
    const s = buildStats({
      runs: [row("c", "staged", inside), row("a", "staged", inside)],
      eventsOf,
      since: SINCE,
      list: true,
    });
    expect(s.runs).toEqual([
      { run_id: "c", status: "staged", class: "clean", reasons: [] },
      { run_id: "a", status: "staged", class: "assisted", reasons: ["1 hint", "1 stall"] },
    ]);
  });
});

describe("parseSince", () => {
  test("Nd is N days before now", () => {
    expect(parseSince("28d", NOW).toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });
  test("an ISO date", () => {
    expect(parseSince("2026-10-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
  test("anything else throws", () => {
    expect(() => parseSince("lately")).toThrow("--since takes <N>d or a date");
    expect(() => parseSince("")).toThrow("--since takes <N>d or a date");
  });
});

let root: string;
let ws: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-stats-"));
  ws = join(root, "calc");
  home = join(root, "home");
  mkdirSync(ws, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "node: { id: test-node }\nsandbox: { mode: native }\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base = (run_id: string) => ({ run_id, changeset_id: run_id, config_hash: "cfg" }) as const;
const created = (run_id: string, evalFlag = false): EventDraft => ({
  ...base(run_id),
  actor: "engine",
  type: "run.created",
  data: { owner_node: "test-node", brief_hash: "b".repeat(64), eval: evalFlag },
});
const failed = (run_id: string, reason: string): EventDraft => ({
  ...base(run_id),
  actor: "engine",
  type: "run.failed",
  data: { reason },
});
const escalatedRun = (run_id: string): EventDraft => ({
  ...base(run_id),
  actor: "engine",
  type: "run.plan_escalated",
  data: { reasons: ["x"] },
});
function seed(drafts: EventDraft[]) {
  const ledger = openLedger(home, { nodeId: "test-node" });
  ledger.appendMany(drafts);
  ledger.close();
}
const SEEDED = () =>
  seed([
    created("S1"),
    failed("S1", "cancelled by user"),
    created("S2"),
    escalatedRun("S2"),
    created("S3"),
    created("S4", true),
    failed("S4", "x"),
  ]);

describe("Runtime.stats", () => {
  test("reads the ledger: eval runs excluded, default window 28d", async () => {
    SEEDED();
    const loaded = await loadConfig({ workspaceDir: ws, home, nodeId: "test-node" });
    const rt = openRuntime({ loaded, workspaceDir: ws, home });
    const s = rt.stats({ list: true });
    expect(s.counts).toEqual({ clean: 0, assisted: 0, did_not_merge: 2, open: 1 });
    expect(s.runs?.map((r) => [r.run_id, r.reasons])).toEqual([
      ["S1", ["cancelled"]],
      ["S2", ["planner escalated"]],
      ["S3", []],
    ]);
    expect(Stats.parse(s)).toBeDefined();
    // A window that starts after every run has nothing.
    expect(rt.stats({ since: "2999-01-01" }).counts).toEqual({
      clean: 0,
      assisted: 0,
      did_not_merge: 0,
      open: 0,
    });
    rt.close();
  });
});

async function heph(args: string[]) {
  let out = "";
  const io: Io = {
    cwd: ws,
    env: { HEPH_HOME: home },
    stdout: (s) => {
      out += s;
    },
    stderr: () => {},
  };
  const code = await run(args, io);
  return { out, code };
}

describe("heph stats", () => {
  test("--json envelope carries the stats and the footer", async () => {
    SEEDED();
    const { out, code } = await heph(["stats", "--json", "--list"]);
    expect(code).toBe(0);
    const env = JSON.parse(out);
    expect(env).toMatchObject({ schema: 1, command: "stats", ok: true });
    expect(env.data.footer).toBe(FOOTER);
    expect(env.data.counts.did_not_merge).toBe(2);
    expect(env.data.runs).toHaveLength(3);
  });
  test("human output: counts, percentage with the 50% line, list lines, footer", async () => {
    SEEDED();
    const { out } = await heph(["stats", "--list"]);
    expect(out).toContain("below the SPEC's 50% line");
    expect(out).toContain("0%");
    expect(out).toContain("S1  did_not_merge  cancelled");
    expect(out).toContain("S2  did_not_merge  planner escalated");
    expect(out).toContain(FOOTER);
  });
  test("an empty ledger prints n/a and the footer", async () => {
    const { out } = await heph(["stats"]);
    expect(out).toContain("n/a");
    expect(out).toContain(FOOTER);
  });
  test("a bad --since is an error", async () => {
    const { out, code } = await heph(["stats", "--since", "soon", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(out).error.message).toBe("--since takes <N>d or a date");
  });
  test("usage lists stats", async () => {
    const { out } = await heph(["help"]);
    expect(out).toContain("stats [--since");
  });
});
