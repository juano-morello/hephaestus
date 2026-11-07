import { describe, expect, test } from "bun:test";
import { run } from "../src/main.ts";
import { isSchemaName, SCHEMA_NAMES, schemaFor } from "../src/schema.ts";

// biome-ignore lint/suspicious/noExplicitAny: walking generated JSON Schema
type Obj = Record<string, any>;

describe("schemaFor", () => {
  for (const name of SCHEMA_NAMES) {
    test(`${name} is an object schema that survives JSON`, () => {
      const s = schemaFor(name) as Obj;
      expect(s.type).toBe("object");
      expect(s.properties).toBeDefined();
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    });
  }

  // routing and limits are node-wide settings: the home layer, not the repo layer.
  test("home has routing with top and fallback route keys, and limits", () => {
    const s = schemaFor("home") as Obj;
    const routes = s.properties.routing.additionalProperties.properties;
    expect(routes.top).toBeDefined();
    expect(routes.fallback).toBeDefined();
    expect(s.properties.limits).toBeDefined();
  });

  test("repo has project and projects with commands and gates", () => {
    const s = schemaFor("repo") as Obj;
    expect(s.properties.project.properties.commands).toBeDefined();
    expect(s.properties.projects).toBeDefined();
    expect(s.properties.routing).toBeUndefined();
  });

  test("workspace has repos; brief has acceptance", () => {
    expect((schemaFor("workspace") as Obj).properties.repos).toBeDefined();
    expect((schemaFor("brief") as Obj).properties.acceptance).toBeDefined();
  });

  test("isSchemaName accepts exactly the four names", () => {
    expect(SCHEMA_NAMES).toEqual(["home", "workspace", "repo", "brief"]);
    expect(isSchemaName("repo")).toBe(true);
    expect(isSchemaName("nope")).toBe(false);
    expect(isSchemaName("")).toBe(false);
  });
});

describe("heph schema", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      ctx: {
        cwd: process.cwd(),
        env: {},
        stdout: (s: string) => out.push(s),
        stderr: (s: string) => err.push(s),
      },
    };
  };

  test("--json wraps the schema in the envelope", async () => {
    const { out, ctx } = io();
    expect(await run(["schema", "home", "--json"], ctx)).toBe(0);
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ schema: 1, command: "schema", ok: true });
    expect(body.data.properties.routing).toBeDefined();
  });

  test("the human form is the schema as pretty JSON", async () => {
    const { out, ctx } = io();
    expect(await run(["schema", "brief"], ctx)).toBe(0);
    expect(JSON.parse(out.join("")).properties.acceptance).toBeDefined();
    expect(out.join("")).toContain("\n  ");
  });

  test("an unknown name fails with the list", async () => {
    const { out, ctx } = io();
    expect(await run(["schema", "nope", "--json"], ctx)).toBe(1);
    const body = JSON.parse(out.join(""));
    expect(body).toMatchObject({ ok: false });
    expect(body.error.message).toBe('unknown schema "nope"; one of: home, workspace, repo, brief');
  });

  test("no name fails the same way", async () => {
    const { err, ctx } = io();
    expect(await run(["schema"], ctx)).toBe(1);
    expect(err.join("")).toContain('unknown schema ""; one of: home, workspace, repo, brief');
  });
});
