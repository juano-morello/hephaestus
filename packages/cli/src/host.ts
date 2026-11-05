// The node (SPEC sections 7 and 16): one ledger, a runtime per workspace, and the routing that
// sends a command for a run to the node that owns it. The daemon serves a host; without a
// daemon the CLI opens one in-process.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ghPullRequests } from "@hephaestus/engine";
import { type Ledger, type LedgerEvent, openLedger } from "@hephaestus/ledger";
import {
  adopt,
  describeWorkspace,
  ensureWorkspace,
  fetchRunBranches,
  handOff,
  hello,
  type Methods,
  PeerError,
  prepareWorkspace,
  sshTransport,
  syncMethods,
  syncWith,
  type Transport,
  takeMethods,
  type WorkspaceDescription,
} from "@hephaestus/node";
import { type HomeConfig, loadConfig } from "./config.ts";
import { type Deps, openRuntime } from "./runtime.ts";
import { hephVersion } from "./version.ts";

/** Run commands that change the run: only its owner may carry them out. */
const OWNER_ONLY = new Set([
  "revise",
  "approvePlan",
  "hint",
  "cancel",
  "approveMerge",
  "mergeStatus",
  "build",
]);
/** What only the daemon can answer: it holds the build jobs. */
const DAEMON_ONLY = new Set(["run", "follow", "resume"]);

export type HostOptions = {
  home: string;
  config: HomeConfig;
  deps?: Deps;
  /** Tests: how to reach a node. Default: ssh to `nodes.<id>`. */
  connect?: (node: string) => Transport;
  onAppend?: (events: LedgerEvent[]) => void;
  notify?: (line: string) => void;
  /** The daemon's host: builds run as background jobs instead of in the foreground. */
  daemon?: boolean;
  /** `--set` overrides for every workspace's config. */
  overrides?: Record<string, unknown>;
  /** For a `heph peer` process: hand builds to this node's daemon when one is running. */
  localDaemon?: () => Promise<
    { call(method: string, args: unknown[]): Promise<unknown> } | undefined
  >;
};

type Job = {
  controller: AbortController;
  promise: Promise<void>;
  done: boolean;
  result?: unknown;
  error?: string;
};

export type Host = ReturnType<typeof openHost>;

export function openHost(o: HostOptions) {
  const me = o.config.node.id;
  const ledger: Ledger = openLedger(o.home, {
    nodeId: me,
    ...(o.onAppend ? { onAppend: o.onAppend } : {}),
  });
  const jobs = new Map<string, Job>();
  /**
   * A runtime on a workspace's current config: loaded for every command, so a long-running
   * daemon sees edits to the config files (they are small; loading is cheap). Runtimes share
   * the node's ledger and hold nothing else that needs closing.
   */
  const runtimeFor = async (workspaceDir: string) => {
    const loaded = await loadConfig({
      workspaceDir,
      home: o.home,
      nodeId: me,
      ...(o.overrides ? { overrides: o.overrides } : {}),
    });
    return {
      rt: openRuntime({
        loaded,
        workspaceDir,
        home: o.home,
        ledger,
        ...(o.deps ? { deps: o.deps } : {}),
        ...(o.notify ? { notify: o.notify } : {}),
      }),
      workspace: loaded.config.workspace,
    };
  };

  const checkoutOf = (name: string) =>
    o.config.workspaces[name] ?? join(o.home, "workspaces", name);

  /** Where a run's workspace is on this node: where it was created, or this node's checkout. */
  const workspaceOf = (runId: string): string => {
    const e = ledger.read({ run_id: runId, types: ["run.created"] })[0]?.event;
    if (!e) throw new Error(`no run ${runId} on ${me} (heph sync?)`);
    const d = e.data as { workspace_root?: string; workspace_name?: string };
    if (e.node_id === me && d.workspace_root && existsSync(d.workspace_root))
      return d.workspace_root;
    if (d.workspace_name && existsSync(checkoutOf(d.workspace_name)))
      return checkoutOf(d.workspace_name);
    if (d.workspace_root && existsSync(d.workspace_root)) return d.workspace_root;
    throw new Error(`run ${runId}: no checkout of workspace ${d.workspace_name ?? "?"} on ${me}`);
  };

  const connect = (node: string): Transport => {
    if (o.connect) return o.connect(node);
    const peer = o.config.nodes[node];
    if (!peer) throw new Error(`unknown node ${node}; add it under nodes: in ~/.heph/config.yaml`);
    return sshTransport(peer);
  };
  const withPeer = async <T>(node: string, fn: (t: Transport) => Promise<T>): Promise<T> => {
    const t = connect(node);
    try {
      return await fn(t);
    } finally {
      await t.close();
    }
  };
  const reachable = async (node: string) => {
    try {
      await withPeer(node, (t) => hello(ledger, t));
      return true;
    } catch {
      return false;
    }
  };
  const ownerOf = (runId: string) => {
    const row = ledger.run(runId);
    if (!row) throw new Error(`no run ${runId} on ${me} (heph sync?)`);
    return row.owner_node;
  };
  /** Pulls the owner's latest events; false when it can't be reached. */
  const refresh = async (runId: string): Promise<boolean> => {
    const owner = ownerOf(runId);
    if (owner === me) return true;
    try {
      await withPeer(owner, (t) => syncWith(ledger, t));
      return true;
    } catch {
      return false;
    }
  };
  /**
   * The checkout's description to send with a command for a run another node owns, when the
   * command comes from a checkout of the run's workspace: the owner then runs it with this
   * checkout's heph files (SPEC section 7). Undefined otherwise.
   */
  const senderFiles = async (runId: string, cwd: string | undefined) => {
    if (!cwd) return undefined;
    const name = (
      ledger.read({ run_id: runId, types: ["run.created"] })[0]?.event.data as
        | { workspace_name?: string }
        | undefined
    )?.workspace_name;
    try {
      const { workspace } = await runtimeFor(cwd);
      if (!name || workspace.name !== name) return undefined;
      return await describeWorkspace(cwd, workspace);
    } catch {
      return undefined;
    }
  };

  /** A command for a run another node owns, carried out there; then this node catches up. */
  const forward = async (owner: string, method: string, args: unknown[], cwd?: string) => {
    const files =
      DAEMON_ONLY.has(method) && method !== "run"
        ? undefined
        : await senderFiles(args[0] as string, cwd);
    return withPeer(owner, async (t) => {
      if (files) await t.request("workspace.files", { workspace: files });
      const result = await t.request("rpc", { method, args });
      await syncWith(ledger, t);
      return result;
    });
  };

  const rateLimited = (runId: string) => {
    if (ledger.run(runId)?.status !== "paused") return false;
    const p = ledger.read({ run_id: runId, types: ["run.paused"] }).at(-1)?.event.data as
      | { reason: string }
      | undefined;
    return p?.reason === "rate_limit";
  };

  const startJob = async (
    runId: string,
    opts: { now?: boolean } = {},
  ): Promise<{ run_id: string; started: boolean; running?: boolean; after?: string }> => {
    // Followers start here: what the run did before is in heph explain, not printed again.
    const last = ledger.read({ run_id: runId }).at(-1)?.event.id;
    const after = last ? { after: last } : {};
    const running = jobs.get(runId);
    if (running && !running.done) return { run_id: runId, started: false, running: true, ...after };
    const { rt } = await runtimeFor(workspaceOf(runId));
    const controller = new AbortController();
    const job: Job = { controller, done: false, promise: Promise.resolve() };
    job.promise = rt
      .build(runId, { ...opts, signal: controller.signal })
      .then((r) => {
        job.result = r;
      })
      .catch((e) => {
        job.error = e instanceof Error ? e.message : String(e);
        o.notify?.(`run ${runId}: ${job.error}`);
      })
      .finally(() => {
        job.done = true;
        // A rate limit pauses the build; the daemon is the scheduler, so it goes again (the
        // build itself waits for retry_after first). SPEC section 13.
        if (o.daemon && !controller.signal.aborted && rateLimited(runId)) void startJob(runId);
      });
    jobs.set(runId, job);
    return { run_id: runId, started: true, ...after };
  };
  /** Runs this node is handing off right now: their followers wait for the new owner. */
  const handingOff = new Set<string>();

  const stopJob = async (runId: string, reason: string) => {
    const job = jobs.get(runId);
    if (!job || job.done) return;
    job.controller.abort(reason);
    await job.promise;
  };

  /** A run this node now owns after a handoff or adoption: resume it if it was building. */
  const resumeTaken = async (runId: string) => {
    const status = ledger.run(runId)?.status;
    if (status !== "paused" && status !== "running") return;
    if (o.daemon) await startJob(runId);
    else {
      const d = await o.localDaemon?.();
      if (d) await d.call("resume", [runId]);
    }
  };

  /** What this node needs to take a workspace's runs: its checkout, and a way to land them. */
  const prepare = (workspace: WorkspaceDescription) =>
    prepareWorkspace(workspace, {
      node: me,
      home: o.home,
      workspaces: o.config.workspaces,
      prs: o.deps?.prs ?? ghPullRequests(),
    });

  /** Everything this node answers for its peers (`heph peer`). */
  const peerMethods = (): Methods => ({
    ...syncMethods(ledger, { version: hephVersion().version }),
    "workspace.ensure": (p: { workspace: WorkspaceDescription }) => prepare(p.workspace),
    "workspace.files": (p: { workspace: WorkspaceDescription }) =>
      ensureWorkspace(p.workspace, { home: o.home, workspaces: o.config.workspaces }),
    ...takeMethods({
      ledger,
      home: o.home,
      workspaces: o.config.workspaces,
      onTaken: (runId) => resumeTaken(runId),
    }),
    rpc: async (p: { method: string; args: unknown[] }) => {
      const runId = p.args[0] as string;
      if (ownerOf(runId) !== me) throw new PeerError(`run ${runId} is not owned by ${me}`);
      // A build must outlive this ssh session: it goes to this node's daemon.
      if (DAEMON_ONLY.has(p.method) && !o.daemon) {
        const d = await o.localDaemon?.();
        if (!d) throw new PeerError(`heph daemon is not running on ${me}; start it there first`);
        return d.call(p.method, p.args);
      }
      return api.call(p.method, p.args, undefined);
    },
    "run.new": async (p: {
      workspace: WorkspaceDescription;
      brief: unknown;
      runId?: string;
      stackOn?: string;
    }) => {
      const { dir } = await prepare(p.workspace);
      const { rt } = await runtimeFor(dir);
      return rt.newRun(p.brief, {
        ...(p.runId ? { runId: p.runId } : {}),
        ...(p.stackOn ? { stackOn: p.stackOn } : {}),
      });
    },
  });

  /** Picks the node a new run goes to (SPEC section 7): asked for, else preferred if it answers. */
  const placeNew = async (on: string | undefined): Promise<string> => {
    if (on && on !== "local") {
      if (on !== me && !o.config.nodes[on] && !o.connect) throw new Error(`unknown node ${on}`);
      return on;
    }
    if (on === "local") return me;
    const preferred = Object.entries(o.config.nodes).find(([, n]) => n.preferred)?.[0];
    if (preferred && preferred !== me && (await reachable(preferred))) return preferred;
    return me;
  };

  const api = {
    /** The single entry point: `heph <command>` maps to one method here, in-process or daemon. */
    async call(method: string, args: unknown[], cwd: string | undefined): Promise<unknown> {
      switch (method) {
        case "newRun": {
          const [brief, opts] = args as [
            unknown,
            { runId?: string; on?: string; stackOn?: string },
          ];
          if (!cwd) throw new Error("newRun needs a workspace");
          const runOpts = {
            ...(opts?.runId ? { runId: opts.runId } : {}),
            ...(opts?.stackOn ? { stackOn: opts.stackOn } : {}),
          };
          const here = async (placed?: string) => {
            const { rt } = await runtimeFor(cwd);
            return {
              ...(await rt.newRun(brief, runOpts)),
              node: me,
              ...(placed ? { placed } : {}),
            };
          };
          // A stacked run goes where its parent is: the parent's branches are on that node.
          const parentOwner = opts?.stackOn ? ownerOf(opts.stackOn) : undefined;
          if (parentOwner) {
            const asked = opts?.on === "local" ? me : opts?.on;
            if (asked && asked !== parentOwner)
              throw new Error(
                `--stack-on ${opts?.stackOn} runs on ${parentOwner}, its parent's owner, not on ${asked}`,
              );
          }
          if (parentOwner === me || opts?.on === "local" || opts?.on === me) return here();
          const { workspace } = await runtimeFor(cwd);
          let description: WorkspaceDescription;
          try {
            description = await describeWorkspace(cwd, workspace);
          } catch (e) {
            // Can't leave this node (a repo has no remote): fine unless a node was asked for.
            if (opts?.on || parentOwner || !(e instanceof Error)) throw e;
            const preferred = Object.entries(o.config.nodes).find(([, n]) => n.preferred)?.[0];
            if (!preferred || preferred === me) return here();
            return here(
              `here: ${e.message.replace("a run on another node", `a run on ${preferred}`)}`,
            );
          }
          const node = parentOwner ?? (await placeNew(opts?.on));
          if (node === me) return here();
          const result = await withPeer(node, async (t) => {
            const r = await t.request<Record<string, unknown>>("run.new", {
              workspace: description,
              brief,
              ...runOpts,
            });
            await syncWith(ledger, t);
            return r;
          }).catch((e: unknown) => {
            if (opts?.on || parentOwner || !(e instanceof Error)) throw e;
            // The preferred node, picked for you: say how to keep the run here instead.
            throw new Error(`${e.message}\n(heph new --on local keeps the run on ${me})`);
          });
          return { ...result, node };
        }
        case "status": {
          const [runId] = args as [string | undefined];
          if (!runId) return { runs: ledger.runs() };
          const fresh = await refresh(runId);
          const { rt } = await runtimeFor(cwd ?? workspaceOfOrHome(runId));
          return {
            ...rt.status(runId),
            ...(fresh ? {} : { stale: `possibly stale: ${ownerOf(runId)} is unreachable` }),
          };
        }
        case "planShow":
        case "explain": {
          const runId = args[0] as string;
          await refresh(runId);
          const { rt } = await runtimeFor(cwd ?? workspaceOfOrHome(runId));
          return method === "planShow"
            ? rt.planShow(runId)
            : rt.explain(runId, args[1] as string | undefined);
        }
        case "sync":
          return { peers: await syncAll() };
        case "handoff": {
          const [runId, to] = args as [string, string];
          const owner = ownerOf(runId);
          const handedByMe = ledger
            .read({ run_id: runId, types: ["run.handed_off"] })
            .at(-1)?.event;
          if (owner !== me && !(handedByMe?.node_id === me && owner === to))
            return forward(owner, "handoff", args);
          const dir = workspaceOf(runId);
          const { workspace } = await runtimeFor(dir);
          handingOff.add(runId);
          return withPeer(to, async (t) => {
            const out = await handOff({
              ledger,
              runId,
              to,
              transport: t,
              workspace,
              workspaceRoot: dir,
              description: await describeWorkspace(dir, workspace),
              stopBuild: () => stopJob(runId, "handoff"),
            });
            return { run_id: runId, to, pushed: out.pushed, dir: out.taken.dir };
          }).finally(() => handingOff.delete(runId));
        }
        case "adopt": {
          const [runId, opts] = args as [string, { force?: boolean }];
          const { from } = await adopt({
            ledger,
            runId,
            ownerReachable: () => reachable(ownerOf(runId)),
            ...(opts?.force ? { force: true } : {}),
          });
          const dir = workspaceOf(runId);
          const { workspace } = await runtimeFor(dir);
          const fetched = await fetchRunBranches(dir, workspace, runId);
          await resumeTaken(runId);
          return { run_id: runId, from, fetched };
        }
        case "run": {
          // heph run: in the foreground here, or as a job on whichever node's daemon owns it.
          const [runId, opts] = args as [string, { now?: boolean }];
          const owner = ownerOf(runId);
          if (owner !== me) return forward(owner, "run", args, cwd);
          if (o.daemon) return startJob(runId, opts);
          const d = await o.localDaemon?.();
          if (d) return d.call("run", [runId, opts]);
          const { rt } = await runtimeFor(workspaceOf(runId));
          return rt.build(runId, opts);
        }
        case "resume":
          return startJob(args[0] as string);
        case "follow": {
          // One step of following a build job: events after `after`, and whether it is over.
          // The job lives in the owner's daemon, so that is who answers. A run handed off while
          // followed is followed at its new owner (once it has taken the run) to the end.
          const [runId, after] = args as [string, string | undefined];
          const moving = handingOff.has(runId);
          const owner = ownerOf(runId);
          if (owner !== me && !moving) return forward(owner, "follow", args);
          if (!o.daemon) {
            const d = await o.localDaemon?.();
            if (d) return d.call("follow", args);
          }
          const events = ledger
            .read({ run_id: runId, ...(after ? { after } : {}) })
            .flatMap((s) => (s.known ? [s.event] : []));
          const job = jobs.get(runId);
          return {
            events,
            status: ledger.run(runId)?.status ?? "unknown",
            done: moving ? false : job ? job.done : true,
            ...(job?.result ? { result: job.result } : {}),
            ...(job?.error ? { error: job.error } : {}),
          };
        }
        default: {
          if (!OWNER_ONLY.has(method)) throw new Error(`unknown command ${method}`);
          const runId = args[0] as string;
          const owner = ownerOf(runId);
          if (owner !== me) return forward(owner, method, args, cwd);
          if (method === "cancel") await stopJob(runId, "user");
          const { rt } = await runtimeFor(workspaceOf(runId));
          const fn = (rt as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
          if (!fn) throw new Error(`unknown command ${method}`);
          return fn(...args);
        }
      }
    },
  };

  /** Reading a run needs a config; any checkout of its workspace will do, else the home. */
  function workspaceOfOrHome(runId: string) {
    try {
      return workspaceOf(runId);
    } catch {
      return o.home;
    }
  }

  async function syncAll() {
    const out: { node: string; ok: boolean; pulled?: number; pushed?: number; error?: string }[] =
      [];
    for (const node of Object.keys(o.config.nodes)) {
      if (node === me) continue;
      try {
        const r = await withPeer(node, (t) => syncWith(ledger, t));
        out.push({ node, ok: true, pulled: r.pulled, pushed: r.pushed });
      } catch (e) {
        out.push({ node, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  /**
   * Daemon start: runs this node owns that a killed process left running are resumed, and
   * rate-limited ones go again (each waits for its retry_after first).
   */
  async function resumeOnStart(): Promise<string[]> {
    const resumed: string[] = [];
    for (const r of ledger.runs()) {
      if (r.owner_node !== me) continue;
      if (r.status !== "running" && !rateLimited(r.run_id)) continue;
      try {
        await startJob(r.run_id);
        resumed.push(r.run_id);
      } catch (e) {
        o.notify?.(`run ${r.run_id} not resumed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return resumed;
  }

  return {
    ledger,
    node: me,
    api,
    peerMethods,
    syncAll,
    resumeOnStart,
    jobs,
    async close() {
      for (const j of jobs.values()) if (!j.done) await j.promise;
      ledger.close();
    },
  };
}
