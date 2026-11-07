import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventDraft } from "@hephaestus/ledger";
import { PeerError, type Transport } from "@hephaestus/node";
import { loadHomeConfig } from "../src/config.ts";
import { type Host, openHost } from "../src/host.ts";
import { type Io, run } from "../src/main.ts";
import { mergeHealth, type NodeRow, nodesText } from "../src/nodes.ts";

let root: string;
let home: string;
let hosts: Host[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "heph-nodes-cmd-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    [
      "node: { id: mbp }",
      "sandbox: { mode: native }",
      "nodes:",
      "  denver: { ssh: denver.lan, preferred: true, labels: [gpu, fast] }",
      "  oslo: { ssh: me@oslo }",
      "",
    ].join("\n"),
  );
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  hosts = [];
  rmSync(root, { recursive: true, force: true });
});

const host = async (connect?: (node: string) => Transport, extra: object = {}) => {
  const h = openHost({
    home,
    config: await loadHomeConfig(home),
    ...(connect ? { connect } : {}),
    ...extra,
  });
  hosts.push(h);
  return h;
};

const created = (run: string, owner: string): EventDraft => ({
  run_id: run,
  changeset_id: run,
  config_hash: "cfg",
  actor: "engine",
  type: "run.created",
  data: { owner_node: owner, brief_hash: "b".repeat(64), eval: false },
});

const rowsOf = async (h: Host, probe = false) =>
  ((await h.api.call("nodes", [{ probe }], undefined)) as { nodes: NodeRow[] }).nodes;

describe("heph nodes rows", () => {
  test("one row per configured peer, plus this node", async () => {
    const rows = await rowsOf(await host());
    expect(rows.map((r) => r.name)).toEqual(["mbp", "denver", "oslo"]);
    expect(rows[0]).toMatchObject({ name: "mbp", this_node: true, state: "ok", runs_owned: 0 });
    expect(rows[1]).toMatchObject({
      name: "denver",
      ssh: "denver.lan",
      preferred: true,
      labels: ["gpu", "fast"],
      state: "unknown",
    });
    expect(rows[2]).toMatchObject({ name: "oslo", ssh: "me@oslo", preferred: false, labels: [] });
    expect(rows[1]?.probe).toBeUndefined();
  });

  test("runs_owned counts the runs each node owns", async () => {
    const h = await host();
    h.ledger.append(created("R1", "mbp"));
    h.ledger.append(created("R2", "denver"));
    h.ledger.append(created("R3", "denver"));
    const rows = await rowsOf(h);
    expect(rows.map((r) => [r.name, r.runs_owned])).toEqual([
      ["mbp", 1],
      ["denver", 2],
      ["oslo", 0],
    ]);
  });
});

describe("health from the daemon", () => {
  const rows = (): NodeRow[] => [
    {
      name: "mbp",
      ssh: "local",
      preferred: false,
      labels: [],
      state: "ok",
      this_node: true,
      runs_owned: 0,
    },
    {
      name: "denver",
      ssh: "denver",
      preferred: false,
      labels: [],
      state: "unknown",
      runs_owned: 0,
    },
    { name: "oslo", ssh: "oslo", preferred: false, labels: [], state: "unknown", runs_owned: 0 },
  ];
  const health = {
    denver: {
      ok: false,
      failures: 2,
      since: "2026-11-08T10:00:00.000Z",
      error: "ssh: refused",
      last_ok_at: "2026-11-08T09:00:00.000Z",
      next_try_at: "2026-11-08T10:05:00.000Z",
    },
    oslo: { ok: true, failures: 0, last_ok_at: "2026-11-08T10:01:00.000Z" },
  };

  test("mergeHealth fills state for the nodes method", () => {
    const merged = mergeHealth("nodes", [], { nodes: rows() }, health) as {
      daemon: boolean;
      nodes: NodeRow[];
    };
    expect(merged.daemon).toBe(true);
    expect(merged.nodes[0]?.state).toBe("ok");
    expect(merged.nodes[1]).toMatchObject({
      state: "down",
      since: "2026-11-08T10:00:00.000Z",
      last_ok_at: "2026-11-08T09:00:00.000Z",
      next_try_at: "2026-11-08T10:05:00.000Z",
      error: "ssh: refused",
    });
    expect(merged.nodes[2]).toMatchObject({ state: "ok", last_ok_at: "2026-11-08T10:01:00.000Z" });
  });

  test("a node the daemon has not synced yet stays unknown", () => {
    const merged = mergeHealth("nodes", [], { nodes: rows() }, { oslo: health.oslo }) as {
      nodes: NodeRow[];
    };
    expect(merged.nodes[1]?.state).toBe("unknown");
  });

  test("status keeps its old behavior", () => {
    expect(mergeHealth("status", [], { runs: [] }, health)).toEqual({ runs: [], nodes: health });
    expect(mergeHealth("status", ["R1"], { run: {} }, health)).toEqual({ run: {} });
  });
});

describe("--probe", () => {
  const answering = (id: string): Transport => ({
    async request(method) {
      if (method !== "hello") throw new Error(`unexpected ${method}`);
      return { node: id, protocol: 1, cursor: 0, version: "9.9.9" } as never;
    },
    async close() {},
  });

  test("an answering peer is probed ok with its node id and version", async () => {
    const h = await host((n) => answering(n));
    const rows = await rowsOf(h, true);
    expect(rows[1]?.probe).toEqual({ ok: true, detail: "denver, heph 9.9.9" });
    expect(rows[0]?.probe).toBeUndefined();
  });

  test("a failing peer is probed down with the first line of the error", async () => {
    const h = await host(() => ({
      async request() {
        throw new PeerError("ssh: no route\nthe whole command line follows");
      },
      async close() {},
    }));
    const rows = await rowsOf(h, true);
    expect(rows[1]?.probe).toEqual({ ok: false, detail: "ssh: no route" });
    expect(rows[2]?.probe?.ok).toBe(false);
  });

  test("a peer that hangs is cut off at the probe timeout", async () => {
    const h = await host(
      () => ({
        request: () => new Promise<never>(() => {}),
        async close() {},
      }),
      { probeMs: 30 },
    );
    const rows = await rowsOf(h, true);
    expect(rows[1]?.probe?.ok).toBe(false);
    expect(rows[1]?.probe?.detail).toContain("did not answer");
  });
});

describe("the command", () => {
  const heph = async (args: string[], connect?: (n: string) => Transport) => {
    let out = "";
    const io: Io = {
      cwd: root,
      env: { HEPH_HOME: home },
      stdout: (s) => {
        out += s;
      },
      stderr: () => {},
      deps: {} as never,
      ...(connect ? { connect } : {}),
    };
    const code = await run(args, io);
    return { out, code };
  };

  test("--json prints the envelope with the rows", async () => {
    const { out, code } = await heph(["nodes", "--json"]);
    expect(code).toBe(0);
    const env = JSON.parse(out) as { ok: boolean; data: { nodes: NodeRow[]; daemon: boolean } };
    expect(env.ok).toBe(true);
    expect(env.data.daemon).toBe(false);
    expect(env.data.nodes.map((n) => n.name)).toEqual(["mbp", "denver", "oslo"]);
  });

  test("the human table says state is unknown without a daemon", async () => {
    const { out } = await heph(["nodes"]);
    expect(out).toContain("denver");
    expect(out).toContain("unknown");
    expect(out).toContain("(this node)");
    expect(out).toContain("state is unknown without a daemon (start heph daemon, or use --probe)");
  });

  test("--probe shows the probe result per node", async () => {
    const { out } = await heph(["nodes", "--probe"], () => ({
      async request() {
        throw new Error("nope");
      },
      async close() {},
    }));
    expect(out).toContain("probe: nope");
  });

  test("nodesText marks down nodes with why and when the daemon retries", () => {
    const text = nodesText({
      daemon: true,
      nodes: [
        {
          name: "mbp",
          ssh: "local",
          preferred: false,
          labels: [],
          state: "ok",
          this_node: true,
          runs_owned: 1,
        },
        {
          name: "denver",
          ssh: "denver",
          preferred: true,
          labels: ["gpu"],
          state: "down",
          since: "s",
          error: "ssh: refused",
          next_try_at: "t",
          runs_owned: 0,
        },
      ],
    });
    expect(text).toContain("down");
    expect(text).toContain("ssh: refused");
    expect(text).not.toContain("state is unknown");
  });

  test("heph help lists the command", async () => {
    const { out } = await heph(["help"]);
    expect(out).toContain("nodes [--probe]");
    expect(out).toContain("List the nodes this node knows and whether it can reach them");
  });
});
