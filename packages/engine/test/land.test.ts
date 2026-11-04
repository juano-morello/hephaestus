import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Workspace } from "@hephaestus/core";
import { openLedger } from "@hephaestus/ledger";
import { openSandbox, runOk } from "@hephaestus/sandbox";
import { type RunPlanOptions, runPlan } from "../src/engine.ts";
import { createGit } from "../src/git.ts";
import { checkChangeset, landChangeset } from "../src/land.ts";
import { ghPullRequests, type PrState, type PullRequests } from "../src/prs.ts";
import { tempDir, writeFiles } from "./helpers.ts";
import { brief, config, crossRepoPlan, threeRepos, writer, writeScript } from "./workspace.ts";

const dir = tempDir();

/** Records every call; PR states are set by the test. */
function fakePrs() {
  const calls: string[] = [];
  const bodies = new Map<string, string>();
  const states = new Map<string, PrState>();
  let n = 0;
  const prs: PullRequests = {
    async open({ repoDir, head, base, title, body }) {
      const url = `https://github.com/acme/${repoDir.split("/").at(-1)}/pull/${++n}`;
      calls.push(`open ${url} ${head}->${base} ${title}`);
      bodies.set(url, body);
      states.set(url, { state: "open" });
      return { url };
    },
    async edit({ url, body }) {
      calls.push(`edit ${url}`);
      bodies.set(url, body);
    },
    async status({ url }) {
      return states.get(url) ?? { state: "open" };
    },
  };
  return { prs, calls, bodies, states };
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

const types = (ledger: ReturnType<typeof openLedger>) => ledger.read().map((e) => e.event.type);

describe("landChangeset without remotes", () => {
  test("fast-forwards every touched target in depends_on order and finishes the run", async () => {
    const { ledger, options, git } = await built();
    expect((await runPlan(options)).status).toBe("built");
    const heads = {
      proto: await git("proto").revParse("heph/R1"),
      server: await git("server").revParse("heph/R1"),
    };
    const webMain = await git("web").revParse("main");

    const out = await landChangeset(options);
    expect(out).toEqual({ status: "landed", refs: heads });
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
    expect(out.status).toBe("landed");
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
      "open https://github.com/acme/proto/pull/1 heph/R1->main heph R1: loot drops reach the server",
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

  test("some repos with a remote and some without is refused", async () => {
    const { ledger, options, git } = await withOrigins(["proto"]);
    await runPlan(options);
    const out = await landChangeset({ ...options, prs: fakePrs().prs });
    expect(out).toMatchObject({
      status: "aborted",
      reason: "mixed local and remote repos: proto has origin, server does not",
    });
    expect(await git("proto").remoteRef("origin", "heph/R1")).toBeUndefined();
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
      "gh pr edit",
      "gh pr view",
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
