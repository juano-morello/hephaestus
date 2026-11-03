import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { briefGate } from "../src/gates/brief.ts";
import { Brief } from "../src/schemas/brief.ts";
import { ProjectGates } from "../src/schemas/gates.ts";
import { Workspace } from "../src/schemas/workspace.ts";

const dir = join(import.meta.dir, "..", "fixtures");
const load = async (path: string) => Bun.YAML.parse(await Bun.file(path).text());

describe("fixtures", async () => {
  const workspace = Workspace.parse(await load(join(dir, "workspace.yaml")));
  const gates = ProjectGates.parse(await load(join(dir, "gates.yaml")));

  test("gates are declared only for workspace projects", () => {
    expect(Object.keys(gates).sort()).toEqual(Object.keys(workspace.projects).sort());
  });

  test("workspace has a repo map per project", async () => {
    for (const name of Object.keys(workspace.projects)) {
      expect(await Bun.file(join(dir, "repo-maps", `${name}.md`)).exists()).toBe(true);
    }
  });

  for (const file of readdirSync(join(dir, "briefs"))) {
    test(`${file} parses and passes the brief gate`, async () => {
      const brief = Brief.parse(await load(join(dir, "briefs", file)));
      expect(briefGate(brief, workspace, gates)).toMatchObject({ verdict: "pass", evidence: [] });
    });
  }
});
