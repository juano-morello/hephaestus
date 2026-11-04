import { join, resolve } from "node:path";
import type { GateResult, Task, Workspace } from "@hephaestus/core";
import type { EventDraft, Ledger } from "@hephaestus/ledger";
import { lintGate, testsGate, typecheckGate } from "./builtin-gates.ts";
import { configHash } from "./config.ts";
import { integrationGate, type RunPlanOptions, runBranch, touchedRepos } from "./engine.ts";
import { createGit, type Git } from "./git.ts";
import type { PullRequests } from "./prs.ts";

const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

export type LandOptions = Omit<RunPlanOptions, "worker" | "autoMerge"> & {
  prs?: PullRequests;
  /** Default "origin". */
  remote?: string;
};

export type LandOutcome = {
  status: "landed" | "staged" | "aborted";
  refs: Record<string, string>;
  prs?: Record<string, string>;
  reason?: string;
};

/** Repos in depends_on order: a repo whose projects depend on another repo's projects goes after it. */
export function repoOrder(workspace: Workspace, repos: string[]): string[] {
  const repoOf = (p: string) => workspace.projects[p]?.repo;
  const deps = new Map(repos.map((r) => [r, new Set<string>()]));
  for (const project of Object.values(workspace.projects)) {
    for (const d of project.depends_on ?? []) {
      const from = repoOf(d);
      if (from && from !== project.repo && deps.has(project.repo) && deps.has(from))
        deps.get(project.repo)?.add(from);
    }
  }
  const out: string[] = [];
  const visit = (r: string, path: Set<string>) => {
    if (out.includes(r) || path.has(r)) return;
    path.add(r);
    for (const d of deps.get(r) ?? []) visit(d, path);
    out.push(r);
  };
  for (const r of repos) visit(r, new Set());
  return out;
}

function context(opts: LandOptions) {
  const hash = configHash(
    opts.config,
    opts.gates.map((g) => g.name),
  );
  const base = { run_id: opts.runId, changeset_id: opts.changesetId, config_hash: hash };
  const repos = repoOrder(opts.workspace, touchedRepos(opts.workspace, opts.plan));
  const dirOf = (r: string) => resolve(opts.workspaceRoot, opts.workspace.repos[r] as string);
  const gits = new Map<string, Git>(repos.map((r) => [r, createGit(dirOf(r))]));
  return {
    base,
    repos,
    gits,
    dirOf,
    remote: opts.remote ?? "origin",
    target: (r: string) => opts.targets?.[r] ?? "main",
  };
}

function abort(
  ledger: Ledger,
  base: object,
  reason: string,
  refs: Record<string, string>,
): LandOutcome {
  const engine = { ...base, actor: "engine" as const } as EventDraft & { actor: "engine" };
  ledger.appendMany([
    { ...engine, type: "merge.aborted", data: { reason } },
    { ...engine, type: "run.paused", data: { reason: "user" } },
  ] as EventDraft[]);
  return { status: "aborted", refs, reason };
}

/**
 * Lands a built changeset as a set (SPEC section 4). Targets that moved are rebased onto and
 * re-gated first; nothing lands unless every repo can. With remotes, each repo gets a pull
 * request (you merge them); without, every target is fast-forwarded in depends_on order.
 */
export async function landChangeset(opts: LandOptions): Promise<LandOutcome> {
  const { ledger } = opts;
  const { base, repos, gits, dirOf, remote, target } = context(opts);
  const branch = runBranch(opts.runId);

  const remotes = new Map<string, boolean>();
  for (const r of repos) remotes.set(r, (await gits.get(r)?.remoteUrl(remote)) !== undefined);
  const withRemote = repos.filter((r) => remotes.get(r));
  // Repos with a remote land as pull requests; any without one fast-forward once those merge.
  const viaPrs = withRemote.length > 0;
  if (viaPrs && !opts.prs) return abort(ledger, base, "no pull request client configured", {});

  // 1. Rebase any run branch whose target moved since the run started.
  const tips = new Map<string, string>();
  const rebased: string[] = [];
  for (const r of repos) {
    const git = gits.get(r) as Git;
    const hasRemote = remotes.get(r) === true;
    if (hasRemote) await git.fetch(remote, target(r));
    const tip = await git.revParse(hasRemote ? `${remote}/${target(r)}` : target(r));
    tips.set(r, tip);
    if ((await git.mergeBase(branch, tip)) === tip) continue;
    const res = await git.rebase(join(opts.worktreesDir, opts.runId, `_rebase-${r}`), branch, tip);
    if (!res.ok)
      return abort(ledger, base, `rebase conflict in ${r}: ${res.conflicts.join(", ")}`, {});
    rebased.push(r);
  }

  // 2. Re-gate the rebased changeset: configured project commands, then the integration gate.
  if (rebased.length) {
    const failed = await regate(opts, repos, gits, base);
    if (failed) return abort(ledger, base, `re-gate after rebase failed: ${failed}`, {});
  }

  const refs: Record<string, string> = {};
  for (const r of repos) refs[r] = await (gits.get(r) as Git).revParse(branch);
  const engine = { ...base, actor: "engine" as const };

  // 3a. Pull requests: push every branch, open one PR per repo in order, then link them all.
  if (viaPrs) {
    const prs = opts.prs as PullRequests;
    const urls: Record<string, string> = {};
    for (const r of repos) {
      await (gits.get(r) as Git).setRef(`refs/heph/staging/${opts.runId}`, refs[r] as string);
    }
    for (const r of withRemote) {
      const git = gits.get(r) as Git;
      await git.pushWithLease(
        remote,
        refs[r] as string,
        branch,
        await git.remoteRef(remote, branch),
      );
    }
    for (const r of withRemote) {
      const { url } = await prs.open({
        repoDir: dirOf(r),
        head: branch,
        base: target(r),
        title: prTitle(opts),
        body: prBody(opts, r, withRemote, {}),
      });
      urls[r] = url;
    }
    for (const r of withRemote)
      await prs.edit({
        repoDir: dirOf(r),
        url: urls[r] as string,
        body: prBody(opts, r, withRemote, urls),
      });
    ledger.append({ ...engine, type: "merge.staged", data: { refs, prs: urls } });
    return { status: "staged", refs, prs: urls };
  }

  // 3b. Local: staging refs only; mergeChangeset fast-forwards the targets (heph approve merge).
  for (const r of repos) {
    await (gits.get(r) as Git).setRef(`refs/heph/staging/${opts.runId}`, refs[r] as string);
  }
  ledger.append({ ...engine, type: "merge.staged", data: { refs } });
  return { status: "staged", refs };
}

async function regate(
  opts: LandOptions,
  repos: string[],
  gits: Map<string, Git>,
  base: object,
): Promise<string | undefined> {
  const projects = [...new Set(opts.plan.tasks.map((t) => t.project))];
  const results: GateResult[] = [];
  const events: EventDraft[] = [];
  for (const r of repos) {
    const git = gits.get(r) as Git;
    const wt = join(opts.worktreesDir, opts.runId, `_regate-${r}`);
    await git.worktreeAddDetached(wt, runBranch(opts.runId));
    try {
      for (const p of projects.filter((p) => opts.workspace.projects[p]?.repo === r)) {
        const commands = opts.config.commands[p] ?? {};
        const projectPath = opts.workspace.projects[p]?.path ?? ".";
        const workdir = join(wt, projectPath === "." ? "" : projectPath);
        // A regression check of what the project configures; nothing configured, nothing to run.
        const gates = [
          ...(commands.test ? [testsGate] : []),
          ...(commands.typecheck ? [typecheckGate] : []),
          ...(commands.lint ? [lintGate] : []),
        ];
        if (!gates.length) continue;
        const task: Task = {
          ...(opts.plan.tasks.find((t) => t.project === p) as Task),
          kind: "implement",
          scope: ["**"],
        };
        const sandbox = opts.gateSandbox ? await opts.gateSandbox(workdir, task) : undefined;
        try {
          for (const g of gates) {
            const res = await g.run({
              task,
              attempt: 1,
              project: p,
              projectPath,
              workdir,
              diff: { files: [], text: "" },
              lockedPaths: [],
              worker: { schema: 1, summary: "", claims: [], touched: [] },
              commands,
              timeoutMs: opts.config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
              ...(sandbox ? { sandbox } : {}),
            });
            results.push(res);
            events.push({
              ...base,
              repo: r,
              project: p,
              actor: "gate",
              type: "gate.result",
              data: res,
            } as EventDraft);
          }
        } finally {
          await sandbox?.dispose();
        }
      }
    } finally {
      await git.worktreeRemove(wt);
    }
  }
  const integration = await integrationGate(opts, repos);
  results.push(integration);
  events.push({ ...base, actor: "gate", type: "gate.result", data: integration } as EventDraft);
  opts.ledger.appendMany(events);
  return results.find((x) => x.verdict === "fail")?.gate;
}

const prTitle = (opts: LandOptions) => {
  const t = `heph ${opts.runId}: ${opts.brief.goal}`;
  return t.length > 72 ? `${t.slice(0, 69)}...` : t;
};

function prBody(
  opts: LandOptions,
  repo: string,
  repos: string[],
  urls: Record<string, string>,
): string {
  const units = opts.plan.tasks
    .filter((t) => opts.workspace.projects[t.project]?.repo === repo)
    .map((t) => `- \`${t.id}\` ${t.kind} (${t.lane}): ${t.title}`);
  const lines = [
    `Hephaestus changeset \`${opts.changesetId}\` (run \`${opts.runId}\`), one of ${repos.length} pull request${repos.length === 1 ? "" : "s"} that land together.`,
    "",
    `**Goal:** ${opts.brief.goal}`,
    "",
    "**Units in this repo:**",
    ...units,
  ];
  if (Object.keys(urls).length) {
    lines.push("", "**All pull requests in this changeset** (merge in this order):");
    for (const r of repos) lines.push(`- ${r}: ${urls[r]}${r === repo ? " (this one)" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

type Staged = { refs: Record<string, string>; prs?: Record<string, string> };

function lastStaged(opts: LandOptions, needPrs = false): Staged {
  const staged = opts.ledger.read({ run_id: opts.runId, types: ["merge.staged"] }).at(-1)?.event
    .data as Staged | undefined;
  if (!staged) throw new Error(`run ${opts.runId} has nothing staged`);
  if (needPrs && !staged.prs) throw new Error(`run ${opts.runId} has no pull requests staged`);
  return staged;
}

/** Repos staged without a PR (no remote): fast-forward their targets, all or none. */
async function finishLocal(opts: LandOptions, staged: Staged): Promise<Record<string, string>> {
  const { repos, gits, target } = context(opts);
  const local = repos.filter((r) => staged.refs[r] && !staged.prs?.[r]);
  const moved: { r: string; from: string }[] = [];
  try {
    for (const r of local) {
      const git = gits.get(r) as Git;
      const to = staged.refs[r] as string;
      const from = await git.revParse(target(r));
      if ((await git.mergeBase(to, from)) !== from)
        throw new Error(`${target(r)} in ${r} moved since staging`);
      await git.updateRef(target(r), to, from);
      moved.push({ r, from });
    }
  } catch (e) {
    for (const { r, from } of moved.reverse()) {
      await (gits.get(r) as Git).updateRef(target(r), from, staged.refs[r] as string);
    }
    throw e;
  }
  return Object.fromEntries(local.map((r) => [r, staged.refs[r] as string]));
}

function committed(opts: LandOptions, base: object, refs: Record<string, string>) {
  const engine = { ...base, actor: "engine" as const };
  opts.ledger.appendMany([
    { ...engine, type: "merge.committed", data: { refs } },
    { ...engine, type: "run.finished", data: {} },
  ] as EventDraft[]);
}

export type MergeOutcome =
  | { status: "merged" }
  | { status: "not_ready"; reasons: string[] }
  | { status: "half_landed"; merged: string[]; reason: string }
  | { status: "aborted"; reason: string };

/**
 * `heph approve merge` for a changeset staged as pull requests: merges nothing unless every PR
 * is ready, then merges them in depends_on order, then fast-forwards any local-only repos.
 * A merged PR can't be undone, so a failure after the first merge is recorded as half-landed.
 */
export async function mergeChangeset(opts: LandOptions): Promise<MergeOutcome> {
  const { base, repos, dirOf } = context(opts);
  const staged = lastStaged(opts);
  const order = repos.filter((r) => staged.prs?.[r]);
  if (order.length && !opts.prs) throw new Error("no pull request client configured");
  const prs = opts.prs as PullRequests;

  const reasons: string[] = [];
  for (const r of order) {
    const url = staged.prs?.[r] as string;
    const ready = await prs.readiness({ repoDir: dirOf(r), url });
    if (!ready.ready) reasons.push(`${r}: ${ready.reason} (${url})`);
    else if (ready.head !== staged.refs[r]) {
      reasons.push(
        `${r}: head moved to ${ready.head.slice(0, 7)}, staged ${staged.refs[r]?.slice(0, 7)} (${url})`,
      );
    }
  }
  if (reasons.length) return { status: "not_ready", reasons };

  const refs: Record<string, string> = {};
  const merged: string[] = [];
  for (const r of order) {
    try {
      const { mergeCommit } = await prs.merge({
        repoDir: dirOf(r),
        url: staged.prs?.[r] as string,
        head: staged.refs[r] as string,
      });
      refs[r] = mergeCommit;
      merged.push(r);
    } catch (e) {
      const why = `${r} failed: ${e instanceof Error ? e.message : e}`;
      if (!merged.length) {
        abort(opts.ledger, base, `merge failed: ${why}`, staged.refs);
        return { status: "aborted", reason: `merge failed: ${why}` };
      }
      const reason = `half-landed: merged ${merged.join(", ")}; ${why}`;
      abort(opts.ledger, base, reason, staged.refs);
      return { status: "half_landed", merged, reason };
    }
  }
  try {
    Object.assign(refs, await finishLocal(opts, staged));
  } catch (e) {
    const why = `local fast-forward failed: ${e instanceof Error ? e.message : e}`;
    // finishLocal rolls its own moves back, so with no PR merged nothing has landed.
    if (!merged.length) {
      abort(opts.ledger, base, why, staged.refs);
      return { status: "aborted", reason: why };
    }
    const reason = `half-landed: merged ${merged.join(", ")}; ${why}`;
    abort(opts.ledger, base, reason, staged.refs);
    return { status: "half_landed", merged, reason };
  }
  committed(opts, base, refs);
  return { status: "merged" };
}

export type CheckOutcome =
  | { status: "merged" }
  | { status: "closed" }
  | { status: "open"; open: string[] }
  | { status: "half_landed"; reason: string };

/** For a changeset staged as pull requests: finish the run once all are merged, abort if one closed. */
export async function checkChangeset(opts: LandOptions): Promise<CheckOutcome> {
  const { base, dirOf } = context(opts);
  const staged = lastStaged(opts, true);
  if (!opts.prs) throw new Error("no pull request client configured");

  const states = await Promise.all(
    Object.entries(staged.prs ?? {}).map(async ([r, url]) => ({
      r,
      url,
      ...(await (opts.prs as PullRequests).status({ repoDir: dirOf(r), url })),
    })),
  );
  const closed = states.find((s) => s.state === "closed");
  if (closed) {
    abort(opts.ledger, base, `pull request closed without merging: ${closed.url}`, staged.refs);
    return { status: "closed" };
  }
  const open = states.filter((s) => s.state === "open").map((s) => s.url);
  if (open.length) return { status: "open", open };

  const refs: Record<string, string> = Object.fromEntries(
    states.map((s) => [s.r, s.mergeCommit ?? (staged.refs[s.r] as string)]),
  );
  try {
    Object.assign(refs, await finishLocal(opts, staged));
  } catch (e) {
    abort(
      opts.ledger,
      base,
      `half-landed: PRs merged; local fast-forward failed: ${e instanceof Error ? e.message : e}`,
      staged.refs,
    );
    return { status: "half_landed", reason: "PRs merged; local fast-forward failed" };
  }
  committed(opts, base, refs);
  return { status: "merged" };
}
