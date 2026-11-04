import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Plan } from "@hephaestus/core";
import { type LedgerEvent, validateEvent } from "../src/events.ts";
import { openLedger } from "../src/ledger.ts";
import { tempDir } from "./helpers.ts";
import { plan, samples } from "./samples.ts";

const dir = tempDir();
const stamp = <T extends object>(d: T) => ({
  id: "01JBX0000000000000000000AA",
  ts: "2026-11-03T20:00:00.000Z",
  schema: 1,
  node_id: "devserver",
  ...d,
});

describe("events for the CLI", () => {
  test("run.created can carry the brief and the workspace root", () => {
    const brief = {
      schema: 1,
      goal: "g",
      context: "",
      decisions: [],
      constraints: [],
      acceptance: [{ id: "AC1", text: "t", kind: "behavior" }],
      out_of_scope: [],
      open_questions: [],
      source: "cli",
    };
    const e = stamp({
      ...samples["run.created"],
      data: { ...samples["run.created"].data, brief, workspace_root: "/w" },
    });
    expect(validateEvent(e)).toMatchObject({ ok: true });
  });

  test("approvals are human inputs with a target, and a plan approval names the plan", () => {
    const ok = (data: object) => validateEvent(stamp({ ...samples["human.input"], data })).ok;
    expect(ok({ kind: "approve", target: "plan", plan: "01JBX0000000000000000000AB" })).toBe(true);
    expect(ok({ kind: "approve", target: "merge" })).toBe(true);
    expect(ok({ kind: "approve" })).toBe(false);
    expect(ok({ kind: "approve", target: "plan" })).toBe(false);
    expect(ok({ kind: "hint", target: "plan" })).toBe(false);
  });
});

describe("ledger for the CLI", () => {
  test("a revised plan replaces the run's units", () => {
    const ledger = openLedger(dir(), { nodeId: "n" });
    ledger.appendMany([samples["run.created"], samples["run.plan_ready"]]);
    expect(ledger.units("R1").map((u) => u.unit_id)).toEqual(["T1", "T2"]);
    const revised: Plan = {
      ...plan,
      tasks: [{ ...(plan.tasks[0] as Plan["tasks"][number]), id: "T9" }],
    };
    ledger.append({ ...samples["run.plan_ready"], data: { plan: revised } });
    expect(ledger.units("R1").map((u) => u.unit_id)).toEqual(["T9"]);
    ledger.close();
  });

  test("onAppend sees every committed batch, and nothing from a failed one", () => {
    const seen: string[][] = [];
    const ledger = openLedger(join(dir(), "l"), {
      nodeId: "n",
      onAppend: (events: LedgerEvent[]) => seen.push(events.map((e) => e.type)),
    });
    ledger.appendMany([samples["run.created"], samples["run.plan_ready"]]);
    expect(() =>
      ledger.append({ ...samples["run.finished"], data: { nope: 1 } } as never),
    ).toThrow();
    ledger.append(samples["run.finished"]);
    expect(seen).toEqual([["run.created", "run.plan_ready"], ["run.finished"]]);
    ledger.close();
  });
});
