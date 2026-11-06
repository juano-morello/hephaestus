import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type Brief,
  briefHash,
  type Plan,
  type Task,
  type WorkspaceConfig,
} from "@hephaestus/core";
import {
  buildRun,
  createRun,
  type EngineConfig,
  type RunPlanOptions,
  recordPlan,
  Stopped,
  type Worker,
} from "@hephaestus/engine";
import { type Ledger, NotOwnerError, openLedger } from "@hephaestus/ledger";
import { adopt, handOff, takeMethods } from "../src/handoff.ts";
import { syncMethods } from "../src/protocol.ts";
import { syncWith } from "../src/sync.ts";
import { localTransport } from "../src/transport.ts";
import type { Preflight } from "../src/workspace.ts";
import { describeWorkspace, workspaceMethods } from "../src/workspace.ts";
import { tempDir } from "./helpers.ts";
import { git, put, repoWithOrigin } from "./repos.ts";

const dir = tempDir();

const brief: Brief = {
  schema: 1,
  goal: "loot drops reach the server",
  context: "",
  decisions: [],
  constraints: [],
  acceptance: [{ id: "AC1", text: "server handles LootDrop", kind: "behavior" }],
  out_of_scope: [],
  open_questions: [],
  source: "cli",
};
const task = (id: string, t: Partial<Task>): Task => ({
  id,
  title: id,
  kind: "implement",
  project: "server",
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope: [],
  covers: ["AC1"],
  spec: id,
  ...t,
});
const plan: Plan = {
  schema: 1,
  brief_hash: briefHash(brief),
  tasks: [
    task("P1", {
      project: "proto",
      kind: "codegen",
      covers: [],
      scope: ["loot.txt"],
      produces: ["proto:Loot"],
    }),
    task("S1", {
      kind: "test",
      scope: ["check.sh"],
      consumes: ["proto:Loot"],
      produces: ["test:Loot"],
    }),
    task("S2", { scope: ["impl.sh"], consumes: ["test:Loot"] }),
  ],
  risks: [],
};
const FILES: Record<string, Record<string, string>> = {
  P1: { "loot.txt": "LootDrop\n" },
  S1: { "check.sh": "test -f impl.sh\n" },
  S2: { "impl.sh": "echo loot\n" },
};
const workspace: WorkspaceConfig = {
  name: "game",
  repos: { proto: "./proto", server: "./server" },
  projects: {
    proto: { repo: "proto", path: ".", stack: "schema" },
    server: { repo: "server", path: ".", stack: "sh", depends_on: ["proto"] },
  },
};
const config: EngineConfig = {
  routing: {
    test_author: { default: { model: "claude/sonnet" } },
    implementer: { default: { model: "claude/sonnet" } },
  },
  maxAttempts: 3,
  parallel: 1,
  budgetTokens: 20_000,
  tools: [],
  commands: {},
};

/** Writes each unit's files; `hold` waits for the stop signal, as OMP does when aborted. */
function worker(hold?: string) {
  const ids: string[] = [];
  let reached: () => void = () => {};
  const held = new Promise<void>((r) => {
    reached = r;
  });
  const w: Worker = {
    async spawn(input) {
      const id = input.brief.task.id;
      ids.push(id);
      if (id === hold) {
        reached();
        while (!input.signal?.aborted) await Bun.sleep(5);
        return {
          output: undefined,
          transcript: "",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          exit: "interrupted",
        };
      }
      const files = FILES[id] ?? {};
      for (const [p, c] of Object.entries(files)) put(join(input.workdir, p), c);
      return {
        output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
        transcript: "",
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        exit: "ok",
      };
    },
  };
  return { w, ids, held };
}

/** Two nodes: mbp with a checkout of `game`, denver with none yet. Shared bare remotes. */
async function twoNodes() {
  const origins = dir();
  const ws = join(dir(), "game");
  await repoWithOrigin(join(ws, "proto"), { "messages.txt": "base\n" }, origins);
  await repoWithOrigin(join(ws, "server"), { "README.md": "server\n" }, origins);
  const homeA = dir();
  const homeB = dir();
  const a = openLedger(homeA, { nodeId: "mbp" });
  const b = openLedger(homeB, { nodeId: "denver" });
  const opts = (ledger: Ledger, root: string, home: string, w: Worker) => {
    const { name: _n, ...rest } = workspace;
    const o: Omit<RunPlanOptions, "brief" | "plan"> = {
      ledger,
      workspace: rest,
      workspaceRoot: root,
      runId: "R1",
      changesetId: "C1",
      worker: w,
      gates: [],
      config,
      worktreesDir: join(home, "worktrees"),
    };
    return o;
  };
  createRun({ ...opts(a, ws, homeA, worker().w), brief, workspaceName: "game" });
  recordPlan({ ...opts(a, ws, homeA, worker().w), brief, workspace }, plan);
  const toB = (prs?: Preflight) =>
    localTransport({
      ...syncMethods(b),
      ...takeMethods({ ledger: b, home: homeB, workspaces: {} }),
      ...workspaceMethods({ node: "denver", home: homeB, workspaces: {}, ...(prs ? { prs } : {}) }),
    });
  return { ws, homeA, homeB, a, b, opts, toB, description: await describeWorkspace(ws, workspace) };
}

type Nodes = Awaited<ReturnType<typeof twoNodes>>;

/** Starts a build on mbp that stops in S1; returns the handoff options for it. */
async function buildingOnA(n: Nodes) {
  const first = worker("S1");
  const stop = new AbortController();
  const build = buildRun({ ...n.opts(n.a, n.ws, n.homeA, first.w), signal: stop.signal });
  await first.held;
  return {
    first,
    handoff: {
      ledger: n.a,
      runId: "R1",
      to: "denver",
      transport: n.toB(),
      workspace,
      workspaceRoot: n.ws,
      description: n.description,
      stopBuild: async () => {
        stop.abort("handoff");
        await build;
      },
    },
  };
}

const tree = (cwd: string, ref: string) => git(cwd, "ls-tree", "-r", ref);

describe("handoff", () => {
  test("waitMs reaches stopBuild, and without it stopBuild gets undefined", async () => {
    for (const waitMs of [1234, undefined]) {
      const n = await twoNodes();
      const { handoff } = await buildingOnA(n);
      const seen: (number | undefined)[] = [];
      const stop = handoff.stopBuild;
      await handOff({
        ...handoff,
        ...(waitMs !== undefined ? { waitMs } : {}),
        stopBuild: async (ms?: number) => {
          seen.push(ms);
          await stop();
        },
      });
      expect(seen).toEqual([waitMs]);
      n.a.close();
      n.b.close();
    }
  });

  test("a run handed off mid-build is finished by the new owner without redoing accepted units", async () => {
    const n = await twoNodes();
    const { handoff } = await buildingOnA(n);
    const out = await handOff(handoff);
    expect(out.pushed).toEqual(["proto", "server"]);
    expect(out.taken).toEqual({
      dir: join(n.homeB, "workspaces", "game"),
      fetched: ["proto", "server"],
    });
    expect(n.b.run("R1")?.owner_node).toBe("denver");
    expect(() =>
      n.a.append({
        run_id: "R1",
        changeset_id: "C1",
        config_hash: "c",
        actor: "human",
        type: "human.input",
        data: { kind: "hint", text: "late" },
      }),
    ).toThrow(NotOwnerError);

    const second = worker();
    const built = await buildRun(n.opts(n.b, out.taken.dir, n.homeB, second.w));
    expect(built.status).toBe("built");
    expect(second.ids).toEqual(["S1", "S2"]);
    const events = n.b.read({ run_id: "R1" }).map((s) => s.event);
    expect(
      events
        .filter((e) => e.type === "unit.attempt.interrupted")
        .map((e) => [e.unit_id, e.node_id, e.data]),
    ).toEqual([["S1", "mbp", { reason: "handoff" }]]);
    expect(events.filter((e) => e.type === "run.resumed").map((e) => [e.node_id, e.data])).toEqual([
      ["denver", { reason: "handoff" }],
    ]);
    // P1 was accepted on mbp; denver builds on the same commit.
    const server = join(out.taken.dir, "server");
    expect(await tree(server, "heph/R1")).toContain("impl.sh");
    expect(await git(join(out.taken.dir, "proto"), "rev-parse", "heph/R1")).toBe(
      await git(join(n.ws, "proto"), "rev-parse", "heph/R1"),
    );

    await syncWith(n.a, n.toB());
    expect(n.a.run("R1")?.status).toBe("built");
    n.a.close();
    n.b.close();
  });

  test("a handoff stopped at any step ends with one owner, who finishes the run", async () => {
    const POINTS = [
      "before:push:proto",
      "after:push:proto",
      "before:push:server",
      "after:push:server",
      "before:run.handed_off",
      "after:run.handed_off",
      "after:sync",
    ];
    for (const at of POINTS) {
      const n = await twoNodes();
      const { handoff } = await buildingOnA(n);
      const chaos = (p: string) => {
        if (p === at) throw new Error(`stopped at ${p}`);
      };
      await expect(handOff({ ...handoff, chaos })).rejects.toBeInstanceOf(Stopped);

      // Recovery is running heph handoff again on the old owner, whatever step it stopped at.
      const recovered = (await handOff({ ...handoff, stopBuild: undefined })).taken;
      const second = worker();
      expect({
        at,
        status: (await buildRun(n.opts(n.b, recovered.dir, n.homeB, second.w))).status,
      }).toEqual({
        at,
        status: "built",
      });
      expect({ at, ids: second.ids }).toEqual({ at, ids: ["S1", "S2"] });
      await syncWith(n.a, n.toB());
      expect({ at, a: n.a.run("R1")?.owner_node, b: n.b.run("R1")?.owner_node }).toEqual({
        at,
        a: "denver",
        b: "denver",
      });
      expect(n.b.read({ run_id: "R1", types: ["run.handed_off"] })).toHaveLength(1);
      n.a.close();
      n.b.close();
    }
  }, 120_000);

  test("a run without a remote for a touched repo can't be handed off", async () => {
    const n = await twoNodes();
    await git(join(n.ws, "server"), "remote", "remove", "origin");
    await expect(
      handOff({
        ledger: n.a,
        runId: "R1",
        to: "denver",
        transport: n.toB(),
        workspace,
        workspaceRoot: n.ws,
        description: n.description,
      }),
    ).rejects.toThrow("server has no origin remote");
    expect(n.a.run("R1")?.owner_node).toBe("mbp");
    n.a.close();
    n.b.close();
  });
});

describe("handoff to a node that can't land", () => {
  test("is refused before the build stops, and the run stays here", async () => {
    const n = await twoNodes();
    const { handoff } = await buildingOnA(n);
    let stopped = false;
    const noGh: Preflight = { preflight: async () => "gh can't reach the repo: not logged in" };
    await expect(
      handOff({
        ...handoff,
        transport: n.toB(noGh),
        stopBuild: async () => {
          stopped = true;
          await handoff.stopBuild();
        },
      }),
    ).rejects.toThrow(
      "denver can't take workspace game:\n  proto: gh can't reach the repo: not logged in\n  server: gh can't reach the repo: not logged in",
    );
    expect(stopped).toBe(false);
    expect(n.a.run("R1")).toMatchObject({ owner_node: "mbp", status: "running" });
    expect(n.a.read({ run_id: "R1", types: ["run.handed_off"] })).toHaveLength(0);
    await handoff.stopBuild();
    n.a.close();
    n.b.close();
  });
});

describe("adopt", () => {
  test("refused while the owner answers unless forced; then the adopter owns the run", async () => {
    const n = await twoNodes();
    await syncWith(n.b, localTransport(syncMethods(n.a)));
    await expect(
      adopt({ ledger: n.b, runId: "R1", ownerReachable: async () => true }),
    ).rejects.toThrow("mbp answers");
    expect(await adopt({ ledger: n.b, runId: "R1", ownerReachable: async () => false })).toEqual({
      from: "mbp",
    });
    expect(n.b.run("R1")?.owner_node).toBe("denver");
    expect(n.b.read({ types: ["run.adopted"] })[0]?.event.data).toEqual({
      from: "mbp",
      reason: "mbp unreachable",
    });
    n.a.close();
    n.b.close();
  });
});
