import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectTestClient, fakeDaemon } from "./harness.ts";

const TOKEN = "k".repeat(43);
const ORIGIN = "http://127.0.0.1:7878";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "heph-live-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const writeUi = () => {
  const file = join(home, "ui.json");
  writeFileSync(file, JSON.stringify({ port: 7878, token: TOKEN }));
  chmodSync(file, 0o600);
};

const run = { run_id: "r1", status: "running" };
const status = {
  run,
  plan_approved: true,
  units: [{ unit_id: "T1", status: "running", attempts: 1 }],
  attempts: [],
  usage: [],
};
const list = { runs: [run] };
const dashboard = {
  schema: 1,
  run,
  plan_approved: true,
  plan: {
    units: [{ id: "T1", title: "First", kind: "implement", project: "app", depends_on: [] }],
  },
  units: [{ unit_id: "T1", status: "running", attempts: 1, in_plan: true }],
  attempts: [],
  pauses: [],
  usage: [],
};
const planned = {
  run_id: "r1",
  status: "planned",
  plan_id: "p1",
  planner_attempts: 1,
  tasks: [
    {
      id: "T1",
      title: "First",
      kind: "implement",
      project: "app",
      lane: "contained",
      complexity: "standard",
      scope: [],
      covers: ["AC1"],
    },
  ],
};
const brief = {
  schema: 1,
  goal: "g",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "it works", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "claude-code",
};
const ev = (id: string, type: string, summary: string) => ({
  id,
  ts: "2026-11-05T10:00:00Z",
  type,
  summary,
});
const fakeClock = () => {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
};

const daemon = () =>
  fakeDaemon({
    status: (a) => (a.length ? status : list),
    dashboard: () => dashboard,
    newRun: () => planned,
    run: () => ({ run_id: "r1", started: true, after: "e1" }),
    explain: () => ({ run_id: "r1", events: [ev("e1", "run.plan_ready", "plan ready")] }),
  });

const calls = {
  heph_status: { run: "r1" },
  heph_status_list: {},
  heph_new: { brief },
  heph_run: { run: "r1" },
  heph_watch: { run: "r1", wait_s: 0 },
} as const;

type Meta = { heph?: { live?: { origin?: string; token?: string } } } | undefined;
const call = async (ctx: Parameters<typeof connectTestClient>[0], name: keyof typeof calls) => {
  const client = await connectTestClient(ctx);
  const r = await client.callTool({
    name: name === "heph_status_list" ? "heph_status" : name,
    arguments: calls[name],
  });
  await client.close();
  return r;
};

describe("the widgets get the dashboard origin and token", () => {
  for (const name of Object.keys(calls) as (keyof typeof calls)[]) {
    test(`${name} result carries them in _meta and nowhere the model reads`, async () => {
      writeUi();
      const { client } = daemon();
      const r = await call({ client, workspace: () => "/ws", home, ...fakeClock() }, name);
      expect(r.isError).toBeFalsy();
      const meta = r._meta as Meta;
      expect(meta?.heph?.live).toEqual({ origin: ORIGIN, token: TOKEN });
      const visible = JSON.stringify([r.content, r.structuredContent]);
      expect(visible).not.toContain(TOKEN);
    });

    test(`${name} result has no live _meta when no dashboard is running`, async () => {
      const { client } = daemon();
      const r = await call({ client, workspace: () => "/ws", home, ...fakeClock() }, name);
      expect(r.isError).toBeFalsy();
      expect((r._meta as Meta)?.heph?.live).toBeUndefined();
    });
  }

  test("a ui.json that others can read is not trusted", async () => {
    writeUi();
    chmodSync(join(home, "ui.json"), 0o644);
    const { client } = daemon();
    const r = await call({ client, workspace: () => "/ws", home }, "heph_status");
    expect((r._meta as Meta)?.heph?.live).toBeUndefined();
  });
});

describe("the run widget resource declares where it may connect", () => {
  const read = async (ctx: Parameters<typeof connectTestClient>[0]) => {
    const c = await connectTestClient(ctx);
    const r = await c.readResource({ uri: "ui://heph/run" });
    await c.close();
    return r.contents[0] as { _meta?: { ui?: { csp?: { connectDomains?: string[] } } } };
  };

  test("connectDomains holds the dashboard origin when ui.json is present", async () => {
    writeUi();
    const { client } = daemon();
    const c = await read({ client, workspace: () => undefined, home });
    expect(c._meta?.ui?.csp?.connectDomains).toEqual([ORIGIN]);
  });

  test("and no connectDomains when it is absent", async () => {
    mkdirSync(home, { recursive: true });
    const { client } = daemon();
    const c = await read({ client, workspace: () => undefined, home });
    expect(c._meta?.ui?.csp?.connectDomains).toBeUndefined();
  });
});

describe("dispatching shows the run widget", () => {
  test("heph_run and heph_new are bound to the run widget resource", async () => {
    const { client } = daemon();
    const c = await connectTestClient({ client, workspace: () => undefined });
    const { tools } = await c.listTools();
    for (const n of ["heph_run", "heph_new"]) {
      const t = tools.find((x) => x.name === n);
      const meta = t?._meta as { ui?: { resourceUri?: string } } | undefined;
      expect(meta?.ui?.resourceUri).toBe("ui://heph/run");
    }
    await c.close();
  });

  test("heph_run's structured result carries the run's status and graph", async () => {
    const { client } = daemon();
    const r = await call({ client, workspace: () => "/ws", ...fakeClock() }, "heph_run");
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ run_id: "r1", state: "started" });
    expect(s.run).toMatchObject({ run_id: "r1", status: "running" });
    expect((s.graph as { units: { id: string }[] }).units.map((u) => u.id)).toEqual(["T1"]);
  });

  test("heph_new's result also carries the run view once the run exists", async () => {
    const { client } = daemon();
    const r = await call({ client, workspace: () => "/ws" }, "heph_new");
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Record<string, unknown>;
    expect(s).toMatchObject({ run_id: "r1", status: "planned" });
    expect((s.graph as { units: unknown[] } | undefined)?.units).toHaveLength(1);
  });
});
