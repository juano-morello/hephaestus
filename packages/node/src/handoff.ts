import { resolve } from "node:path";
import type { Plan, Workspace } from "@hephaestus/core";
import {
  type Chaos,
  createGit,
  effect,
  type RunBase,
  realityOf,
  reconcile,
  runBranch,
  Stopped,
  touchedRepos,
} from "@hephaestus/engine";
import type { Ledger } from "@hephaestus/ledger";
import type { Methods } from "./protocol.ts";
import { hello, type SyncResult, syncWith } from "./sync.ts";
import type { Transport } from "./transport.ts";
import { ensureWorkspace, fetchRunBranches, type WorkspaceDescription } from "./workspace.ts";

const REMOTE = "origin";
const TERMINAL = new Set(["finished", "failed"]);

/** The envelope fields a run's events share, from its run.created. */
export function runBase(ledger: Ledger, runId: string): RunBase {
  const created = ledger.read({ run_id: runId, types: ["run.created"] })[0]?.event;
  if (!created) throw new Error(`no run ${runId}`);
  return { run_id: runId, changeset_id: created.changeset_id, config_hash: created.config_hash };
}

const latestPlan = (ledger: Ledger, runId: string) =>
  (
    ledger.read({ run_id: runId, types: ["run.plan_ready"] }).at(-1)?.event.data as
      | { plan: Plan }
      | undefined
  )?.plan;

export type HandoffOptions = {
  ledger: Ledger;
  runId: string;
  /** The node taking the run, and a connection to it. */
  to: string;
  transport: Transport;
  workspace: Pick<Workspace, "repos" | "projects">;
  workspaceRoot: string;
  /** What the new owner needs to find or make its checkout. */
  description: WorkspaceDescription;
  /**
   * Stops this node's build of the run, if one is going, and waits until it has stopped. With
   * `waitMs` it lets attempts in flight finish for up to that long before interrupting them.
   */
  stopBuild?: (waitMs?: number) => Promise<void>;
  /** How long a build may keep finishing its attempts in flight before they are interrupted. */
  waitMs?: number;
  chaos?: Chaos;
};

/**
 * `heph handoff` (SPEC section 13), run by the owner: stop the build (an attempt in flight is
 * interrupted), push the run branches, write run.handed_off, sync, then ask the new owner to
 * take the run. After run.handed_off this node can no longer write the run's events; until the
 * new owner has synced, the run waits there.
 */
export async function handOff(
  o: HandoffOptions,
): Promise<{ pushed: string[]; synced: SyncResult; taken: TakeResult }> {
  const me = o.ledger.nodeId;
  const run = o.ledger.run(o.runId);
  if (!run) throw new Error(`no run ${o.runId}`);
  const peer = await hello(o.ledger, o.transport);
  if (peer.node !== o.to) throw new Error(`that peer is ${peer.node}, not ${o.to}`);
  // Already handed to `to` by this node: a handoff that stopped after run.handed_off. Finish it.
  const last = o.ledger.read({ run_id: o.runId, types: ["run.handed_off"] }).at(-1)?.event;
  if (run.owner_node === o.to && last?.node_id === me && (last.data as { to: string }).to === o.to)
    return { pushed: [], ...(await deliver(o)) };
  if (run.owner_node !== me)
    throw new Error(`run ${o.runId} is owned by ${run.owner_node}; hand it off from there`);
  if (TERMINAL.has(run.status)) throw new Error(`run ${o.runId} is ${run.status}`);
  if (o.to === me) throw new Error(`run ${o.runId} is already on ${me}`);

  const plan = latestPlan(o.ledger, o.runId);
  const repos = plan ? touchedRepos(o.workspace as Workspace, plan) : [];
  const dirOf = (r: string) => resolve(o.workspaceRoot, o.workspace.repos[r] as string);
  for (const r of repos) {
    if (!(await createGit(dirOf(r)).remoteUrl(REMOTE)))
      throw new Error(
        `can't hand off ${o.runId}: ${r} has no ${REMOTE} remote (git is the code transport)`,
      );
  }

  // The new owner makes its checkout first and says if a run there couldn't land; refused
  // here, nothing has happened yet and the build goes on.
  await o.transport.request("workspace.ensure", { workspace: o.description });

  await o.stopBuild?.(o.waitMs);
  // A handoff stopped halfway left its push pending; close it before going on.
  await reconcile(o.ledger, o.runId, realityOf({}, dirOf));

  // Git is the code transport: the run branches go to the remotes first.
  const scope = { ledger: o.ledger, base: runBase(o.ledger, o.runId), chaos: o.chaos };
  const branch = runBranch(o.runId);
  const pushed: string[] = [];
  for (const r of repos) {
    const git = createGit(dirOf(r));
    const sha = await git.refSha(branch);
    if (!sha) continue;
    const current = await git.remoteRef(REMOTE, branch);
    await effect(
      scope,
      {
        effect: "push",
        key: `push:${r}`,
        target: branch,
        before: current,
        after: sha,
        on: { repo: r },
      },
      async () => {
        if (current !== sha) await git.pushWithLease(REMOTE, sha, branch, current);
        return { sha };
      },
    );
    pushed.push(r);
  }

  await point(o.chaos, "before:run.handed_off");
  o.ledger.append({ ...scope.base, actor: "engine", type: "run.handed_off", data: { to: o.to } });
  await point(o.chaos, "after:run.handed_off");
  return { pushed, ...(await deliver(o)) };
}

/** The last steps: the new owner gets the events, then takes the run. */
async function deliver(o: HandoffOptions): Promise<{ synced: SyncResult; taken: TakeResult }> {
  const synced = await syncWith(o.ledger, o.transport);
  await point(o.chaos, "after:sync");
  const taken = await o.transport.request<TakeResult>("run.take", {
    run_id: o.runId,
    workspace: o.description,
  });
  return { synced, taken };
}

async function point(chaos: Chaos | undefined, p: string) {
  try {
    await chaos?.(p);
  } catch (e) {
    throw e instanceof Stopped ? e : new Stopped(e instanceof Error ? e.message : String(e));
  }
}

export type TakeResult = { dir: string; fetched: string[] };

/**
 * The new owner's side: make sure this node has the workspace and the run's branches. The run
 * must already be handed to this node (or adopted by it); resuming the build is the caller's
 * (the daemon's) call. Safe to repeat.
 */
export async function takeOver(o: {
  ledger: Ledger;
  runId: string;
  workspace: WorkspaceDescription;
  home: string;
  workspaces: Record<string, string>;
}): Promise<TakeResult> {
  const run = o.ledger.run(o.runId);
  if (!run) throw new Error(`no run ${o.runId} here yet; sync first`);
  if (run.owner_node !== o.ledger.nodeId)
    throw new Error(`run ${o.runId} is owned by ${run.owner_node}, not ${o.ledger.nodeId}`);
  const { dir } = await ensureWorkspace(o.workspace, { home: o.home, workspaces: o.workspaces });
  const repos = Object.fromEntries(Object.entries(o.workspace.repos).map(([r, x]) => [r, x.path]));
  return { dir, fetched: await fetchRunBranches(dir, { repos }, o.runId) };
}

/** `run.take` for a node's peer methods; `onTaken` lets the daemon resume the build. */
export function takeMethods(o: {
  ledger: Ledger;
  home: string;
  workspaces: Record<string, string>;
  onTaken?: (runId: string, dir: string) => void | Promise<void>;
}): Methods {
  return {
    "run.take": async (p: { run_id: string; workspace: WorkspaceDescription }) => {
      const taken = await takeOver({ ...o, runId: p.run_id, workspace: p.workspace });
      await o.onTaken?.(p.run_id, taken.dir);
      return taken;
    },
  };
}

/**
 * `heph adopt`: take a run over from an owner that is gone. Refused while the owner answers,
 * unless forced: two nodes writing one run is exactly what single ownership prevents.
 */
export async function adopt(o: {
  ledger: Ledger;
  runId: string;
  ownerReachable: () => Promise<boolean>;
  force?: boolean;
  reason?: string;
}): Promise<{ from: string }> {
  const run = o.ledger.run(o.runId);
  if (!run) throw new Error(`no run ${o.runId} here; sync first`);
  const from = run.owner_node;
  if (from === o.ledger.nodeId) throw new Error(`run ${o.runId} is already owned by this node`);
  if (TERMINAL.has(run.status)) throw new Error(`run ${o.runId} is ${run.status}`);
  if (!o.force && (await o.ownerReachable()))
    throw new Error(
      `${from} answers; hand the run off from there (heph handoff ${o.runId} ${o.ledger.nodeId}), or adopt with --force`,
    );
  o.ledger.append({
    ...runBase(o.ledger, o.runId),
    actor: "human",
    type: "run.adopted",
    data: { from, reason: o.reason ?? (o.force ? "forced" : `${from} unreachable`) },
  });
  return { from };
}
