import { describe, expect, test } from "bun:test";
import { briefGate } from "../src/gates/brief.ts";
import { brief, workspace } from "./helpers.ts";

describe("briefGate", () => {
  test("passes a complete brief", () => {
    const result = briefGate(brief(), workspace());
    expect(result).toMatchObject({ gate: "brief", verdict: "pass", evidence: [] });
  });

  test("fails on empty acceptance", () => {
    const result = briefGate(brief({ acceptance: [] }), workspace());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(["acceptance is empty"]);
  });

  test("fails on open questions and lists each one", () => {
    const b = brief({ open_questions: ["cap per type or global?", "persist caps?"] });
    const result = briefGate(b, workspace());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual([
      "open question: cap per type or global?",
      "open question: persist caps?",
    ]);
  });

  test("fails when known_paths names an unknown project", () => {
    const b = brief({ known_paths: [{ project: "mobile", paths: ["app/"] }] });
    const result = briefGate(b, workspace());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['known_paths project "mobile" is not in the workspace']);
  });

  test("fails on duplicate criterion ids", () => {
    const b = brief({
      acceptance: [
        { id: "AC1", text: "a", kind: "behavior" },
        { id: "AC1", text: "b", kind: "behavior" },
      ],
    });
    const result = briefGate(b, workspace());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['duplicate criterion id "AC1"']);
  });

  test("reports every failure at once", () => {
    const b = brief({ acceptance: [], open_questions: ["why?"] });
    expect(briefGate(b, workspace()).evidence).toHaveLength(2);
  });
});
