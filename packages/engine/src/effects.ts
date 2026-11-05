import { rmSync } from "node:fs";
import { join } from "node:path";
import type { EffectKind, EventDraft, Ledger, LedgerEvent } from "@hephaestus/ledger";
import type { Git } from "./git.ts";
import type { PullRequests } from "./prs.ts";

/**
 * Test hook: called just before and just after every effect, with `before:<key>` or
 * `after:<key>`. A chaos test throws from it to stop the run between intent and confirm.
 */
export type Chaos = (point: string) => void | Promise<void>;

/**
 * A simulated kill. Whatever a chaos hook throws becomes one, and code that turns failures
 * into ledger events (an abort, a half-landed merge) lets it through: a killed process
 * writes nothing.
 */
export class Stopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stopped";
  }
}

async function point(scope: EffectScope, p: string) {
  try {
    await scope.chaos?.(p);
  } catch (e) {
    throw e instanceof Stopped ? e : new Stopped(e instanceof Error ? e.message : String(e));
  }
}

/** The envelope every event of a run shares. */
export type RunBase = { run_id: string; changeset_id: string; config_hash: string };

export type EffectScope = { ledger: Ledger; base: RunBase; chaos?: Chaos | undefined };

export type Intent = {
  effect: EffectKind;
  key: string;
  target: string;
  before?: string | undefined;
  after?: string | undefined;
  /** Envelope fields for the intent and done events: the repo, and the unit it belongs to. */
  on?: { repo?: string; project?: string; unit_id?: string; attempt?: number };
};

export type Applied = { sha?: string | undefined; url?: string | undefined };

const clean = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Intent, effect, confirm (SPEC section 13). `with` is appended atomically with the intent, and
 * `followedBy` atomically with effect.done, so the events that justify and follow an effect are
 * never split from it by a crash.
 */
export async function effect<T extends Applied | undefined>(
  scope: EffectScope,
  intent: Intent,
  apply: () => Promise<T>,
  opts: { with?: EventDraft[]; followedBy?: (result: T) => EventDraft[] } = {},
): Promise<T> {
  const env = { ...scope.base, ...intent.on, actor: "engine" as const };
  const { effect: kind, key, target, before, after } = intent;
  scope.ledger.appendMany([
    ...(opts.with ?? []),
    { ...env, type: "effect.intended", data: clean({ effect: kind, key, target, before, after }) },
  ]);
  await point(scope, `before:${key}`);
  let result: T;
  try {
    result = await apply();
  } catch (e) {
    if (e instanceof Stopped) throw e;
    // It failed rather than stopped: say so, so nothing is left pending.
    scope.ledger.appendMany([
      { ...env, type: "effect.done", data: { effect: kind, key, state: "abandoned" } },
    ]);
    throw e;
  }
  await point(scope, `after:${key}`);
  scope.ledger.appendMany([
    {
      ...env,
      type: "effect.done",
      data: clean({ effect: kind, key, state: "applied", sha: result?.sha, url: result?.url }),
    },
    ...(opts.followedBy?.(result) ?? []),
  ]);
  return result;
}

type Intended = LedgerEvent<"effect.intended">;

/** Effects whose latest event is the intent: the process stopped before confirming them. */
export function pendingEffects(ledger: Ledger, runId: string): Intended[] {
  const latest = new Map<string, LedgerEvent>();
  for (const { event } of ledger.read({
    run_id: runId,
    types: ["effect.intended", "effect.done"],
  })) {
    latest.set((event.data as { key: string }).key, event as LedgerEvent);
  }
  return [...latest.values()].filter((e): e is Intended => e.type === "effect.intended");
}

/** What a resume can look at to decide whether a pending effect happened. */
export type Reality = {
  git(repo: string): Git;
  dirOf(repo: string): string;
  prs?: PullRequests | undefined;
  /** Default "origin". */
  remote?: string | undefined;
};

type Verdict = {
  state: "applied" | "confirmed" | "abandoned";
  sha?: string | undefined;
  url?: string | undefined;
  follow?: EventDraft[];
};

export class ReconcileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileError";
  }
}

/** The unit.accepted that follows a run-branch advance, built from the intent's envelope. */
function acceptedFor(e: Intended): EventDraft {
  return clean({
    run_id: e.run_id,
    changeset_id: e.changeset_id,
    config_hash: e.config_hash,
    repo: e.repo,
    project: e.project,
    unit_id: e.unit_id,
    attempt: e.attempt,
    actor: "engine" as const,
    type: "unit.accepted" as const,
    data: {},
  }) as EventDraft;
}

async function check(e: Intended, reality: Reality): Promise<Verdict> {
  const d = e.data;
  const repo = e.repo;
  const git = repo ? reality.git(repo) : undefined;
  const ref = async (r: string) => git?.refSha(r);
  const remote = reality.remote ?? "origin";
  switch (d.effect) {
    case "run_branch_advance": {
      if (!git || !d.before || !d.after)
        throw new ReconcileError(`${d.key}: incomplete intent, cannot reconcile`);
      const tip = await ref(d.target);
      if (tip === d.after) return { state: "confirmed", sha: tip, follow: [acceptedFor(e)] };
      if (tip === d.before) {
        await git.updateRef(d.target, d.after, d.before);
        return { state: "applied", sha: d.after, follow: [acceptedFor(e)] };
      }
      throw new ReconcileError(
        `${d.key}: ${d.target} in ${repo} is at ${tip?.slice(0, 7) ?? "nothing"}, expected ${d.before.slice(0, 7)} or ${d.after.slice(0, 7)}; something else moved it`,
      );
    }
    case "run_branch_reset":
    case "staging_ref":
    case "target_advance": {
      const at = await ref(d.target);
      return at && at === d.after ? { state: "confirmed", sha: at } : { state: "abandoned" };
    }
    case "rebase": {
      // Only a rebase moves the run branch during landing, so a moved branch means it finished.
      const at = await ref(d.target);
      return at && at !== d.before ? { state: "confirmed", sha: at } : { state: "abandoned" };
    }
    case "push": {
      const at = git ? await git.remoteRef(remote, d.target) : undefined;
      return at && at === d.after ? { state: "confirmed", sha: at } : { state: "abandoned" };
    }
    case "pr_open": {
      if (!repo || !reality.prs) return { state: "abandoned" };
      const pr = await reality.prs.find({ repoDir: reality.dirOf(repo), head: d.target });
      return pr ? { state: "confirmed", url: pr.url } : { state: "abandoned" };
    }
    case "pr_merge": {
      if (!repo || !reality.prs) return { state: "abandoned" };
      const s = await reality.prs.status({ repoDir: reality.dirOf(repo), url: d.target });
      return s.state === "merged"
        ? { state: "confirmed", sha: s.mergeCommit, url: d.target }
        : { state: "abandoned" };
    }
    case "pr_retarget": {
      // Already based on the branch it was pointed at: done. Else retargeting again is harmless.
      if (!repo || !reality.prs || !d.after) return { state: "abandoned" };
      const s = await reality.prs.status({ repoDir: reality.dirOf(repo), url: d.target });
      return s.base === d.after ? { state: "confirmed", url: d.target } : { state: "abandoned" };
    }
    case "pr_edit":
      // Editing a body again is harmless; the step that wanted it runs again.
      return { state: "abandoned" };
  }
}

/**
 * Closes every pending effect of a run against reality: confirmed if it happened, applied if it
 * can be finished from the intent, abandoned if not (its step then runs again). Returns what
 * was decided, in order.
 */
export async function reconcile(
  ledger: Ledger,
  runId: string,
  reality: Reality,
): Promise<{ key: string; state: Verdict["state"] }[]> {
  const out: { key: string; state: Verdict["state"] }[] = [];
  for (const e of pendingEffects(ledger, runId)) {
    const v = await check(e, reality);
    ledger.appendMany([
      clean({
        run_id: e.run_id,
        changeset_id: e.changeset_id,
        config_hash: e.config_hash,
        repo: e.repo,
        project: e.project,
        unit_id: e.unit_id,
        attempt: e.attempt,
        actor: "engine" as const,
        type: "effect.done" as const,
        data: clean({
          effect: e.data.effect,
          key: e.data.key,
          state: v.state,
          sha: v.sha,
          url: v.url,
        }),
      }) as EventDraft,
      ...(v.follow ?? []),
    ]);
    out.push({ key: e.data.key, state: v.state });
  }
  return out;
}

/** Removes whatever a stopped process left under `<worktreesDir>/<run>`, then prunes each repo. */
export async function clearWorktrees(worktreesDir: string, runId: string, gits: Git[]) {
  rmSync(join(worktreesDir, runId), { recursive: true, force: true });
  for (const git of gits) await git.prune();
}
