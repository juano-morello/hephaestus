import { describe, expect, test } from "bun:test";
import { dashboardFixtures } from "../../ui/test/fixtures.ts";
import { Dashboard } from "../src/output.ts";

describe("dashboard fixtures used by the UI tests", () => {
  for (const [name, fixture] of Object.entries(dashboardFixtures)) {
    test(`${name} parses with the real Dashboard schema`, () => {
      const r = Dashboard.safeParse(fixture);
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    });
  }
});
