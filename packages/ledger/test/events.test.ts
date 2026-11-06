import { describe, expect, test } from "bun:test";
import { EVENT_TYPES, parseStoredEvent, validateEvent } from "../src/events.ts";
import { samples } from "./samples.ts";

const stamp = <T extends object>(draft: T) => ({
  id: "01JBX0000000000000000000AA",
  ts: "2026-11-03T20:00:00.000Z",
  schema: 1,
  node_id: "devserver",
  ...draft,
});

describe("event schemas", () => {
  test("every v0 type from SPEC section 6 has a schema and a sample", () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual(Object.keys(samples).sort());
    expect(Object.keys(EVENT_TYPES)).toHaveLength(28);
  });

  for (const [type, draft] of Object.entries(samples)) {
    test(`${type} sample is valid`, () => {
      const result = validateEvent(stamp(draft));
      expect(result).toMatchObject({ ok: true });
    });
  }

  test("a run resumes after a crash; effects name a known kind and a final state", () => {
    expect(
      validateEvent(stamp({ ...samples["run.resumed"], data: { reason: "crash" } })),
    ).toMatchObject({ ok: true });
    const intended = samples["effect.intended"];
    expect(
      validateEvent(stamp({ ...intended, data: { ...intended.data, effect: "teleport" } })),
    ).toMatchObject({ ok: false });
    const done = samples["effect.done"];
    expect(validateEvent(stamp({ ...done, data: { ...done.data, state: "maybe" } }))).toMatchObject(
      { ok: false },
    );
    expect(
      validateEvent(stamp({ ...intended, data: { ...intended.data, after: "not-a-sha" } })),
    ).toMatchObject({ ok: false });
  });

  test("run.created round-trips stack_on and pr_retarget is a valid effect kind", () => {
    const created = samples["run.created"];
    const stacked = stamp({ ...created, data: { ...created.data, stack_on: "R0" } });
    expect(validateEvent(stacked)).toMatchObject({ ok: true });
    const parsed = parseStoredEvent(JSON.parse(JSON.stringify(stacked)));
    expect(parsed).toMatchObject({ known: true });
    expect(JSON.stringify(parsed)).toContain('"stack_on":"R0"');
    expect(
      validateEvent(stamp({ ...created, data: { ...created.data, stack_on: "" } })),
    ).toMatchObject({ ok: false });
    const intended = samples["effect.intended"];
    expect(
      validateEvent(stamp({ ...intended, data: { ...intended.data, effect: "pr_retarget" } })),
    ).toMatchObject({ ok: true });
  });

  test("a pr_retarget names the branch it points the pull request at; other effects a sha", () => {
    const intended = samples["effect.intended"];
    const at = (effect: string, after: string) =>
      validateEvent(stamp({ ...intended, data: { ...intended.data, effect, after } }));
    expect(at("pr_retarget", "main")).toMatchObject({ ok: true });
    expect(at("pr_retarget", "release/1.x")).toMatchObject({ ok: true });
    expect(at("push", "main")).toMatchObject({ ok: false });
    expect(at("push", "a".repeat(40))).toMatchObject({ ok: true });
  });

  test("rejects an unknown type on write", () => {
    const result = validateEvent(stamp({ ...samples["run.finished"], type: "run.exploded" }));
    expect(result).toEqual({ ok: false, issues: ['type: unknown event type "run.exploded"'] });
  });

  test("rejects extra data fields", () => {
    const e = stamp({ ...samples["run.finished"], data: { note: "x" } });
    expect(validateEvent(e)).toMatchObject({ ok: false });
  });

  test("rejects extra envelope fields and a missing config_hash", () => {
    expect(validateEvent({ ...stamp(samples["run.finished"]), priority: 1 })).toMatchObject({
      ok: false,
    });
    const { config_hash: _, ...noHash } = samples["run.finished"];
    expect(validateEvent(stamp(noHash))).toMatchObject({ ok: false });
  });

  test("enforces the envelope fields each type requires", () => {
    const { unit_id: _, ...noUnit } = samples["unit.attempt.started"];
    expect(validateEvent(stamp(noUnit))).toEqual({
      ok: false,
      issues: ["unit_id: required for unit.attempt.started"],
    });
    const { graph_node: __, ...noNode } = samples["node.started"];
    expect(validateEvent(stamp(noNode))).toEqual({
      ok: false,
      issues: ["graph_node: required for node.started"],
    });
  });

  test("a Return must match the envelope's unit and attempt", () => {
    const e = stamp({ ...samples["unit.returned"], unit_id: "T3", attempt: 2 });
    expect(validateEvent(e)).toEqual({
      ok: false,
      issues: [
        "data.unit_id: T2 does not match envelope unit_id T3",
        "data.attempt: 1 does not match envelope attempt 2",
      ],
    });
  });

  test("blob refs must be sha256 ids under known keys", () => {
    const sha = "a".repeat(64);
    const good = stamp({
      ...samples["unit.attempt.finished"],
      blobs: { transcript: sha, diff: sha },
    });
    expect(validateEvent(good)).toMatchObject({ ok: true });
    expect(validateEvent({ ...good, blobs: { transcript: "abc" } })).toMatchObject({ ok: false });
    expect(validateEvent({ ...good, blobs: { video: sha } })).toMatchObject({ ok: false });
  });

  test("reading tolerates unknown types from newer nodes", () => {
    const stored = parseStoredEvent(
      stamp({ ...samples["run.finished"], type: "run.teleported", data: { x: 1 } }),
    );
    expect(stored).toMatchObject({
      known: false,
      event: { type: "run.teleported", data: { x: 1 } },
    });
    expect(parseStoredEvent(stamp(samples["run.finished"]))).toMatchObject({ known: true });
  });

  test("reading still rejects a broken envelope", () => {
    const { run_id: _, ...noRun } = stamp(samples["run.finished"]);
    expect(() => parseStoredEvent(noRun)).toThrow("invalid stored event");
  });

  test("attempt events accept the top rung, the routing decision and fallback_for", () => {
    const base = samples["unit.attempt.started"];
    const withData = (extra: object) => stamp({ ...base, data: { ...base.data, ...extra } });
    expect(validateEvent(withData({ tier: "top" }))).toMatchObject({ ok: true });
    const routed = { tier: "complex", score: 7, planner_tier: "standard", reasons: ["wide diff"] };
    expect(validateEvent(withData({ routed, fallback_for: "claude/opus" }))).toMatchObject({
      ok: true,
    });
    const done = samples["unit.attempt.finished"];
    expect(
      validateEvent(stamp({ ...done, data: { ...done.data, tier: "top", routed } })),
    ).toMatchObject({ ok: true });
    expect(validateEvent(withData({ tier: "huge" }))).toMatchObject({ ok: false });
    expect(validateEvent(withData({ routed: { ...routed, tier: "top" } }))).toMatchObject({
      ok: false,
    });
  });
});
