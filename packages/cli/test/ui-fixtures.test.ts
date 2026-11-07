import { describe, expect, test } from "bun:test";
import {
  dashboardFixtures,
  diffSummaryFixtures,
  planDetailFixtures,
} from "../../ui/test/fixtures.ts";
import { Dashboard, DiffSummary, PlanDetail } from "../src/output.ts";

const covers = (
  name: string,
  schema: { safeParse(x: unknown): { success: boolean } },
  fixtures: object,
) => {
  describe(`${name} fixtures used by the UI tests`, () => {
    for (const [key, fixture] of Object.entries(fixtures)) {
      test(`${key} parses with the real ${name} schema`, () => {
        const r = schema.safeParse(fixture) as { success: boolean; error?: { issues: unknown } };
        expect(r.success, r.success ? "" : JSON.stringify(r.error?.issues)).toBe(true);
      });
    }
  });
};

covers("Dashboard", Dashboard, dashboardFixtures);
covers("DiffSummary", DiffSummary, diffSummaryFixtures);
covers("PlanDetail", PlanDetail, planDetailFixtures);
