// Stacked runs (design 3.1): a run built on another run's branch instead of the target.
import { resolve } from "node:path";
import type { Workspace } from "@hephaestus/core";
import type { Ledger } from "@hephaestus/ledger";
import { Stopped } from "./effects.ts";
import { runBranch, sinceLatestPlan, targetBase } from "./engine.ts";
import { createGit, type Git } from "./git.ts";
import {
  abortLanding,
  type LandOptions,
  type LandOutcome,
  landChangeset,
  retargetPullRequests,
} from "./land.ts";

/** A parent run can be built on only while its changeset is built or staged (not yet landed). */
export const STACKABLE = new Set(["built", "staged"]);

/**
 * One run up a stack: its id, status and, when known, the repos its latest plan touches (only
 * there is its branch its work: one in another repo is left over from an earlier plan).
 */
export type Ancestor = {
  runId: string;
  status?: string | undefined;
  repos?: readonly string[] | undefined;
};

/** The repos a run's latest plan built in: its run_branch_reset effects since that plan. */
export function latestPlanRepos(ledger: Ledger, runId: string): string[] {
  const repos = sinceLatestPlan(ledger, runId)
    .filter(
      (e) =>
        e.type === "effect.intended" &&
        (e.data as { effect?: string }).effect === "run_branch_reset" &&
        e.repo !== undefined,
    )
    .map((e) => e.repo as string);
  return [...new Set(repos)];
}

/**
 * The runs a run is stacked on, nearest first: its parent (`stackOn`, else its recorded
 * `stack_on`), the parent's parent, and so on up to a run with no `stack_on`.
 */
export function ancestorsOf(ledger: Ledger, runId: string, stackOn?: string): Ancestor[] {
  const out: Ancestor[] = [];
  const seen = new Set([runId]);
  let next = stackOn ?? ledger.run(runId)?.stack_on ?? undefined;
  while (next && !seen.has(next)) {
    seen.add(next);
    const row = ledger.run(next);
    out.push({ runId: next, status: row?.status, repos: latestPlanRepos(ledger, next) });
    next = row?.stack_on ?? undefined;
  }
  return out;
}

const unresolvedReason = (a: Ancestor) =>
  `stacked on ${a.runId}, which is ${a.status ?? "unknown"}: wait for it to be built again, or rebuild this run`;

/**
 * Why a stack has no known base, if it has none: an ancestor that is neither unmerged (built,
 * staged) nor landed (finished), e.g. revised back to planned, paused mid-rebuild or cancelled.
 */
export function unresolvedStack(ancestors: readonly Ancestor[]): string | undefined {
  const bad = ancestors.find(
    (a) => !a.status || (a.status !== "finished" && !STACKABLE.has(a.status)),
  );
  return bad ? unresolvedReason(bad) : undefined;
}

/** Thrown where a base is needed but the stack has none (see unresolvedStack). */
export class UnresolvedStack extends Error {
  override name = "UnresolvedStack";
}

/**
 * The branch a stacked run builds on in `repo`: the nearest ancestor that is unmerged (built or
 * staged) and has a branch here that its latest plan touches. A parent's branch holds its
 * ancestors' work only in repos it touched itself, so a repo it skipped falls through to the next
 * ancestor, as does a leftover branch from an earlier plan (that work will never ship); a landed
 * (finished) ancestor is skipped too, since its work is in the target. None: the target is the
 * base. Any other ancestor status throws UnresolvedStack: the base is unknown, never silently the
 * target.
 */
export async function ancestorBranch(
  git: Git,
  ancestors: readonly Ancestor[],
  repo: string | undefined,
): Promise<string | undefined> {
  for (const a of ancestors) {
    if (a.status === "finished") continue;
    if (!a.status || !STACKABLE.has(a.status)) throw new UnresolvedStack(unresolvedReason(a));
    if (a.repos && repo !== undefined && !a.repos.includes(repo)) continue;
    const branch = runBranch(a.runId);
    if (await git.refSha(branch)) return branch;
  }
  return undefined;
}

/**
 * Where a run's work in a repo starts: the nearest qualifying ancestor's branch (see
 * ancestorBranch), else the target. `stackOn`/`parentStatus` is shorthand for a one-run chain.
 */
export async function baseRef(o: {
  git: Git;
  /** The repo `git` is: an ancestor's branch counts only where its latest plan touches. */
  repo?: string | undefined;
  stackOn?: string | undefined;
  parentStatus?: string | undefined;
  ancestors?: readonly Ancestor[] | undefined;
  target: string;
}): Promise<string> {
  const chain = o.ancestors ?? (o.stackOn ? [{ runId: o.stackOn, status: o.parentStatus }] : []);
  return (await ancestorBranch(o.git, chain, o.repo)) ?? targetBase(o.git, o.target);
}

/**
 * Where a stacked run lands in a repo (design 3.2), by the same choice as baseRef: the nearest
 * qualifying ancestor's branch while one is unmerged (rebase onto its tip, open the PR against
 * it), else the target (onto `targetTip`, the PR against `target`).
 */
export async function ontoFor(o: {
  git: Git;
  repo?: string | undefined;
  stackOn?: string | undefined;
  parentStatus?: string | undefined;
  ancestors?: readonly Ancestor[] | undefined;
  target: string;
  targetTip: string;
}): Promise<{ onto: string; base: string }> {
  const chain = o.ancestors ?? (o.stackOn ? [{ runId: o.stackOn, status: o.parentStatus }] : []);
  const branch = await ancestorBranch(o.git, chain, o.repo);
  return branch
    ? { onto: await o.git.revParse(branch), base: branch }
    : { onto: o.targetTip, base: o.target };
}

type StackInput = {
  workspace: Workspace;
  workspaceRoot: string;
  ancestors: readonly Ancestor[];
};

/** Per repo that has an ancestor's branch (see ancestorBranch): what planning reads files from. */
export async function ancestorRefs(o: StackInput): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [r, path] of Object.entries(o.workspace.repos)) {
    const branch = await ancestorBranch(createGit(resolve(o.workspaceRoot, path)), o.ancestors, r);
    if (branch) refs[r] = branch;
  }
  return refs;
}

/**
 * What the integration gate assembles: touched repos at the run's branch, the rest at the
 * nearest ancestor's branch where one qualifies, else at their target.
 */
export async function stackRefs(
  o: StackInput & {
    runId: string;
    touched: string[];
    targets?: Record<string, string> | undefined;
  },
): Promise<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [r, path] of Object.entries(o.workspace.repos)) {
    refs[r] = o.touched.includes(r)
      ? runBranch(o.runId)
      : await baseRef({
          git: createGit(resolve(o.workspaceRoot, path)),
          repo: r,
          ancestors: o.ancestors,
          target: o.targets?.[r] ?? "main",
        });
  }
  return refs;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Restacks a staged run whose parent just landed (design 3.3): lands it again, which now rebases
 * it `--onto` the target past its fork point, re-gates if anything moved and pushes with lease,
 * then points each of its pull requests at the target (pr_retarget). Mechanical: it needs no
 * approval and merges nothing; the run stays staged for its own `heph approve merge`. A failure
 * is recorded on this run (merge.aborted, run paused) and returned, never thrown.
 */
export async function restack(opts: LandOptions): Promise<LandOutcome> {
  const status = opts.ledger.run(opts.runId)?.status;
  const parent = ancestorsOf(opts.ledger, opts.runId, opts.stackOn)[0];
  if (!parent) throw new Error(`run ${opts.runId} is not stacked`);
  if (status !== "staged") throw new Error(`run ${opts.runId} is ${status}, not staged`);
  if (parent.status !== "finished")
    throw new Error(`run ${opts.runId} is stacked on ${parent.runId}, which has not landed`);
  try {
    const out = await landChangeset(opts);
    if (out.status !== "staged" || !out.prs) return out;
    await retargetPullRequests(opts, out.prs);
    return out;
  } catch (e) {
    if (e instanceof Stopped) throw e;
    return abortLanding(opts, `restack failed: ${message(e)}`);
  }
}

/**
 * For a staged stacked run whose direct parent landed: the repos (and their targets) whose
 * open pull request is still based on something other than the target, i.e. a restack that
 * never finished. Empty when there is nothing to restack.
 */
export async function pendingRetargets(opts: LandOptions): Promise<Record<string, string>> {
  const parent = ancestorsOf(opts.ledger, opts.runId, opts.stackOn)[0];
  if (parent?.status !== "finished") return {};
  if (opts.ledger.run(opts.runId)?.status !== "staged" || !opts.prs) return {};
  const staged = opts.ledger.read({ run_id: opts.runId, types: ["merge.staged"] }).at(-1)?.event
    .data as { prs?: Record<string, string> } | undefined;
  const out: Record<string, string> = {};
  for (const [r, url] of Object.entries(staged?.prs ?? {})) {
    const target = opts.targets?.[r] ?? "main";
    const path = opts.workspace.repos[r];
    if (!path) continue;
    const s = await opts.prs.status({ repoDir: resolve(opts.workspaceRoot, path), url });
    if (s.state === "open" && s.base !== target) out[r] = target;
  }
  return out;
}

export type RestackOutcome = LandOutcome | { status: "skipped"; reason: string };

/**
 * After `parentId` landed: restacks each of its staged children, oldest first. `around` wraps
 * each child's restack (the CLI takes the child's run lock); one that fails before the restack
 * starts, or a child no longer staged once inside it, is skipped untouched. A child that fails
 * is aborted on its own: never thrown.
 */
export async function restackChildren(o: {
  ledger: Ledger;
  parentId: string;
  options: (runId: string) => LandOptions;
  around?: <T>(runId: string, fn: () => Promise<T>) => Promise<T>;
}): Promise<Record<string, RestackOutcome>> {
  const out: Record<string, RestackOutcome> = {};
  const around = o.around ?? ((_id, fn) => fn());
  for (const id of o.ledger.stackedOn(o.parentId)) {
    if (o.ledger.run(id)?.status !== "staged") continue;
    let started = false;
    try {
      out[id] = await around(id, async (): Promise<RestackOutcome> => {
        // Looked at again under the lock: it may have changed since the look above.
        const status = o.ledger.run(id)?.status;
        if (status !== "staged")
          return { status: "skipped", reason: `${id} is ${status}, not staged` };
        const parent = ancestorsOf(o.ledger, id)[0];
        if (parent?.status !== "finished")
          return { status: "skipped", reason: `${id}'s parent ${parent?.runId} has not landed` };
        started = true;
        return restack(o.options(id));
      });
    } catch (e) {
      if (e instanceof Stopped) throw e;
      if (!started) {
        out[id] = { status: "skipped", reason: message(e) };
        continue;
      }
      const reason = `restack failed: ${message(e)}`;
      try {
        out[id] = abortLanding(o.options(id), reason);
      } catch {
        out[id] = { status: "aborted", refs: {}, reason };
      }
    }
  }
  return out;
}
