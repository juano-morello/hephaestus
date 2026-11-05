import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { briefHash, type Plan, type Task, type Workspace } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk, type Sandbox } from "@hephaestus/sandbox";
import { type RunPlanOptions, runPlan } from "../src/engine.ts";
import { createGit } from "../src/git.ts";
import { checkChangeset, landChangeset, mergeChangeset } from "../src/land.ts";
import { ghPullRequests, type PrState, type PullRequests } from "../src/prs.ts";
import { pendingRestack, restack, restackChildren } from "../src/stack.ts";
import type { Worker } from "../src/worker.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoPlan, threeRepos, writer, writeScript } from "./workspace.ts";

const dir = tempDir();

/** Records every call; PR states are set by the test. */
function fakePrs() {
  const calls: string[] = [];
  const bodies = new Map<string, string>();
  const states = new Map<string, PrState>();
  const notReady = new Map<string, string>();
  const failMerge = new Set<string>();
  let n = 0;
  const prs: PullRequests = {
    async open({ repoDir, head, base, title, body }) {
      const url = `https://github.com/acme/${repoDir.split("/").at(-1)}/pull/${++n}`;
      calls.push(`open ${url} ${head}->${base} ${title}`);
      bodies.set(url, body);
      states.set(url, { state: "open" });
      bases.set(url, base);
      branches.set(url, { repoDir, head });
      heads.set(url, await createGit(repoDir).revParse(head));
      opened.set(`${repoDir} ${head}`, url);
      return { url };
    },
    async find({ repoDir, head }) {
      const url = opened.get(`${repoDir} ${head}`);
      calls.push(`find ${head}${url ? ` ${url}` : ""}`);
      return url ? { url, state: (states.get(url) ?? { state: "open" }).state } : undefined;
    },
    async edit({ url, body }) {
      calls.push(`edit ${url}`);
      bodies.set(url, body);
    },
    async setBase({ url, base }) {
      calls.push(`setBase ${url} ${base}`);
      if (failSetBase.has(url)) throw new Error("base branch protected");
      bases.set(url, base);
    },
    async status({ url }) {
      const base = bases.get(url);
      return { ...(states.get(url) ?? { state: "open" }), ...(base ? { base } : {}) };
    },
    async readiness({ url }) {
      const why = notReady.get(url);
      if (why) return { ready: false, reason: why };
      // The head as pushed, once pushed: a restack moves it.
      const b = branches.get(url);
      const pushed = b ? await createGit(b.repoDir).remoteRef("origin", b.head) : undefined;
      return { ready: true, head: pushed ?? (heads.get(url) as string) };
    },
    async merge({ url, head }) {
      calls.push(`merge ${url} at ${head.slice(0, 7)}`);
      if (failMerge.has(url)) throw new Error("merge blocked by branch protection");
      const real = await hooks.onMerge?.(url, head);
      if (real) {
        states.set(url, { state: "merged", mergeCommit: real });
        return { mergeCommit: real };
      }
      const mergeCommit = String(n++).padStart(40, "0");
      states.set(url, { state: "merged", mergeCommit });
      return { mergeCommit };
    },
  };
  const heads = new Map<string, string>();
  const opened = new Map<string, string>();
  const bases = new Map<string, string>();
  const branches = new Map<string, { repoDir: string; head: string }>();
  const failSetBase = new Set<string>();
  /** Set by a test: merges for real (returns the merge commit) instead of pretending. */
  const hooks: { onMerge?: (url: string, head: string) => Promise<string | undefined> } = {};
  return { prs, calls, bodies, states, notReady, failMerge, heads, bases, failSetBase, hooks };
}

async function built(
  opts: {
    integration?: string;
    commands?: Record<string, { test?: string }>;
    lane?: "contained" | "wide";
  } = {},
) {
  const extra: Partial<Workspace> = opts.integration
    ? { integration: { gate: "./scripts/integration.sh" } }
    : {};
  const { root, workspace } = await threeRepos(dir(), extra);
  if (opts.integration) writeScript(root, "scripts/integration.sh", opts.integration);
  const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
  const options: RunPlanOptions = {
    ledger,
    workspace,
    workspaceRoot: root,
    brief,
    plan: crossRepoPlan(opts.lane),
    runId: "R1",
    changesetId: "C1",
    worker: writer,
    gates: [],
    config: { ...config, commands: opts.commands ?? {} },
    worktreesDir: join(dir(), "worktrees"),
    gateSandbox: (w) => openSandbox({ mode: "native", hostDir: w }),
    integrationSandbox: (d) => openSandbox({ mode: "native", hostDir: d }),
  };
  return { root, ledger, options, git: (r: string) => createGit(join(root, r)) };
}

/** Commits files straight onto `main` of a repo, as someone else pushing would. */
async function commitToMain(repoDir: string, files: Record<string, string>) {
  writeFiles(repoDir, files);
  await runOk(["git", "add", "-A"], { cwd: repoDir });
  await runOk(["git", "commit", "-qm", "upstream change"], { cwd: repoDir });
}

/** Event types without the effect bookkeeping around them. */
const types = (ledger: ReturnType<typeof openLedger>) =>
  ledger
    .read()
    .map((e) => e.event.type)
    .filter((t) => !t.startsWith("effect."));
const effects = (ledger: ReturnType<typeof openLedger>) =>
  ledger
    .read({ types: ["effect.done"] })
    .map(
      (e) =>
        `${(e.event.data as { key: string }).key} ${(e.event.data as { state: string }).state}`,
    );

describe("landing without remotes", () => {
  test("stages first, then fast-forwards every touched target in depends_on order", async () => {
    const { ledger, options, git } = await built();
    expect((await runPlan(options)).status).toBe("built");
    const heads = {
      proto: await git("proto").revParse("heph/R1"),
      server: await git("server").revParse("heph/R1"),
    };
    const webMain = await git("web").revParse("main");

    const protoMain = await git("proto").revParse("main");
    const out = await landChangeset(options);
    expect(out).toEqual({ status: "staged", refs: heads });
    expect(await git("proto").revParse("main")).toBe(protoMain);
    expect(ledger.run("R1")?.status).toBe("staged");

    expect(await mergeChangeset(options)).toEqual({ status: "merged" });
    expect(await git("proto").revParse("main")).toBe(heads.proto);
    expect(await git("server").revParse("main")).toBe(heads.server);
    expect(await git("web").revParse("main")).toBe(webMain);
    expect(await git("server").revParse("refs/heph/staging/R1")).toBe(heads.server);
    expect(types(ledger).slice(-3)).toEqual(["merge.staged", "merge.committed", "run.finished"]);
    const staged = ledger.read({ types: ["merge.staged"] })[0]?.event.data as {
      refs: Record<string, string>;
    };
    expect(Object.keys(staged.refs)).toEqual(["proto", "server"]);
    expect(ledger.run("R1")?.status).toBe("finished");
    ledger.close();
  });

  test("a moved target is rebased onto, re-gated and then landed", async () => {
    const { root, ledger, options, git } = await built({
      commands: { server: { test: "sh check.sh" } },
    });
    await runPlan(options);
    await commitToMain(join(root, "server"), { "NEWS.md": "upstream\n" });

    const out = await landChangeset(options);
    expect(out.status).toBe("staged");
    expect((await mergeChangeset(options)).status).toBe("merged");
    const main = await git("server").revParse("main");
    expect((await git("server").diff("main~3", main)).files).toEqual([
      "NEWS.md",
      "check.sh",
      "impl.sh",
    ]);
    const regate = ledger
      .read({ types: ["gate.result"] })
      .slice(-2)
      .map((e) => e.event.data as { gate: string; verdict: string });
    expect(regate).toMatchObject([
      { gate: "tests", verdict: "pass" },
      { gate: "integration", verdict: "pass" },
    ]);
    ledger.close();
  });

  test("a rebase conflict aborts with the files and lands nothing", async () => {
    const { root, ledger, options, git } = await built();
    await runPlan(options);
    const protoMain = await git("proto").revParse("main");
    await commitToMain(join(root, "server"), { "impl.sh": "echo upstream\n" });
    const serverMain = await git("server").revParse("main");

    const out = await landChangeset(options);
    expect(out).toMatchObject({ status: "aborted", reason: "rebase conflict in server: impl.sh" });
    expect(await git("proto").revParse("main")).toBe(protoMain);
    expect(await git("server").revParse("main")).toBe(serverMain);
    expect(types(ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    expect(ledger.run("R1")?.status).toBe("paused");
    ledger.close();
  });

  test("a red re-gate after a rebase aborts and lands nothing", async () => {
    const { root, ledger, options, git } = await built({ integration: "test ! -f server/BREAK\n" });
    expect((await runPlan(options)).status).toBe("built");
    await commitToMain(join(root, "server"), { BREAK: "x" });
    const protoMain = await git("proto").revParse("main");

    const out = await landChangeset(options);
    expect(out).toMatchObject({
      status: "aborted",
      reason: "re-gate after rebase failed: integration",
    });
    expect(await git("proto").revParse("main")).toBe(protoMain);
    ledger.close();
  });
});

describe("landChangeset with remotes", () => {
  async function withOrigins(repos: string[]) {
    const b = await built();
    for (const r of repos) {
      const origin = join(dir(), `${r}.git`);
      await runOk(["git", "clone", "-q", "--bare", join(b.root, r), origin]);
      await runOk(["git", "remote", "add", "origin", origin], { cwd: join(b.root, r) });
    }
    return b;
  }

  test("pushes each run branch and opens one PR per repo, in order, linking the others", async () => {
    const { ledger, options, git } = await withOrigins(["proto", "server"]);
    await runPlan(options);
    const fake = fakePrs();
    const out = await landChangeset({ ...options, prs: fake.prs });

    expect(out.status).toBe("staged");
    expect(out.prs).toEqual({
      proto: "https://github.com/acme/proto/pull/1",
      server: "https://github.com/acme/server/pull/2",
    });
    expect(fake.calls).toEqual([
      "find heph/R1",
      "open https://github.com/acme/proto/pull/1 heph/R1->main heph R1: loot drops reach the server",
      "find heph/R1",
      "open https://github.com/acme/server/pull/2 heph/R1->main heph R1: loot drops reach the server",
      "edit https://github.com/acme/proto/pull/1",
      "edit https://github.com/acme/server/pull/2",
    ]);
    expect(fake.bodies.get("https://github.com/acme/proto/pull/1")).toContain(
      "https://github.com/acme/server/pull/2",
    );
    expect(await git("server").remoteRef("origin", "heph/R1")).toBe(
      await git("server").revParse("heph/R1"),
    );
    expect(await git("server").revParse("main")).toBe(
      (await git("server").remoteRef("origin", "main")) as string,
    );
    expect(ledger.run("R1")?.status).toBe("staged");
    expect(ledger.read({ types: ["merge.staged"] })[0]?.event.data).toMatchObject({ prs: out.prs });

    expect(await checkChangeset({ ...options, prs: fake.prs })).toEqual({
      status: "open",
      open: Object.values(out.prs ?? {}),
    });
    fake.states.set("https://github.com/acme/proto/pull/1", {
      state: "merged",
      mergeCommit: "a".repeat(40),
    });
    fake.states.set("https://github.com/acme/server/pull/2", {
      state: "merged",
      mergeCommit: "b".repeat(40),
    });
    expect(await checkChangeset({ ...options, prs: fake.prs })).toEqual({ status: "merged" });
    expect(types(ledger).slice(-2)).toEqual(["merge.committed", "run.finished"]);
    expect(ledger.read({ types: ["merge.committed"] })[0]?.event.data).toEqual({
      refs: { proto: "a".repeat(40), server: "b".repeat(40) },
    });
    ledger.close();
  });

  test("a PR closed without merging aborts the changeset", async () => {
    const { ledger, options } = await withOrigins(["proto", "server"]);
    await runPlan(options);
    const fake = fakePrs();
    const out = await landChangeset({ ...options, prs: fake.prs });
    fake.states.set(out.prs?.server as string, { state: "closed" });
    expect(await checkChangeset({ ...options, prs: fake.prs })).toEqual({ status: "closed" });
    expect(types(ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    ledger.close();
  });

  test("mixed repos: PRs where there is a remote, local fast-forward for the rest once they merge", async () => {
    const { ledger, options, git } = await withOrigins(["proto"]);
    await runPlan(options);
    const fake = fakePrs();
    const serverMain = await git("server").revParse("main");
    const out = await landChangeset({ ...options, prs: fake.prs });
    expect(out).toMatchObject({
      status: "staged",
      prs: { proto: "https://github.com/acme/proto/pull/1" },
    });
    expect(await git("server").revParse("main")).toBe(serverMain);

    expect(await mergeChangeset({ ...options, prs: fake.prs })).toEqual({ status: "merged" });
    expect(await git("server").revParse("main")).toBe(await git("server").revParse("heph/R1"));
    expect(types(ledger).slice(-2)).toEqual(["merge.committed", "run.finished"]);
    ledger.close();
  });

  test("remotes without a pull request client are refused", async () => {
    const { ledger, options } = await withOrigins(["proto", "server"]);
    await runPlan(options);
    expect(await landChangeset(options)).toMatchObject({
      status: "aborted",
      reason: "no pull request client configured",
    });
    ledger.close();
  });
});

describe("autoMerge", () => {
  test("lands at once when every unit is contained", async () => {
    const { ledger, options } = await built();
    expect((await runPlan({ ...options, autoMerge: true })).status).toBe("landed");
    expect(ledger.run("R1")?.status).toBe("finished");
    ledger.close();
  });

  test("stops at built when any unit is not contained", async () => {
    const { ledger, options } = await built({ lane: "wide" });
    expect((await runPlan({ ...options, autoMerge: true })).status).toBe("built");
    ledger.close();
  });
});

describe("ghPullRequests", () => {
  test("builds the gh commands and parses their output", async () => {
    const seen: { cmd: string[]; cwd?: string }[] = [];
    const prs = ghPullRequests(async (cmd, opts) => {
      seen.push({ cmd, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      if (cmd[2] === "create") return "https://github.com/acme/server/pull/9\n";
      if (cmd[2] === "view")
        return JSON.stringify({ state: "MERGED", mergeCommit: { oid: "c".repeat(40) } });
      return "";
    });
    expect(
      await prs.open({ repoDir: "/r", head: "heph/R1", base: "main", title: "t", body: "b" }),
    ).toEqual({
      url: "https://github.com/acme/server/pull/9",
    });
    await prs.edit({ repoDir: "/r", url: "https://github.com/acme/server/pull/9", body: "b2" });
    expect(
      await prs.status({ repoDir: "/r", url: "https://github.com/acme/server/pull/9" }),
    ).toEqual({
      state: "merged",
      mergeCommit: "c".repeat(40),
    });
    expect(seen.map((s) => s.cmd.slice(0, 3).join(" "))).toEqual([
      "gh pr create",
      "gh api --hostname",
      "gh pr view",
    ]);
    // The body goes through the REST API: gh pr edit fails on older gh (Projects classic).
    expect(seen[1]?.cmd).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "-X",
      "PATCH",
      "repos/acme/server/pulls/9",
      "-f",
      "body=b2",
      "--silent",
    ]);
    expect(seen[0]?.cmd).toEqual([
      "gh",
      "pr",
      "create",
      "--head",
      "heph/R1",
      "--base",
      "main",
      "--title",
      "t",
      "--body",
      "b",
    ]);
    expect(seen.every((s) => s.cwd === "/r")).toBe(true);
  });
});

describe("mergeChangeset", () => {
  async function staged() {
    const b = await built();
    for (const r of ["proto", "server"]) {
      const origin = join(dir(), `${r}.git`);
      await runOk(["git", "clone", "-q", "--bare", join(b.root, r), origin]);
      await runOk(["git", "remote", "add", "origin", origin], { cwd: join(b.root, r) });
    }
    await runPlan(b.options);
    const fake = fakePrs();
    const out = await landChangeset({ ...b.options, prs: fake.prs });
    return { ...b, fake, out };
  }

  test("merges every PR in depends_on order once all are ready", async () => {
    const { ledger, options, fake, out } = await staged();
    expect(await mergeChangeset({ ...options, prs: fake.prs })).toEqual({ status: "merged" });
    expect(fake.calls.filter((c) => c.startsWith("merge")).map((c) => c.split(" ")[1])).toEqual([
      out.prs?.proto,
      out.prs?.server,
    ]);
    expect(types(ledger).slice(-2)).toEqual(["merge.committed", "run.finished"]);
    expect(ledger.run("R1")?.status).toBe("finished");
    ledger.close();
  });

  test("merges nothing while any PR is not ready", async () => {
    const { ledger, options, fake, out } = await staged();
    fake.notReady.set(out.prs?.server as string, "checks failing: ci");
    const before = types(ledger).length;
    expect(await mergeChangeset({ ...options, prs: fake.prs })).toEqual({
      status: "not_ready",
      reasons: [`server: checks failing: ci (${out.prs?.server})`],
    });
    expect(fake.calls.some((c) => c.startsWith("merge"))).toBe(false);
    expect(types(ledger)).toHaveLength(before);
    ledger.close();
  });

  test("a merge that fails after another landed is recorded loudly as half-landed", async () => {
    const { ledger, options, fake, out } = await staged();
    fake.failMerge.add(out.prs?.server as string);
    const r = await mergeChangeset({ ...options, prs: fake.prs });
    expect(r).toEqual({
      status: "half_landed",
      merged: ["proto"],
      reason: "half-landed: merged proto; server failed: merge blocked by branch protection",
    });
    expect(types(ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    ledger.close();
  });
});

describe("ghPullRequests setBase", () => {
  test("retargets the pull request base through the REST API", async () => {
    const seen: { cmd: string[]; cwd?: string }[] = [];
    const prs = ghPullRequests(async (cmd, opts) => {
      seen.push({ cmd, ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
      return "";
    });
    await prs.setBase({
      repoDir: "/r",
      url: "https://github.com/acme/server/pull/9",
      base: "main",
    });
    expect(seen).toEqual([
      {
        cmd: [
          "gh",
          "api",
          "--hostname",
          "github.com",
          "-X",
          "PATCH",
          "repos/acme/server/pulls/9",
          "-f",
          "base=main",
          "--silent",
        ],
        cwd: "/r",
      },
    ]);
  });
});

describe("ghPullRequests readiness and merge", () => {
  test("reads readiness from gh and merges at the expected head", async () => {
    const seen: string[][] = [];
    const views = [
      {
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        headRefOid: "d".repeat(40),
        statusCheckRollup: [{ conclusion: "SUCCESS" }],
      },
      {
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        headRefOid: "d".repeat(40),
        statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
      },
      {
        state: "OPEN",
        isDraft: false,
        mergeable: "UNKNOWN",
        headRefOid: "d".repeat(40),
        statusCheckRollup: [],
      },
      { state: "MERGED", mergeCommit: { oid: "e".repeat(40) } },
    ];
    const prs = ghPullRequests(async (cmd) => {
      seen.push(cmd);
      if (cmd[2] === "view") return JSON.stringify(views.shift());
      return "";
    });
    const at = { repoDir: "/r", url: "https://github.com/acme/server/pull/9" };
    expect(await prs.readiness(at)).toEqual({ ready: true, head: "d".repeat(40) });
    expect(await prs.readiness(at)).toEqual({ ready: false, reason: "checks failing: ci" });
    expect(await prs.readiness(at)).toEqual({
      ready: false,
      reason: "mergeability not computed yet, try again",
    });
    expect(await prs.merge({ ...at, head: "d".repeat(40) })).toEqual({
      mergeCommit: "e".repeat(40),
    });
    expect(seen.find((c) => c[2] === "merge")).toEqual([
      "gh",
      "pr",
      "merge",
      at.url,
      "--merge",
      "--match-head-commit",
      "d".repeat(40),
    ]);
  });
});

describe("mergeChangeset locally", () => {
  test("a target that moved after staging aborts and nothing lands", async () => {
    const { root, ledger, options, git } = await built();
    await runPlan(options);
    await landChangeset(options);
    const protoMain = await git("proto").revParse("main");
    await commitToMain(join(root, "server"), { "NEWS.md": "late\n" });
    const r = await mergeChangeset(options);
    expect(r).toMatchObject({ status: "aborted" });
    expect(await git("proto").revParse("main")).toBe(protoMain);
    ledger.close();
  });
});

describe("landing into a target you have checked out", () => {
  const status = (dir: string) => runOk(["git", "status", "--porcelain"], { cwd: dir });

  test("the checkout moves with it: files on disk, a clean status, your other edits kept", async () => {
    const { root, ledger, options } = await built();
    await runPlan(options);
    await landChangeset(options);
    writeFiles(join(root, "server"), { "README.md": "server, being edited\n" });
    expect(await mergeChangeset(options)).toEqual({ status: "merged" });
    expect(readFileSync(join(root, "proto", "loot.txt"), "utf8")).toBe("LootDrop\n");
    expect(readFileSync(join(root, "server", "impl.sh"), "utf8")).toBe("echo loot\n");
    expect(await status(join(root, "proto"))).toBe("");
    expect(await status(join(root, "server"))).toBe(" M README.md\n");
    expect(readFileSync(join(root, "server", "README.md"), "utf8")).toBe("server, being edited\n");
    ledger.close();
  });

  test("an edit the merge would overwrite aborts it, and the repos already moved go back", async () => {
    const { root, ledger, options, git } = await built();
    await runPlan(options);
    await landChangeset(options);
    const before = {
      proto: await git("proto").revParse("main"),
      server: await git("server").revParse("main"),
    };
    writeFiles(join(root, "server"), { "impl.sh": "mine\n" });
    const r = await mergeChangeset(options);
    expect(r).toMatchObject({ status: "aborted" });
    expect((r as { reason: string }).reason).toContain("impl.sh");
    expect(await git("proto").revParse("main")).toBe(before.proto);
    expect(await git("server").revParse("main")).toBe(before.server);
    expect(existsSync(join(root, "proto", "loot.txt"))).toBe(false);
    expect(await status(join(root, "proto"))).toBe("");
    expect(readFileSync(join(root, "server", "impl.sh"), "utf8")).toBe("mine\n");
    ledger.close();
  });
});

describe("landing again after a stop", () => {
  const stopAt = (point: string) => (p: string) => {
    if (p === point) throw new Error(`stopped at ${p}`);
  };

  async function withOrigins(repos: string[]) {
    const b = await built();
    for (const r of repos) {
      const origin = join(dir(), `${r}.git`);
      await runOk(["git", "clone", "-q", "--bare", join(b.root, r), origin]);
      await runOk(["git", "remote", "add", "origin", origin], { cwd: join(b.root, r) });
    }
    await runPlan(b.options);
    return b;
  }

  test("staging twice stages the same refs", async () => {
    const { ledger, options } = await built();
    await runPlan(options);
    const first = await landChangeset(options);
    expect(await landChangeset(options)).toEqual(first);
    ledger.close();
  });

  test("a merge stopped after one target moved finishes the rest", async () => {
    const { ledger, options, git } = await built();
    await runPlan(options);
    await landChangeset(options);
    await expect(
      mergeChangeset({ ...options, chaos: stopAt("after:target_advance:proto") }),
    ).rejects.toThrow("stopped");
    expect(await mergeChangeset(options)).toEqual({ status: "merged" });
    expect(await git("proto").revParse("main")).toBe(await git("proto").revParse("heph/R1"));
    expect(await git("server").revParse("main")).toBe(await git("server").revParse("heph/R1"));
    expect(effects(ledger).filter((e) => e.startsWith("target_advance"))).toEqual([
      "target_advance:proto confirmed",
      "target_advance:server applied",
    ]);
    ledger.close();
  });

  test("a pull request opened before a stop is reused", async () => {
    const { ledger, options } = await withOrigins(["proto", "server"]);
    const fake = fakePrs();
    await expect(
      landChangeset({ ...options, prs: fake.prs, chaos: stopAt("after:pr_open:proto") }),
    ).rejects.toThrow("stopped");
    const out = await landChangeset({ ...options, prs: fake.prs });
    expect(out.status).toBe("staged");
    expect(fake.calls.filter((c) => c.startsWith("open"))).toHaveLength(2);
    expect(out.prs?.proto).toBe("https://github.com/acme/proto/pull/1");
    expect(effects(ledger)).toContain("pr_open:proto confirmed");
    ledger.close();
  });

  test("a pull request merged before a stop counts as merged and is not merged again", async () => {
    const { ledger, options } = await withOrigins(["proto", "server"]);
    const fake = fakePrs();
    const staged = await landChangeset({ ...options, prs: fake.prs });
    await expect(
      mergeChangeset({ ...options, prs: fake.prs, chaos: stopAt("after:pr_merge:proto") }),
    ).rejects.toThrow("stopped");
    expect(await mergeChangeset({ ...options, prs: fake.prs })).toEqual({ status: "merged" });
    expect(fake.calls.filter((c) => c.startsWith("merge")).map((c) => c.split(" ")[1])).toEqual([
      staged.prs?.proto,
      staged.prs?.server,
    ]);
    expect(ledger.run("R1")?.status).toBe("finished");
    ledger.close();
  });

  test("a landing stopped after its rebase still re-gates before staging", async () => {
    const { root, ledger, options } = await built({
      commands: { server: { test: "sh check.sh" } },
    });
    await runPlan(options);
    await commitToMain(join(root, "server"), { "NEWS.md": "upstream\n" });
    await expect(
      landChangeset({ ...options, chaos: stopAt("after:rebase:server") }),
    ).rejects.toThrow("stopped");
    const gatesBefore = ledger.read({ types: ["gate.result"] }).length;
    expect((await landChangeset(options)).status).toBe("staged");
    const regate = ledger
      .read({ types: ["gate.result"] })
      .slice(gatesBefore)
      .map((e) => (e.event.data as { gate: string }).gate);
    expect(regate).toEqual(["tests", "integration"]);
    expect(effects(ledger)).toContain("rebase:server confirmed");
    ledger.close();
  });
});

describe("ghPullRequests preflight", () => {
  test("says why gh can't open pull requests for a repo, or nothing when it can", async () => {
    const answer = new Map<string, string | Error>([
      ["/w", "WRITE\n"],
      ["/r", "READ\n"],
      [
        "/x",
        new Error(
          "gh repo view exited 4: To get started with GitHub CLI, please run: gh auth login",
        ),
      ],
    ]);
    const prs = ghPullRequests(async (cmd, opts) => {
      expect(cmd).toEqual([
        "gh",
        "repo",
        "view",
        "--json",
        "viewerPermission",
        "-q",
        ".viewerPermission",
      ]);
      const a = answer.get(opts?.cwd ?? "");
      if (a instanceof Error) throw a;
      return a ?? "";
    });
    expect(await prs.preflight?.({ repoDir: "/w" })).toBeUndefined();
    expect(await prs.preflight?.({ repoDir: "/r" })).toBe(
      "gh's account has READ access, and opening pull requests needs WRITE",
    );
    expect(await prs.preflight?.({ repoDir: "/x" })).toBe(
      "gh can't reach the repo: gh repo view exited 4: To get started with GitHub CLI, please run: gh auth login",
    );
  });
});

describe("landing a stacked run", () => {
  const sh = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync(cmd, { cwd });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  /** Runs commands unconfined: what matters here is what the gates are given, not the sandbox. */
  const unconfined = async (d: string): Promise<Sandbox> => ({
    kind: "native",
    root: d,
    exec: async (command) => ({ ...sh(["sh", "-c", command], d), timedOut: false }),
    readFile: async () => "",
    writeFile: async () => {},
    dispose: async () => {},
  });
  const stask = (id: string, scope: string[], project = "server"): Task => ({
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
  /** Writes each unit's own file (its scope), with the unit id as content. */
  const scopeWriter: Worker = {
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

  /** A and B touch server only; server has an origin when `remote`. */
  async function fixture(o: { remote?: boolean } = {}) {
    const { root, workspace } = await threeRepos(dir(), {
      integration: { gate: "./scripts/integration.sh" },
    });
    writeScript(root, "scripts/integration.sh", "exit 0\n");
    const server = join(root, "server");
    if (o.remote) {
      for (const r of ["server", "web"]) {
        const origin = join(dir(), `${r}.git`);
        await runOk(["git", "clone", "-q", "--bare", join(root, r), origin]);
        await runOk(["git", "remote", "add", "origin", origin], { cwd: join(root, r) });
      }
    }
    const ledger = openLedger(join(dir(), "node"), { nodeId: "devserver" });
    const plans = new Map<string, Plan>();
    const fake = fakePrs();
    const opts = (runId: string, extra: Partial<RunPlanOptions> = {}): RunPlanOptions => ({
      ledger,
      workspace,
      workspaceRoot: root,
      brief,
      plan: plans.get(runId) as Plan,
      runId,
      changesetId: runId,
      worker: scopeWriter,
      gates: [],
      config: { ...config, commands: { server: { test: "true" } } },
      worktreesDir: join(dir(), "worktrees"),
      gateSandbox: (w) => unconfined(w),
      integrationSandbox: unconfined,
      prs: fake.prs,
      ...extra,
    });
    const build = async (runId: string, scopes: string[], stackOn?: string) => {
      plans.set(runId, {
        schema: 1,
        brief_hash: briefHash(brief),
        // "web:w.html" is a unit in web; a bare path one in server.
        tasks: scopes.map((s, i) => {
          const [project, file] = s.includes(":") ? s.split(":") : ["server", s];
          return stask(`${runId}${i + 1}`, [file as string], project);
        }),
        risks: [],
      });
      const out = await runPlan({ ...opts(runId), ...(stackOn ? { stackOn } : {}) });
      expect(out.status).toBe("built");
      return out;
    };
    const git = createGit(server);
    /** Commits onto server's main, and pushes it to origin when there is one. */
    const upstream = async (files: Record<string, string>, msg = "upstream change") => {
      writeFiles(server, files);
      await runOk(["git", "add", "-A"], { cwd: server });
      await runOk(["git", "commit", "-qm", msg], { cwd: server });
      if (o.remote) await runOk(["git", "push", "-q", "origin", "main"], { cwd: server });
      return git.revParse("main");
    };
    const finished = (runId: string) =>
      ledger.append({
        run_id: runId,
        changeset_id: runId,
        config_hash: "x",
        actor: "engine",
        type: "run.finished",
        data: {},
      });
    /** Commits on `branch` not on `from`, oldest first, as their subjects. */
    const commits = async (from: string, branch: string) =>
      (
        await runOk(["git", "log", "--reverse", "--format=%s", `${from}..${branch}`], {
          cwd: server,
        })
      )
        .split("\n")
        .filter(Boolean);
    const regates = (runId: string) =>
      ledger
        .read({ run_id: runId, types: ["gate.result"] })
        .map((e) => e.event.data as { gate: string; verdict: string });
    /** GitHub's merge button: a merge commit of the PR head into origin's main. */
    fake.hooks.onMerge = async (url, head) => {
      if (!o.remote) return undefined;
      const repoDir = join(root, url.split("/").at(-3) as string);
      await runOk(["git", "fetch", "-q", "origin", "main"], { cwd: repoDir });
      const tree = (
        await runOk(["git", "merge-tree", "--write-tree", "origin/main", head], { cwd: repoDir })
      )
        .trim()
        .split("\n")[0] as string;
      const sha = (
        await runOk(["git", "commit-tree", tree, "-p", "origin/main", "-p", head, "-m", "Merge"], {
          cwd: repoDir,
        })
      ).trim();
      await runOk(["git", "push", "-q", "origin", `${sha}:refs/heads/main`], { cwd: repoDir });
      return sha;
    };
    return { root, server, ledger, opts, build, git, fake, upstream, finished, commits, regates };
  }

  test("stacked_pr_opens_with_parent_branch_as_base", async () => {
    const f = await fixture({ remote: true });
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    const out = await landChangeset(f.opts("B"));
    expect(out.status).toBe("staged");
    expect(f.fake.calls.filter((c) => c.startsWith("open"))).toEqual([
      "open https://github.com/acme/server/pull/1 heph/A->main heph A: loot drops reach the server",
      "open https://github.com/acme/server/pull/2 heph/B->heph/A heph B: loot drops reach the server",
    ]);
    // Nothing moved under B: no rebase, its branch pushed as built.
    expect(effects(f.ledger).some((e) => e.startsWith("rebase"))).toBe(false);
    expect(await f.git.remoteRef("origin", "heph/B")).toBe(await f.git.revParse("heph/B"));
    f.ledger.close();
  });

  test("a stacked run whose parent is only built refuses to land where there is a remote", async () => {
    const f = await fixture({ remote: true });
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    expect(f.ledger.run("A")?.status).toBe("built");
    const intents = () => f.ledger.read({ run_id: "B", types: ["effect.intended"] }).length;
    const intended = intents();
    const out = await landChangeset(f.opts("B"));
    const reason = "stacked on A, which is not staged yet: land A first";
    expect(out).toMatchObject({ status: "aborted", reason });
    expect(types(f.ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    expect(f.ledger.read({ run_id: "B", types: ["merge.aborted"] })).toHaveLength(1);
    expect(f.ledger.read({ run_id: "B", types: ["run.paused"] })).toHaveLength(1);
    expect(f.ledger.read({ run_id: "B", types: ["merge.aborted"] })[0]?.event.data).toEqual({
      reason,
    });
    expect(await f.git.remoteRef("origin", "heph/B")).toBeUndefined();
    expect(await f.git.refSha("refs/heph/staging/B")).toBeUndefined();
    expect(f.fake.calls.some((c) => c.startsWith("open"))).toBe(false);
    expect(intents()).toBe(intended);

    // Once A is staged (its branch pushed), the same landing goes through.
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    expect((await landChangeset(f.opts("B"))).status).toBe("staged");
    expect(f.fake.calls.filter((c) => c.startsWith("open")).at(-1)).toContain("heph/B->heph/A");
    f.ledger.close();
  });

  test("a local-only stacked run lands on a parent that is only built", async () => {
    const f = await fixture();
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    expect(f.ledger.run("A")?.status).toBe("built");
    expect((await landChangeset(f.opts("B"))).status).toBe("staged");
    expect(await f.git.revParse("refs/heph/staging/B")).toBe(await f.git.revParse("heph/B"));
    f.ledger.close();
  });

  test("parent_moved_rebases_child_onto_new_parent_tip_and_regates", async () => {
    const f = await fixture({ remote: true });
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    const aBuilt = await f.git.revParse("heph/A");
    await f.upstream({ "NEWS.md": "upstream\n" });
    // A's own landing rebases A onto the moved target: A's tip moves under B.
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    const aTip = await f.git.revParse("heph/A");
    expect(aTip).not.toBe(aBuilt);

    const out = await landChangeset(f.opts("B"));
    expect(out.status).toBe("staged");
    expect(await f.git.forkPoint("heph/B", "B")).toBe(aTip);
    expect(await f.commits("heph/A", "heph/B")).toEqual(["B1"]);
    expect(effects(f.ledger)).toContain(`rebase:server:${aTip.slice(0, 7)} applied`);
    expect(f.regates("B").slice(-2)).toMatchObject([
      { gate: "tests", verdict: "pass" },
      { gate: "integration", verdict: "pass" },
    ]);
    expect(f.fake.calls.at(-2)).toBe(
      "open https://github.com/acme/server/pull/2 heph/B->heph/A heph B: loot drops reach the server",
    );
    f.ledger.close();
  });

  test("a child that conflicts with its moved parent aborts with the files; nothing pushed", async () => {
    const f = await fixture({ remote: true });
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    await f.upstream({ "b.sh": "upstream\n" });
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    const bBuilt = await f.git.revParse("heph/B");

    const out = await landChangeset(f.opts("B"));
    expect(out).toMatchObject({ status: "aborted", reason: "rebase conflict in server: b.sh" });
    expect(types(f.ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    expect(f.ledger.run("B")?.status).toBe("paused");
    expect(await f.git.revParse("heph/B")).toBe(bBuilt);
    expect(await f.git.remoteRef("origin", "heph/B")).toBeUndefined();
    expect(f.fake.calls.some((c) => c.includes("heph/B->"))).toBe(false);
    f.ledger.close();
  });

  test("parent_squash_merged_restacks_without_conflict", async () => {
    const f = await fixture({ remote: true });
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    const fork = await f.git.revParse("heph/A");
    const staged = await landChangeset(f.opts("A"));
    // GitHub squash-merges A with a review fix: A's commits are rewritten into one new commit,
    // so replaying A's own commit onto it would conflict.
    const squash = await f.upstream({ "a.sh": "A1 reviewed\n" }, "A squashed");
    f.fake.states.set(staged.prs?.server as string, { state: "merged", mergeCommit: squash });
    expect(await checkChangeset(f.opts("A"))).toEqual({ status: "merged" });
    expect(f.ledger.run("A")?.status).toBe("finished");

    expect(await f.git.forkPoint("heph/B", "B")).toBe(fork);
    const out = await landChangeset(f.opts("B"));
    expect(out.status).toBe("staged");
    expect(await f.commits("origin/main", "heph/B")).toEqual(["B1"]);
    expect(await f.git.forkPoint("heph/B", "B")).toBe(squash);
    expect(effects(f.ledger)).toContain(`rebase:server:${squash.slice(0, 7)} applied`);
    expect(f.fake.calls.at(-2)).toBe(
      "open https://github.com/acme/server/pull/2 heph/B->main heph B: loot drops reach the server",
    );
    f.ledger.close();
  });

  test("merge_before_parent_is_not_ready", async () => {
    const f = await fixture();
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    expect((await landChangeset(f.opts("B"))).status).toBe("staged");
    const main = await f.git.revParse("main");
    const before = f.ledger.read().length;
    expect(await mergeChangeset(f.opts("B"))).toEqual({
      status: "not_ready",
      reasons: ["waiting for A"],
    });
    expect(f.ledger.read()).toHaveLength(before);
    expect(await f.git.revParse("main")).toBe(main);
    f.ledger.close();
  });

  test("local_only_stack", async () => {
    const f = await fixture();
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    await f.upstream({ "NEWS.md": "upstream\n" });
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
    const aLanded = await f.git.revParse("main");
    expect(aLanded).toBe(await f.git.revParse("heph/A"));

    const out = await landChangeset(f.opts("B"));
    expect(out.status).toBe("staged");
    expect(effects(f.ledger)).toContain(`rebase:server:${aLanded.slice(0, 7)} applied`);
    expect(await f.git.revParse("refs/heph/staging/B")).toBe(await f.git.revParse("heph/B"));
    expect(await mergeChangeset(f.opts("B"))).toEqual({ status: "merged" });
    expect(await f.git.revParse("main")).toBe(await f.git.revParse("heph/B"));
    expect(await f.commits(aLanded, "main")).toEqual(["B1"]);
    expect(f.ledger.run("B")?.status).toBe("finished");
    f.ledger.close();
  });

  test("rebase_effect_key_includes_onto", async () => {
    const stopAt = (point: string) => (p: string) => {
      if (p === point) throw new Error(`stopped at ${p}`);
    };
    const f = await fixture();
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    await f.upstream({ "NEWS.md": "upstream\n" });
    expect((await landChangeset(f.opts("A"))).status).toBe("staged");
    const aTip = await f.git.revParse("heph/A");
    const first = `rebase:server:${aTip.slice(0, 7)}`;

    // Against A's moved branch, stopped after the rebase: the next landing confirms it and re-gates.
    await expect(landChangeset(f.opts("B", { chaos: stopAt(`after:${first}`) }))).rejects.toThrow(
      "stopped",
    );
    const gated = f.regates("B").length;
    expect((await landChangeset(f.opts("B"))).status).toBe("staged");
    expect(effects(f.ledger)).toContain(`${first} confirmed`);
    expect(
      f
        .regates("B")
        .slice(gated)
        .map((g) => g.gate),
    ).toEqual(["tests", "integration"]);
    expect(await f.commits("heph/A", "heph/B")).toEqual(["B1"]);

    // A lands and the target moves on: against the target now, stopped before the rebase.
    f.finished("A");
    const main = await f.upstream({ "LATER.md": "later\n" });
    const second = `rebase:server:${main.slice(0, 7)}`;
    expect(second).not.toBe(first);
    await expect(landChangeset(f.opts("B", { chaos: stopAt(`before:${second}`) }))).rejects.toThrow(
      "stopped",
    );
    expect((await landChangeset(f.opts("B"))).status).toBe("staged");
    expect(effects(f.ledger).filter((e) => e.startsWith(second))).toEqual([
      `${second} abandoned`,
      `${second} applied`,
    ]);
    expect(await f.commits("main", "heph/B")).toEqual(["B1"]);
    f.ledger.close();
  });

  test("a stack whose parent was revised back to planned refuses to land", async () => {
    const f = await fixture();
    await f.build("A", ["a.sh"]);
    await f.build("B", ["b.sh"], "A");
    f.ledger.append({
      run_id: "A",
      changeset_id: "A",
      config_hash: "x",
      actor: "engine",
      type: "run.plan_ready",
      data: { plan: f.opts("A").plan },
    });
    const bBuilt = await f.git.revParse("heph/B");
    const out = await landChangeset(f.opts("B"));
    expect(out).toMatchObject({
      status: "aborted",
      reason: "stacked on A, which is planned: wait for it to be built again, or rebuild this run",
    });
    expect(types(f.ledger).slice(-2)).toEqual(["merge.aborted", "run.paused"]);
    expect(f.ledger.read({ run_id: "B", types: ["run.paused"] })).toHaveLength(1);
    expect(await f.git.revParse("heph/B")).toBe(bBuilt);
    expect(effects(f.ledger).some((e) => e.startsWith("rebase"))).toBe(false);
    f.ledger.close();
  });
  describe("restack when the parent lands", () => {
    /** A, and children on A (each its own file), all staged as pull requests. */
    async function stagedStack(children: Record<string, string>) {
      const f = await fixture({ remote: true });
      await f.build("A", ["a.sh"]);
      for (const [id, file] of Object.entries(children)) await f.build(id, [file], "A");
      const urls: Record<string, string> = {};
      for (const id of ["A", ...Object.keys(children)]) {
        const out = await landChangeset(f.opts(id));
        expect(out.status).toBe("staged");
        urls[id] = out.prs?.server as string;
      }
      expect(f.fake.bases.get(urls.B as string)).toBe("heph/A");
      const optionsFor = (runId: string) => f.opts(runId);
      return { ...f, urls, optionsFor };
    }
    const mergesOf = (calls: string[], url: string) =>
      calls.filter((c) => c.startsWith(`merge ${url} `));
    const stagedEvents = (f: { ledger: ReturnType<typeof openLedger> }, runId: string) =>
      f.ledger.read({ run_id: runId, types: ["merge.staged"] }).length;

    test("parent_landing_retargets_child_pr_and_does_not_merge_it", async () => {
      const f = await stagedStack({ B: "b.sh" });
      const bBuilt = await f.git.revParse("heph/B");
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      expect(f.ledger.run("A")?.status).toBe("finished");
      const humans = f.ledger.read({ run_id: "B", types: ["human.input"] }).length;

      const out = await restack(f.opts("B"));
      expect(out).toMatchObject({ status: "staged", prs: { server: f.urls.B } });
      expect(f.fake.calls).toContain(`setBase ${f.urls.B} main`);
      expect(f.fake.bases.get(f.urls.B as string)).toBe("main");
      expect(mergesOf(f.fake.calls, f.urls.B as string)).toEqual([]);
      expect(f.ledger.run("B")?.status).toBe("staged");
      expect(stagedEvents(f, "B")).toBe(2);
      expect(f.ledger.read({ run_id: "B", types: ["human.input"] })).toHaveLength(humans);
      // Rebased --onto A's merge commit: only B's own commit on top of the target, re-gated, pushed.
      const main = await f.git.remoteRef("origin", "main");
      expect(await f.git.forkPoint("heph/B", "B")).toBe(main as string);
      expect(await f.git.revParse("heph/B")).not.toBe(bBuilt);
      expect(await f.commits("origin/main", "heph/B")).toEqual(["B1"]);
      expect(await f.git.remoteRef("origin", "heph/B")).toBe(await f.git.revParse("heph/B"));
      expect(f.regates("B").slice(-2)).toMatchObject([
        { gate: "tests", verdict: "pass" },
        { gate: "integration", verdict: "pass" },
      ]);
      expect(effects(f.ledger)).toContain("pr_retarget:server applied");
      // The same PR, reused: no second one opened for B.
      expect(
        f.fake.calls.filter((c) => c.startsWith("open") && c.includes("heph/B->")),
      ).toHaveLength(1);
      f.ledger.close();
    });

    test("two_children_of_one_parent_both_restack", async () => {
      const f = await stagedStack({ B: "b.sh", C: "c.sh" });
      expect(f.ledger.stackedOn("A")).toEqual(["B", "C"]);
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      const out = await restackChildren({ ledger: f.ledger, parentId: "A", options: f.optionsFor });
      expect(Object.keys(out)).toEqual(["B", "C"]);
      expect(out.B?.status).toBe("staged");
      expect(out.C?.status).toBe("staged");
      expect(f.fake.calls.filter((c) => c.startsWith("setBase"))).toEqual([
        `setBase ${f.urls.B} main`,
        `setBase ${f.urls.C} main`,
      ]);
      for (const id of ["B", "C"]) {
        expect(f.ledger.run(id)?.status).toBe("staged");
        expect(await f.commits("origin/main", `heph/${id}`)).toEqual([`${id}1`]);
      }
      expect(f.fake.calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
      f.ledger.close();
    });

    test("restack_conflict_aborts_child_only", async () => {
      const f = await stagedStack({ B: "b.sh", C: "c.sh" });
      // Someone else lands a b.sh on main: B's own commit no longer replays onto the target.
      await f.upstream({ "b.sh": "upstream\n" });
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      // A child whose retarget fails is aborted too, not thrown.
      f.fake.failSetBase.add(f.urls.C as string);

      const out = await restackChildren({ ledger: f.ledger, parentId: "A", options: f.optionsFor });
      expect(out.B).toMatchObject({ status: "aborted", reason: "rebase conflict in server: b.sh" });
      expect(out.C).toMatchObject({
        status: "aborted",
        reason: "restack failed: base branch protected",
      });
      expect(f.ledger.run("A")?.status).toBe("finished");
      for (const id of ["B", "C"]) {
        expect(f.ledger.run(id)?.status).toBe("paused");
        expect(f.ledger.read({ run_id: id, types: ["merge.aborted"] })).toHaveLength(1);
        expect(f.ledger.read({ run_id: id, types: ["run.paused"] })).toHaveLength(1);
      }
      expect(f.fake.calls).not.toContain(`setBase ${f.urls.B} main`);
      expect(f.fake.bases.get(f.urls.B as string)).toBe("heph/A");
      expect(f.fake.calls.filter((c) => c.startsWith("merge"))).toHaveLength(1);
      f.ledger.close();
    });

    for (const at of ["before", "after"] as const) {
      test(`pr_retarget_reconcile: stopped ${at} the retarget, a restack again ends the same`, async () => {
        const f = await stagedStack({ B: "b.sh" });
        expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
        const key = "pr_retarget:server";
        await expect(
          restack(
            f.opts("B", {
              chaos: (p) => {
                if (p === `${at}:${key}`) throw new Error(`stopped at ${p}`);
              },
            }),
          ),
        ).rejects.toThrow("stopped");
        expect(f.fake.bases.get(f.urls.B as string)).toBe(at === "before" ? "heph/A" : "main");

        const out = await restack(f.opts("B"));
        expect(out).toMatchObject({ status: "staged", prs: { server: f.urls.B } });
        expect(effects(f.ledger).filter((e) => e.startsWith(key))).toEqual([
          `${key} ${at === "before" ? "abandoned" : "confirmed"}`,
          `${key} applied`,
        ]);
        expect(f.fake.bases.get(f.urls.B as string)).toBe("main");
        // An already-retargeted PR is never patched again.
        expect(f.fake.calls.filter((c) => c.startsWith("setBase"))).toHaveLength(1);
        expect(f.ledger.run("B")?.status).toBe("staged");
        expect(await f.commits("origin/main", "heph/B")).toEqual(["B1"]);
        expect(await f.git.remoteRef("origin", "heph/B")).toBe(await f.git.revParse("heph/B"));
        expect(mergesOf(f.fake.calls, f.urls.B as string)).toEqual([]);
        f.ledger.close();
      });
    }

    test("a chain A<-B<-C: A landing restacks B only; C stays staged on B's branch", async () => {
      const f = await stagedStack({ B: "b.sh" });
      await f.build("C", ["c.sh"], "B");
      const c = await landChangeset(f.opts("C"));
      expect(c.status).toBe("staged");
      const urlC = c.prs?.server as string;
      expect(f.fake.bases.get(urlC)).toBe("heph/B");
      const cPushed = await f.git.remoteRef("origin", "heph/C");
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });

      const out = await restackChildren({ ledger: f.ledger, parentId: "A", options: f.optionsFor });
      expect(Object.keys(out)).toEqual(["B"]);
      expect(out.B?.status).toBe("staged");
      expect(f.ledger.run("C")?.status).toBe("staged");
      expect(f.fake.bases.get(urlC)).toBe("heph/B");
      expect(await f.git.remoteRef("origin", "heph/C")).toBe(cPushed);
      expect(f.fake.calls.filter((x) => x.startsWith("setBase"))).toEqual([
        `setBase ${f.urls.B} main`,
      ]);
      // C still waits for B.
      expect(await mergeChangeset(f.opts("C"))).toEqual({
        status: "not_ready",
        reasons: ["waiting for B"],
      });
      f.ledger.close();
    });

    test("a child that is not staged is skipped without error, also when it changed under the lock", async () => {
      const f = await stagedStack({ B: "b.sh" });
      await f.build("C", ["c.sh"], "A");
      expect(f.ledger.run("C")?.status).toBe("built");
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      // B is paused by someone else between the unlocked look and taking its lock.
      const around = async <T>(id: string, fn: () => Promise<T>) => {
        f.ledger.append({
          run_id: id,
          changeset_id: id,
          config_hash: "x",
          actor: "engine",
          type: "run.paused",
          data: { reason: "user" },
        });
        return fn();
      };
      const out = await restackChildren({
        ledger: f.ledger,
        parentId: "A",
        options: f.optionsFor,
        around,
      });
      expect(out).toEqual({ B: { status: "skipped", reason: "B is paused, not staged" } });
      expect(f.ledger.run("C")?.status).toBe("built");
      for (const id of ["B", "C"])
        expect(f.ledger.read({ run_id: id, types: ["merge.aborted"] })).toHaveLength(0);
      expect(f.fake.calls.some((x) => x.startsWith("setBase"))).toBe(false);
      f.ledger.close();
    });

    test("a stacked run in a repo its parent never touched merges with no restack", async () => {
      const f = await fixture({ remote: true });
      await f.build("A", ["a.sh"]);
      await f.build("B", ["web:w.html"], "A");
      expect((await landChangeset(f.opts("A"))).status).toBe("staged");
      const b = await landChangeset(f.opts("B"));
      const url = b.prs?.web as string;
      expect(f.fake.bases.get(url)).toBe("main");
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      expect(await mergeChangeset(f.opts("B"))).toEqual({ status: "merged" });
      expect(f.fake.calls.some((x) => x.startsWith("setBase"))).toBe(false);
      expect(f.ledger.run("B")?.status).toBe("finished");
      f.ledger.close();
    });

    for (const parentLanded of [false, true]) {
      test(`merge status of a child merged into its parent's branch is half-landed, never finished (parent ${parentLanded ? "landed" : "staged"})`, async () => {
        const f = await stagedStack({ B: "b.sh" });
        if (parentLanded) expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
        // The merge button on GitHub, with B's PR still based on heph/A.
        f.fake.states.set(f.urls.B as string, { state: "merged", mergeCommit: "9".repeat(40) });
        const reason = `half-landed: server: pull request merged into heph/A, not main (${f.urls.B})`;
        expect(await checkChangeset(f.opts("B"))).toEqual({ status: "half_landed", reason });
        expect(f.ledger.run("B")?.status).toBe("paused");
        expect(f.ledger.read({ run_id: "B", types: ["run.finished"] })).toHaveLength(0);
        expect(f.ledger.read({ run_id: "B", types: ["merge.aborted"] })[0]?.event.data).toEqual({
          reason,
        });
        expect(f.ledger.run("A")?.status).toBe(parentLanded ? "finished" : "staged");
        f.ledger.close();
      });
    }

    test("merge status of a child merged on the target before its parent landed is half-landed", async () => {
      const f = await stagedStack({ B: "b.sh" });
      f.fake.bases.set(f.urls.B as string, "main");
      f.fake.states.set(f.urls.B as string, { state: "merged", mergeCommit: "9".repeat(40) });
      const reason = `half-landed: server: pull request merged before A landed (${f.urls.B})`;
      expect(await checkChangeset(f.opts("B"))).toEqual({ status: "half_landed", reason });
      expect(f.ledger.run("B")?.status).toBe("paused");
      f.ledger.close();
    });

    test("a child GitHub retargeted by itself after its parent landed is not merged until restacked", async () => {
      const f = await stagedStack({ B: "b.sh" });
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      // heph/A auto-deleted on merge: GitHub points B's PR at main, but B was never restacked.
      f.fake.bases.set(f.urls.B as string, "main");
      expect(await pendingRestack(f.opts("B"))).toEqual({ server: "main" });
      const before = f.ledger.read().length;
      expect(await mergeChangeset(f.opts("B"))).toEqual({
        status: "not_ready",
        reasons: [
          `server: staged before A landed; heph approve merge B restacks it onto main first (${f.urls.B})`,
        ],
      });
      expect(f.ledger.read().length).toBe(before);
      expect(mergesOf(f.fake.calls, f.urls.B as string)).toEqual([]);

      expect((await restack(f.opts("B"))).status).toBe("staged");
      expect(await pendingRestack(f.opts("B"))).toEqual({});
      expect(await mergeChangeset(f.opts("B"))).toEqual({ status: "merged" });
      expect(mergesOf(f.fake.calls, f.urls.B as string)).toHaveLength(1);
      f.ledger.close();
    });

    test("restackChildren leaves a child already restacked since its parent landed alone", async () => {
      const f = await stagedStack({ B: "b.sh" });
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      const first = await restackChildren({
        ledger: f.ledger,
        parentId: "A",
        options: f.optionsFor,
      });
      expect(first.B?.status).toBe("staged");
      const gated = f.regates("B").length;
      const staged = stagedEvents(f, "B");
      const calls = f.fake.calls.length;

      expect(
        await restackChildren({ ledger: f.ledger, parentId: "A", options: f.optionsFor }),
      ).toEqual({});
      expect(f.regates("B")).toHaveLength(gated);
      expect(stagedEvents(f, "B")).toBe(staged);
      expect(f.fake.calls.slice(calls).filter((c) => !c.startsWith("find"))).toEqual([]);
      f.ledger.close();
    });

    test("a finished run's merge status writes nothing again", async () => {
      const f = await stagedStack({ B: "b.sh" });
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      const before = f.ledger.read().length;
      expect(await checkChangeset(f.opts("A"))).toEqual({ status: "merged" });
      expect(f.ledger.read().length).toBe(before);
      f.ledger.close();
    });

    test("a child whose PR is still based on the landed parent's branch is not merged", async () => {
      const f = await stagedStack({ B: "b.sh" });
      expect(await mergeChangeset(f.opts("A"))).toEqual({ status: "merged" });
      expect(await mergeChangeset(f.opts("B"))).toEqual({
        status: "not_ready",
        reasons: [
          `server: staged before A landed; heph approve merge B restacks it onto main first (${f.urls.B})`,
        ],
      });
      // Landed again on the target (heph run B never retargets): the PR base still guards it.
      expect((await landChangeset(f.opts("B"))).status).toBe("staged");
      const before = f.ledger.read().length;
      expect(await mergeChangeset(f.opts("B"))).toEqual({
        status: "not_ready",
        reasons: [
          `server: pull request is based on heph/A, not main; heph approve merge B restacks it onto main first (${f.urls.B})`,
        ],
      });
      expect(f.ledger.read().length).toBe(before);
      expect(mergesOf(f.fake.calls, f.urls.B as string)).toEqual([]);
      expect(f.ledger.run("B")?.status).toBe("staged");

      expect((await restack(f.opts("B"))).status).toBe("staged");
      expect(await mergeChangeset(f.opts("B"))).toEqual({ status: "merged" });
      expect(mergesOf(f.fake.calls, f.urls.B as string)).toHaveLength(1);
      expect(f.ledger.run("B")?.status).toBe("finished");
      f.ledger.close();
    });
  });
});
