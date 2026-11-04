// The node (SPEC sections 7 and 16): one ledger, a runtime per workspace, and the routing that
// sends a command for a run to the node that owns it. The daemon serves a host; without a
// daemon the CLI opens one in-process.
import { existsSync } from "node:fs";
import { join } from "node:path";
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
  sshTransport,
  syncMethods,
  syncWith,
  type Transport,
  takeMethods,
  type WorkspaceDescription,
} from "@hephaestus/node";
import { type HomeConfig, loadConfig } from "./config.ts";
import { type Deps, openRuntime, type Runtime } from "./runtime.ts";

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
  const runtimes = new Map<
    string,
    Promise<{
      rt: Runtime;
      workspace: Awaited<ReturnType<typeof loadConfig>>["config"]["workspace"];
    }>
  >();
  const jobs = new Map<string, Job>();

  const runtimeFor = (workspaceDir: string) => {
    let r = runtimes.get(workspaceDir);
    if (!r) {
      r = (async () => {
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
      })();
      runtimes.set(workspaceDir, r);
    }
    return r;
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
  /** A command for a run another node owns, carried out there; then this node catches up. */
  const forward = async (owner: string, method: string, args: unknown[]) =>
    withPeer(owner, async (t) => {
      const result = await t.request("rpc", { method, args });
      await syncWith(ledger, t);
      return result;
    });

  const startJob = async (runId: string, opts: { now?: boolean } = {}) => {
    const running = jobs.get(runId);
    if (running && !running.done) return { run_id: runId, started: false, running: true };
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
      });
    jobs.set(runId, job);
    return { run_id: runId, started: true };
  };
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

  /** Everything this node answers for its peers (`heph peer`). */
  const peerMethods = (): Methods => ({
    ...syncMethods(ledger),
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
    "run.new": async (p: { workspace: WorkspaceDescription; brief: unknown; runId?: string }) => {
      const { dir } = await ensureWorkspace(p.workspace, {
        home: o.home,
        workspaces: o.config.workspaces,
      });
      const { rt } = await runtimeFor(dir);
      return rt.newRun(p.brief, p.runId ? { runId: p.runId } : {});
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
          const [brief, opts] = args as [unknown, { runId?: string; on?: string }];
          if (!cwd) throw new Error("newRun needs a workspace");
          const node = await placeNew(opts?.on);
          if (node === me) {
            const { rt } = await runtimeFor(cwd);
            return { ...(await rt.newRun(brief, opts?.runId ? { runId: opts.runId } : {})), node };
          }
          const { workspace } = await runtimeFor(cwd);
          const description = await describeWorkspace(cwd, workspace);
          const result = await withPeer(node, async (t) => {
            const r = await t.request<Record<string, unknown>>("run.new", {
              workspace: description,
              brief,
              ...(opts?.runId ? { runId: opts.runId } : {}),
            });
            await syncWith(ledger, t);
            return r;
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
          });
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
          if (owner !== me) return forward(owner, "run", args);
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
          // The job lives in the owner's daemon, so that is who answers.
          const [runId, after] = args as [string, string | undefined];
          const owner = ownerOf(runId);
          if (owner !== me) return forward(owner, "follow", args);
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
            done: job ? job.done : true,
            ...(job?.result ? { result: job.result } : {}),
            ...(job?.error ? { error: job.error } : {}),
          };
        }
        default: {
          if (!OWNER_ONLY.has(method)) throw new Error(`unknown command ${method}`);
          const runId = args[0] as string;
          const owner = ownerOf(runId);
          if (owner !== me) return forward(owner, method, args);
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

  /** Daemon start: runs this node owns that a killed process left running are resumed. */
  async function resumeOnStart(): Promise<string[]> {
    const resumed: string[] = [];
    for (const r of ledger.runs()) {
      if (r.owner_node !== me || r.status !== "running") continue;
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
      for (const r of runtimes.values()) (await r).rt.close();
      ledger.close();
    },
  };
}
