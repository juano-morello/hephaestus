import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger } from "@hephaestus/ledger";
import { runOk } from "@hephaestus/sandbox";
import {
  clearWorktrees,
  effect,
  pendingEffects,
  type Reality,
  ReconcileError,
  reconcile,
} from "../src/effects.ts";
import { createGit } from "../src/git.ts";
import type { PullRequests } from "../src/prs.ts";
import { initRepo, tempDir, writeFiles } from "./helpers.ts";

const dir = tempDir();
const base = { run_id: "R1", changeset_id: "C1", config_hash: "cfg" };
const unit = { repo: "server", project: "server", unit_id: "T1", attempt: 1 };

async function setup() {
  const repo = join(dir(), "server");
  mkdirSync(repo);
  await initRepo(repo, { "a.txt": "a\n" });
  const git = createGit(repo);
  const main = await git.revParse("main");
  writeFiles(repo, { "b.txt": "b\n" });
  await runOk(["git", "add", "-A"], { cwd: repo });
  await runOk(["git", "commit", "-qm", "next"], { cwd: repo });
  const next = await git.revParse("HEAD");
  await runOk(["git", "reset", "-q", "--hard", main], { cwd: repo });
  const ledger = openLedger(join(dir(), "node"), { nodeId: "n" });
  const reality: Reality = { git: () => git, dirOf: () => repo };
  return { repo, git, main, next, ledger, reality };
}

const types = (ledger: Ledger) => ledger.read().map((s) => s.event.type);

/** Writes an intent the way a process that died right after it would have left it. */
function intend(ledger: Ledger, data: Record<string, unknown>, on: object = { repo: "server" }) {
  ledger.append({ ...base, ...on, actor: "engine", type: "effect.intended", data } as never);
}

describe("effect", () => {
  test("writes the intent with its preceding events, runs, then done with what follows", async () => {
    const { git, main, next, ledger } = await setup();
    await git.branchForce("heph/R1", main);
    const points: string[] = [];
    await effect(
      { ledger, base, chaos: (p) => void points.push(p) },
      {
        effect: "run_branch_advance",
        key: "run_branch_advance:server:T1:a1",
        target: "heph/R1",
        before: main,
        after: next,
        on: unit,
      },
      async () => {
        await git.updateRef("heph/R1", next, main);
        return { sha: next };
      },
      {
        with: [
          {
            ...base,
            ...unit,
            actor: "engine",
            type: "context.pack_built",
            data: { size_tokens: 1, truncated: [], expansions: 0 },
          },
        ],
        followedBy: () => [{ ...base, ...unit, actor: "engine", type: "unit.accepted", data: {} }],
      },
    );
    expect(points).toEqual([
      "before:run_branch_advance:server:T1:a1",
      "after:run_branch_advance:server:T1:a1",
    ]);
    expect(types(ledger)).toEqual([
      "context.pack_built",
      "effect.intended",
      "effect.done",
      "unit.accepted",
    ]);
    expect(ledger.read()[2]?.event).toMatchObject({
      unit_id: "T1",
      attempt: 1,
      data: { state: "applied", sha: next },
    });
    expect(pendingEffects(ledger, "R1")).toEqual([]);
    ledger.close();
  });

  test("a throw between intent and done leaves the effect pending", async () => {
    const { ledger } = await setup();
    const run = effect(
      {
        ledger,
        base,
        chaos: (p) => {
          if (p.startsWith("after:")) throw new Error("crash");
        },
      },
      { effect: "staging_ref", key: "staging_ref:server", target: "refs/heph/staging/R1" },
      async () => undefined,
    );
    await expect(run).rejects.toThrow("crash");
    expect(pendingEffects(ledger, "R1").map((e) => e.data.key)).toEqual(["staging_ref:server"]);
    ledger.close();
  });
});

describe("reconcile", () => {
  const advance = (before: string, after: string) => ({
    effect: "run_branch_advance",
    key: "run_branch_advance:server:T1:a1",
    target: "heph/R1",
    before,
    after,
  });

  test("an advance already made is confirmed and the unit accepted, once", async () => {
    const { git, main, next, ledger, reality } = await setup();
    await git.branchForce("heph/R1", next);
    intend(ledger, advance(main, next), unit);
    expect(await reconcile(ledger, "R1", reality)).toEqual([
      { key: "run_branch_advance:server:T1:a1", state: "confirmed" },
    ]);
    expect(types(ledger)).toEqual(["effect.intended", "effect.done", "unit.accepted"]);
    expect(ledger.read().at(-1)?.event).toMatchObject({
      unit_id: "T1",
      attempt: 1,
      repo: "server",
    });
    expect(await reconcile(ledger, "R1", reality)).toEqual([]);
    ledger.close();
  });

  test("an advance not yet made is applied from the intent", async () => {
    const { git, main, next, ledger, reality } = await setup();
    await git.branchForce("heph/R1", main);
    intend(ledger, advance(main, next), unit);
    expect((await reconcile(ledger, "R1", reality))[0]?.state).toBe("applied");
    expect(await git.revParse("heph/R1")).toBe(next);
    expect(types(ledger).at(-1)).toBe("unit.accepted");
    ledger.close();
  });

  test("a run branch moved by something else stops the resume", async () => {
    const { git, main, next, ledger, reality } = await setup();
    await git.branchForce("heph/R1", main);
    intend(ledger, advance(next, next.replace(/./, "0")), unit);
    await expect(reconcile(ledger, "R1", reality)).rejects.toBeInstanceOf(ReconcileError);
    ledger.close();
  });

  test("ref effects are confirmed when the ref is there, abandoned when not", async () => {
    const { git, main, next, ledger, reality } = await setup();
    await git.setRef("refs/heph/staging/R1", next);
    intend(ledger, {
      effect: "staging_ref",
      key: "staging_ref:server",
      target: "refs/heph/staging/R1",
      after: next,
    });
    intend(ledger, {
      effect: "target_advance",
      key: "target_advance:server",
      target: "main",
      before: main,
      after: next,
    });
    intend(ledger, {
      effect: "run_branch_reset",
      key: "run_branch_reset:server",
      target: "heph/R1",
      after: main,
    });
    expect(await reconcile(ledger, "R1", reality)).toEqual([
      { key: "staging_ref:server", state: "confirmed" },
      { key: "target_advance:server", state: "abandoned" },
      { key: "run_branch_reset:server", state: "abandoned" },
    ]);
    expect(pendingEffects(ledger, "R1")).toEqual([]);
    ledger.close();
  });

  test("a key used again after being abandoned is pending only until its new done", async () => {
    const { main, ledger, reality } = await setup();
    const data = { effect: "staging_ref", key: "staging_ref:server", target: "x", after: main };
    intend(ledger, data);
    await reconcile(ledger, "R1", reality);
    intend(ledger, data);
    expect(pendingEffects(ledger, "R1")).toHaveLength(1);
    ledger.close();
  });

  test("pull request effects ask the pull request client", async () => {
    const { repo, ledger, reality } = await setup();
    const prs = {
      find: async ({ head }: { head: string }) =>
        head === "heph/R1"
          ? { url: "https://github.com/o/server/pull/1", state: "open" }
          : undefined,
      status: async () => ({ state: "merged", mergeCommit: "a".repeat(40) }),
    } as unknown as PullRequests;
    intend(ledger, { effect: "pr_open", key: "pr_open:server", target: "heph/R1" });
    intend(ledger, {
      effect: "pr_merge",
      key: "pr_merge:server",
      target: "https://github.com/o/server/pull/1",
    });
    intend(ledger, { effect: "pr_edit", key: "pr_edit:server", target: "x" });
    const out = await reconcile(ledger, "R1", { ...reality, prs, dirOf: () => repo });
    expect(out.map((o) => o.state)).toEqual(["confirmed", "confirmed", "abandoned"]);
    const done = ledger.read({ types: ["effect.done"] }).map((s) => s.event.data);
    expect(done[0]).toMatchObject({ url: "https://github.com/o/server/pull/1" });
    expect(done[1]).toMatchObject({ sha: "a".repeat(40) });
    ledger.close();
  });
});

describe("clearWorktrees", () => {
  test("removes a stopped process's worktrees and frees their branches", async () => {
    const { repo, git, main } = await setup();
    const wts = join(dir(), "worktrees");
    mkdirSync(join(wts, "R1", "T1"), { recursive: true });
    await git.worktreeAdd(join(wts, "R1", "T1", "a1"), "heph-attempt/R1/T1/a1", main);
    await clearWorktrees(wts, "R1", [git]);
    expect(existsSync(join(wts, "R1"))).toBe(false);
    const list = await runOk(["git", "worktree", "list", "--porcelain"], { cwd: repo });
    expect(list).not.toContain("heph-attempt/R1/T1/a1");
  });
});
