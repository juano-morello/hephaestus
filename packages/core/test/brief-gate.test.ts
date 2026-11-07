import { describe, expect, test } from "bun:test";
import { briefGate } from "../src/gates/brief.ts";
import { brief, gates, workspace } from "./helpers.ts";

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

  describe("criterion projects", () => {
    const withProjects = (projects: string[], extra: Record<string, unknown> = {}) =>
      brief({
        acceptance: [
          { id: "AC1", text: "a", kind: "behavior" },
          { id: "AC2", text: "b", kind: "behavior", projects, ...extra },
        ],
      });

    test("passes when every project is in the workspace", () => {
      expect(briefGate(withProjects(["server", "client"]), workspace()).verdict).toBe("pass");
    });

    test("fails on a project not in the workspace", () => {
      const result = briefGate(withProjects(["server", "x"]), workspace());
      expect(result.verdict).toBe("fail");
      expect(result.evidence).toEqual(['AC2: projects names "x", which is not in the workspace']);
    });

    test("fails on a project listed twice", () => {
      const result = briefGate(withProjects(["client", "server", "client"]), workspace());
      expect(result.evidence).toEqual(['AC2: projects lists "client" twice']);
    });

    test("fails when the criterion also has check", () => {
      const result = briefGate(
        withProjects(["server"], { check: { gate: "buf" } }),
        workspace(),
        gates(),
      );
      expect(result.evidence).toEqual([
        "AC2: projects applies to criteria checked by tests; a gate check (check.gate) is per project already",
      ]);
    });

    test("an empty projects array is treated as absent", () => {
      expect(briefGate(withProjects([]), workspace()).verdict).toBe("pass");
      const checked = withProjects([], { check: { gate: "buf" } });
      expect(briefGate(checked, workspace(), gates()).verdict).toBe("pass");
    });
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

  test("passes a gate-checked criterion when some project has the gate", () => {
    const b = brief({
      acceptance: [{ id: "AC1", text: "buf passes", kind: "behavior", check: { gate: "buf" } }],
    });
    expect(briefGate(b, workspace(), gates()).verdict).toBe("pass");
  });

  test("fails a gate-checked criterion whose gate no project has", () => {
    const b = brief({
      acceptance: [{ id: "AC1", text: "fast", kind: "nonfunctional", check: { gate: "bench" } }],
    });
    const result = briefGate(b, workspace(), gates());
    expect(result.verdict).toBe("fail");
    expect(result.evidence).toEqual(['AC1: check gate "bench" is not configured in any project']);
  });

  test("reports every failure at once", () => {
    const b = brief({ acceptance: [], open_questions: ["why?"] });
    expect(briefGate(b, workspace()).evidence).toHaveLength(2);
  });
});
