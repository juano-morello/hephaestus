import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { briefHash, type Plan, type Task } from "@hephaestus/core";
import { type Ledger, openLedger } from "@hephaestus/ledger";
import type { Sandbox } from "@hephaestus/sandbox";
import { runPlan } from "../src/engine.ts";
import { createGit } from "../src/git.ts";
import { baseRef } from "../src/stack.ts";
import type { Worker } from "../src/worker.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";
import { brief, config, threeRepos, writeScript } from "./workspace.ts";

const dir = tempDir();

describe("baseRef", () => {
  async function repo(withParentBranch: boolean) {
    const d = await initRepo(dir(), { "a.txt": "a\n" });
    const git = createGit(d);
    if (withParentBranch) await git.branchForce("heph/A", await git.revParse("main"));
    return git;
  }

  test("baseRef_uses_parent_branch_when_built", async () => {
    const git = await repo(true);
    expect(
      await baseRef({ git, repo: "r", stackOn: "A", parentStatus: "built", target: "main" }),
    ).toBe("heph/A");
    expect(
      await baseRef({ git, repo: "r", stackOn: "A", parentStatus: "staged", target: "main" }),
    ).toBe("heph/A");
  });

  test("baseRef_falls_back_to_target_when_parent_untouched_repo", async () => {
    const git = await repo(false);
    expect(
      await baseRef({ git, repo: "r", stackOn: "A", parentStatus: "built", target: "main" }),
    ).toBe("main");
  });

  test("baseRef_target_when_parent_finished", async () => {
    const git = await repo(true);
    for (const parentStatus of ["finished", "failed", undefined])
      expect(await baseRef({ git, repo: "r", stackOn: "A", parentStatus, target: "main" })).toBe(
        "main",
      );
    expect(await baseRef({ git, repo: "r", target: "main" })).toBe("main");
  });
});

const task = (id: string, project: string, scope: string[]): Task => ({
  id,
  title: id,
  kind: "implement",
  project,
  lane: "contained",
  complexity: "standard",
  complexity_reason: "x",
  scope,
  covers: ["AC1"],
  spec: id,
});
const plan = (tasks: Task[]): Plan => ({
  schema: 1,
  brief_hash: briefHash(brief),
  tasks,
  risks: [],
});

/** Writes each unit's own file (its scope) and reports it. */
const writer: Worker = {
  async spawn(input) {
    const files = Object.fromEntries(
      input.brief.task.scope.map((p) => [p, `${input.brief.task.id}\n`]),
    );
    writeFiles(input.workdir, files);
    return {
      output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
      transcript: "",
      usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};

const sh = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd });
  return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};

async function stackFixture() {
  const { root, workspace } = await threeRepos(dir(), {
    integration: { gate: "./scripts/integration.sh" },
  });
  writeScript(root, "scripts/integration.sh", "exit 0\n");
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  /** Per integration gate run: the commit each repo was assembled at. */
  const seen: Record<string, string>[] = [];
  // Runs the script unconfined: what matters here is what the gate is given, not the sandbox.
  const integrationSandbox = async (d: string): Promise<Sandbox> => ({
    kind: "native",
    root: d,
    async exec(command) {
      seen.push(
        Object.fromEntries(
          Object.keys(workspace.repos).map((r) => [
            r,
            sh(["git", "rev-parse", "HEAD"], join(d, r)).stdout.trim(),
          ]),
        ),
      );
      return { ...sh(["sh", "-c", command], d), timedOut: false };
    },
    readFile: async () => "",
    writeFile: async () => {},
    dispose: async () => {},
  });
  const worktreesDir = join(dir(), "worktrees");
  const build = (runId: string, tasks: Task[], stackOn?: string) =>
    runPlan({
      ledger,
      workspace,
      workspaceRoot: root,
      brief,
      plan: plan(tasks),
      runId,
      changesetId: runId,
      worker: writer,
      gates: [],
      config,
      worktreesDir,
      integrationSandbox,
      ...(stackOn ? { stackOn } : {}),
    });
  const git = (repo: string) => createGit(join(root, repo));
  const sha = (repo: string, ref: string) => git(repo).revParse(ref);
  return { ledger, build, git, sha, seen };
}

/** The base each touched repo's run branch was reset to, from the ledger. */
function resets(ledger: Ledger, runId: string): Record<string, string> {
  return Object.fromEntries(
    ledger
      .read({ run_id: runId, types: ["effect.intended"] })
      .map((s) => s.event as { repo?: string; data: { effect: string; after?: string } })
      .filter((e) => e.data.effect === "run_branch_reset")
      .map((e) => [e.repo as string, e.data.after as string]),
  );
}

describe("stacked builds", () => {
  test("a child in a repo the parent touched starts at the parent's tip; the gate sees the stack", async () => {
    const f = await stackFixture();
    const a = await f.build("A", [
      task("A1", "proto", ["loot.txt"]),
      task("A2", "server", ["a.sh"]),
    ]);
    expect(a.status).toBe("built");
    const aServer = await f.sha("server", "heph/A");
    const aProto = await f.sha("proto", "heph/A");

    const b = await f.build("B", [task("B1", "server", ["b.sh"])], "A");
    expect(b.status).toBe("built");
    expect(f.ledger.run("B")?.stack_on).toBe("A");
    expect(resets(f.ledger, "B")).toEqual({ server: aServer });
    const bServer = await f.sha("server", "heph/B");
    expect(await f.git("server").isAncestor(aServer, bServer)).toBe(true);
    expect(await f.git("proto").refSha("heph/B")).toBeUndefined();

    expect(f.seen.at(-1)).toEqual({
      proto: aProto,
      server: bServer,
      web: await f.sha("web", "main"),
    });
    f.ledger.close();
  });

  test("a child in a repo the parent did not touch starts at the target; the gate sees the parent elsewhere", async () => {
    const f = await stackFixture();
    expect((await f.build("A", [task("A1", "server", ["a.sh"])])).status).toBe("built");
    const aServer = await f.sha("server", "heph/A");
    const webMain = await f.sha("web", "main");

    expect((await f.build("B", [task("B1", "web", ["w.html"])], "A")).status).toBe("built");
    expect(resets(f.ledger, "B")).toEqual({ web: webMain });
    expect(f.seen.at(-1)).toEqual({
      proto: await f.sha("proto", "main"),
      server: aServer,
      web: await f.sha("web", "heph/B"),
    });
    f.ledger.close();
  });

  test("chain_of_three_bases_on_direct_parent", async () => {
    const f = await stackFixture();
    await f.build("A", [task("A1", "server", ["a.sh"])]);
    await f.build("B", [task("B1", "server", ["b.sh"])], "A");
    const bServer = await f.sha("server", "heph/B");
    const c = await f.build("C", [task("C1", "server", ["c.sh"])], "B");
    expect(c.status).toBe("built");
    expect(resets(f.ledger, "C")).toEqual({ server: bServer });
    const files = await f.git("server").lsTree("heph/C");
    expect(files).toEqual(expect.arrayContaining(["a.sh", "b.sh", "c.sh"]));
    f.ledger.close();
  });

  test("a parent that already finished is ignored: the child starts at the target", async () => {
    const f = await stackFixture();
    await f.build("A", [task("A1", "server", ["a.sh"])]);
    f.ledger.append({
      run_id: "A",
      changeset_id: "A",
      config_hash: "x",
      actor: "engine",
      type: "run.finished",
      data: {},
    });
    expect(f.ledger.run("A")?.status).toBe("finished");
    await f.build("B", [task("B1", "server", ["b.sh"])], "A");
    expect(resets(f.ledger, "B")).toEqual({ server: await f.sha("server", "main") });
    f.ledger.close();
  });
});
