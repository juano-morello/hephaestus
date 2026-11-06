#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LedgerEvent } from "@hephaestus/ledger";
import {
  type Hello,
  PROTOCOL_VERSION,
  servePeer,
  sshTransport,
  stdinLines,
  type Transport,
} from "@hephaestus/node";
import { run as procRun } from "@hephaestus/sandbox";
import {
  explainConfig,
  findWorkspace,
  type LoadedConfig,
  loadConfig,
  loadHomeConfig,
} from "./config.ts";
import { type DoctorReport, doctor, doctorText } from "./doctor.ts";

export { findWorkspace };

import { daemonAt, startDaemon } from "./daemon.ts";
import { openHost } from "./host.ts";
import { type InitResult, initWorkspace } from "./init.ts";
import { serveStdio } from "./mcp/serve.ts";
import { explainText } from "./output.ts";
import { type Deps, describe, describeForLog, type Runtime } from "./runtime.ts";
import { readUiFile, type UiAssets } from "./ui-server.ts";
import { hephVersion as heph_version } from "./version.ts";
import { watchRun } from "./watch.ts";

/** Output schema version of every `--json` envelope (SPEC section 16). */
export const JSON_SCHEMA = 1;

export type Io = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** Lines of stdin, for `heph peer`. Default: the process's stdin. */
  stdin?: AsyncIterable<string>;
  /** Test injection: planner, worker, pull requests. */
  deps?: Deps;
  /** Test injection: how this node reaches another. */
  connect?: (node: string) => Transport;
  /** Test injection for `heph ui`: whether stdout is a terminal (default: the process's). */
  tty?: boolean;
  /** Test injection for `heph ui`: the OS (default: the process's). */
  platform?: string;
  /** Test injection for `heph ui`: starts the browser opener (default: a detached spawn). */
  open?: (argv: string[]) => void;
};

/** The command that opens a URL in the user's browser on this OS. */
export const opener = (platform: string, url: string) => [
  platform === "darwin" ? "open" : "xdg-open",
  url,
];

type Flags = {
  json: boolean;
  workspace?: string;
  set: string[];
  force: boolean;
  brief?: string;
  runId?: string;
  budget?: number;
  scope?: string[];
  now: boolean;
  home?: string;
  on?: string;
  stackOn?: string;
  tests: boolean;
  noOpen: boolean;
};
type Ctx = Io & { flags: Flags; args: string[] };

type Command<T> = {
  run: (ctx: Ctx) => Promise<T>;
  /** Human output; `--json` prints `data` in the envelope instead. */
  render: (data: T) => string;
  /** For heph help: the command with its arguments, and what it does. Unlisted without. */
  usage?: [string, string];
  /** The exit code for a command that ran: 0 unless given. */
  exitCode?: (data: T) => number;
};

const command = <T>(c: Command<T>): Command<unknown> => c as Command<unknown>;

const homeOf = (ctx: Ctx) => ctx.flags.home || ctx.env.HEPH_HOME || join(homedir(), ".heph");
const workspaceOf = (ctx: Ctx) =>
  ctx.flags.workspace ? resolve(ctx.cwd, ctx.flags.workspace) : findWorkspace(ctx.cwd);

type Api = { call(method: string, args: unknown[]): Promise<unknown> };
type Out<F extends (...a: never[]) => unknown> = Promise<Awaited<ReturnType<F>>>;

/** The CLI's view of this node: every command goes through the host, in-process or daemon. */
function remote(api: Api, follow: (line: string) => void) {
  const c = <T>(method: string, ...args: unknown[]) => api.call(method, args) as Promise<T>;
  return {
    newRun: (brief: unknown, o: { runId?: string; on?: string; stackOn?: string }) =>
      c<Awaited<ReturnType<Runtime["newRun"]>> & { node?: string; placed?: string }>(
        "newRun",
        brief,
        o,
      ),
    planShow: (id: string) => c<ReturnType<Runtime["planShow"]>>("planShow", id),
    revise: (id: string, text: string) =>
      c<Awaited<ReturnType<Runtime["revise"]>>>("revise", id, text),
    approvePlan: (id: string) => c<ReturnType<Runtime["approvePlan"]>>("approvePlan", id),
    status: (id?: string) =>
      c<ReturnType<Runtime["status"]> & { stale?: string }>("status", ...(id ? [id] : [])),
    explain: (id: string, unit?: string) =>
      c<ReturnType<Runtime["explain"]>>("explain", id, ...(unit ? [unit] : [])),
    hint: (id: string, unit: string, text: string, o: { budget?: number; scope?: string[] }) =>
      c<ReturnType<Runtime["hint"]>>("hint", id, unit, text, o),
    cancel: (id: string) => c<Awaited<ReturnType<Runtime["cancel"]>>>("cancel", id),
    approveMerge: (id: string) =>
      c<Awaited<ReturnType<Runtime["approveMerge"]>>>("approveMerge", id),
    mergeStatus: (id: string) => c<Awaited<ReturnType<Runtime["mergeStatus"]>>>("mergeStatus", id),
    sync: () =>
      c<{
        peers: { node: string; ok: boolean; pulled?: number; pushed?: number; error?: string }[];
      }>("sync"),
    handoff: (id: string, node: string) =>
      c<{ run_id: string; to: string; pushed: string[]; dir: string }>("handoff", id, node),
    adopt: (id: string, force: boolean) =>
      c<{ run_id: string; from: string; fetched: string[] }>("adopt", id, { force }),
    /**
     * heph run. In-process the build runs right here; with a daemon (or on another node) it runs
     * as a job there, and this follows its events until it is done.
     */
    async build(id: string, o: { now?: boolean }): Out<Runtime["build"]> {
      const first = (await api.call("run", [id, o])) as Record<string, unknown>;
      if (!("started" in first)) return first as Awaited<ReturnType<Runtime["build"]>>;
      let after = typeof first.after === "string" ? first.after : undefined;
      for (;;) {
        const f = (await api.call("follow", [id, after])) as {
          events: { id: string; type: string; data: unknown; unit_id?: string; attempt?: number }[];
          status: string;
          done: boolean;
          result?: unknown;
          error?: string;
        };
        for (const e of f.events) {
          follow(line(e));
          if (e.type === "run.handed_off") follow("  following it there\n");
          after = e.id;
        }
        if (f.done) {
          if (f.error) throw new Error(f.error);
          return (f.result ?? { run_id: id, status: f.status, heads: {} }) as Awaited<
            ReturnType<Runtime["build"]>
          >;
        }
        await Bun.sleep(1000);
      }
    },
  };
}

/**
 * heph run on a planned run whose plan isn't approved yet waits for the approval, so an agent
 * can start it right after showing the plan and the build begins when the user approves.
 */
async function untilApproved(ctx: Ctx, rt: ReturnType<typeof remote>, id: string) {
  for (let told = false; ; told = true) {
    const s = await rt.status(id);
    if (s.runs || s.plan_approved || s.run.status !== "planned") return;
    if (!told && !ctx.flags.json)
      ctx.stderr(`waiting for your approval: heph approve plan ${id} (Ctrl-C to stop waiting)\n`);
    // Status of a run on another node syncs with it first, so this asks every 2 s, not faster.
    await Bun.sleep(2000);
  }
}

const line = (e: { type: string; data: unknown; unit_id?: string; attempt?: number }) =>
  `  ${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${describe(e)}\n`;

/**
 * Runs one command against this node: through its daemon when one is running, else on a host
 * opened in this process (local fallback) and closed afterwards.
 */
async function withRuntime<T>(
  ctx: Ctx,
  fn: (rt: ReturnType<typeof remote>) => Promise<T> | T,
  progress = false,
): Promise<T> {
  const home = homeOf(ctx);
  const cwd = workspaceOf(ctx);
  const show = progress && !ctx.flags.json ? (l: string) => ctx.stderr(l) : () => {};
  const daemon = ctx.deps ? undefined : await daemonAt(home);
  if (daemon) return fn(remote({ call: (m, a) => daemon.call(m, a, cwd) }, show));
  const host = openHost({
    home,
    config: await loadHomeConfig(home),
    overrides: parseSets(ctx.flags.set),
    ...(ctx.deps ? { deps: ctx.deps } : {}),
    ...(ctx.connect ? { connect: ctx.connect } : {}),
    ...(ctx.flags.json ? {} : { notify: (l: string) => ctx.stderr(`  ${l}\n`) }),
    ...(progress && !ctx.flags.json
      ? {
          onAppend: (events: LedgerEvent[]) => {
            for (const e of events) show(line(e));
          },
        }
      : {}),
    localDaemon: () => daemonAt(home),
  });
  try {
    return await fn(remote({ call: (m, a) => host.api.call(m, a, cwd) }, show));
  } finally {
    await host.close();
  }
}

const need = (args: string[], i: number, what: string) => {
  const v = args[i];
  if (!v) throw new Error(`missing ${what}`);
  return v;
};

type MergeView = {
  run_id: string;
  result:
    | { status: "merged" | "closed" }
    | { status: "not_ready"; reasons: string[] }
    | { status: "open"; open: string[] }
    | { status: "half_landed"; merged?: string[]; reason: string }
    | { status: "aborted"; reason: string }
    | { status: "restacked"; onto: Record<string, string> };
  restacked?: Record<string, { status: string; reason?: string }>;
};

type StatusOne = {
  runs?: undefined;
  run: { run_id: string; status: string };
  plan_approved: boolean;
  stack_on?: { run_id: string; status: string };
  units: { unit_id: string; status: string; attempts: number }[];
  attempts: { unit_id: string; attempt: number; status: string }[];
  usage: { model: string; input?: unknown; output?: unknown; cache_read?: unknown }[];
  prs?: Record<string, string>;
};
type StatusView =
  | StatusOne
  | {
      runs: { run_id: string; status: string; updated_at: string }[];
      /** Peer health, as the daemon last saw it. */
      nodes?: Record<string, { ok: boolean; since?: string; error?: string }>;
    };

/** `heph status` text. */
export const statusText = (s: StatusView) => {
  if (s.runs) {
    const down = Object.entries(s.nodes ?? {})
      .filter(([, n]) => !n.ok)
      .map(([id, n]) => `node ${id} unreachable since ${n.since}: ${n.error} (heph doctor)`);
    return `${[s.runs.map((r) => `${r.run_id}  ${r.status}  ${r.updated_at}`).join("\n") || "no runs", ...down].join("\n")}\n`;
  }
  return [
    `run ${s.run.run_id}: ${s.run.status}${s.plan_approved ? "" : " (plan not approved)"}`,
    ...(s.stack_on ? [`  stacked on ${s.stack_on.run_id} (${s.stack_on.status})`] : []),
    ...s.units.map(
      (u) => `  ${u.unit_id} ${u.status} (${u.attempts} attempt${u.attempts === 1 ? "" : "s"})`,
    ),
    ...inFlightLines(s.attempts),
    ...s.usage.map((u) => `  ${u.model}: in ${u.input} out ${u.output} cache ${u.cache_read}`),
    ...Object.entries(s.prs ?? {}).map(([repo, url]) => `  ${repo}: ${url}`),
    "",
  ].join("\n");
};

/** With parallel fan-out, which attempts run right now (listed only when more than one does). */
export const inFlightLines = (attempts: { unit_id: string; attempt: number; status: string }[]) => {
  const running = attempts.filter((a) => a.status === "running");
  return running.length > 1
    ? [`  in flight: ${running.map((a) => `${a.unit_id}/a${a.attempt}`).join(", ")}`]
    : [];
};

/** A landed run's restacked children, in words. */
const restackText = (restacked: MergeView["restacked"] = {}) =>
  Object.entries(restacked)
    .map(([id, c]) =>
      c.status === "staged"
        ? `  ${id}: restacked onto the target; review, then heph approve merge ${id}\n`
        : `  ${id}: not restacked (${c.status}): ${c.reason ?? "unknown"}\n`,
    )
    .join("");

/** `heph approve merge` and `heph merge status`, in words. */
export function mergeText({ run_id, result: r, restacked }: MergeView): string {
  switch (r.status) {
    case "merged":
      return `${run_id}: merged\n${restackText(restacked)}`;
    case "closed":
      return `${run_id}: a pull request was closed without merging; the run is aborted\n`;
    case "not_ready":
      return `${run_id}: not merged yet\n${r.reasons.map((x) => `  ${x}\n`).join("")}next: heph approve merge ${run_id} again once that is fixed\n`;
    case "open":
      return `${run_id}: pull requests still open: ${r.open.join(", ")}\n`;
    case "half_landed":
      return `${run_id}: HALF LANDED${r.merged?.length ? ` (merged: ${r.merged.join(", ")})` : ""}: ${r.reason}\n`;
    case "aborted":
      return `${run_id}: aborted: ${r.reason}\n`;
    case "restacked":
      return `restacked ${run_id} onto ${[...new Set(Object.values(r.onto))].join(", ")}: review it, then run heph approve merge ${run_id} again\n`;
  }
}

const tasksText = (
  tasks: {
    id: string;
    kind: string;
    project: string;
    lane: string;
    title: string;
    scope?: string[];
    covers?: string[];
  }[] = [],
) =>
  tasks
    .map(
      (t) =>
        `  ${t.id} ${t.kind} ${t.project} (${t.lane}): ${t.title}${t.scope ? `\n      changes ${t.scope.join(", ")}${t.covers?.length ? `; covers ${t.covers.join(", ")}` : ""}` : ""}`,
    )
    .join("\n");

const planText = (r: Awaited<ReturnType<Runtime["newRun"]>> & { node?: string; placed?: string }) =>
  `${[
    `run ${r.run_id}: ${r.status} after ${r.planner_attempts} planner attempt(s)${r.node ? ` on ${r.node}` : ""}`,
    ...(r.placed ? [`  (${r.placed})`] : []),
    ...(r.note ? [`  note: ${r.note}`] : []),
    ...(r.tasks ? [tasksText(r.tasks)] : []),
    ...(r.escalate ?? []).map((x) => `  - ${x}`),
    ...(r.reason ? [`  ${r.reason}`] : []),
    r.status === "planned"
      ? `next: heph plan show ${r.run_id}, then heph approve plan ${r.run_id}`
      : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")}\n`;

const newCommand = command({
  run: (ctx) =>
    withRuntime(ctx, async (rt) => {
      if (!ctx.flags.brief) throw new Error("--brief <file> is required");
      const path = resolve(ctx.cwd, ctx.flags.brief);
      const text = await Bun.file(path).text();
      const data = path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
      return rt.newRun(data, {
        ...(ctx.flags.runId ? { runId: ctx.flags.runId } : {}),
        ...(ctx.flags.on ? { on: ctx.flags.on } : {}),
        ...(ctx.flags.stackOn ? { stackOn: ctx.flags.stackOn } : {}),
      });
    }),
  render: planText,
});

/** Command name (its words joined by a space) -> handler. Add commands here. */
const COMMANDS: Record<string, Command<unknown>> = {
  init: command<InitResult>({
    run: async (ctx) =>
      initWorkspace(ctx.flags.workspace ? resolve(ctx.cwd, ctx.flags.workspace) : ctx.cwd, {
        force: ctx.flags.force,
      }),
    render: (r) =>
      [
        `workspace ${r.workspaceDir}`,
        ...Object.entries(r.projects).map(
          ([n, p]) =>
            `  ${n}: ${p.stack} in ${p.repo}${p.path === "." ? "" : `/${p.path}`} (${Object.keys(p.commands).join(", ") || "no commands"})`,
        ),
        "wrote:",
        ...r.written.map((f) => `  ${f}`),
        "",
      ].join("\n"),
    usage: [
      "init [--force]",
      "Set up .heph/ in this workspace (finds projects and their commands)",
    ],
  }),
  new: {
    ...newCommand,
    usage: [
      "new --brief <file> [--on <node>] [--stack-on <run>]",
      "Plan a run from a brief (--on local keeps it here; --stack-on builds on another run's branch); it waits for your approval",
    ],
  },
  "new feature": newCommand,
  "plan show": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.planShow(need(ctx.args, 0, "run id"))),
    render: (p) =>
      `plan ${p.plan_id} of ${p.run_id} (${p.approved ? "approved" : "not approved"})\n${tasksText(p.tasks)}\norder: ${p.order.join(" -> ")}\n${p.risks.map((r) => `risk: ${r}`).join("\n")}\n`,
    usage: ["plan show <run>", "Show a run's plan"],
  }),
  "plan revise": command({
    run: (ctx) =>
      withRuntime(ctx, (rt) => rt.revise(need(ctx.args, 0, "run id"), ctx.args.slice(1).join(" "))),
    render: planText,
    usage: ["plan revise <run> <feedback>", "Plan again with your feedback"],
  }),
  "approve plan": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.approvePlan(need(ctx.args, 0, "run id"))),
    render: (a) => `approved plan ${a.plan_id} of ${a.run_id}; next: heph run ${a.run_id}\n`,
    usage: ["approve plan <run>", "Approve the plan, so the run can build"],
  }),
  run: command({
    run: (ctx) =>
      withRuntime(
        ctx,
        async (rt) => {
          const id = need(ctx.args, 0, "run id");
          await untilApproved(ctx, rt, id);
          return rt.build(id, { now: ctx.flags.now });
        },
        true,
      ),
    render: (r) =>
      `${[
        `run ${r.run_id}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`,
        ...Object.entries(r.heads).map(
          ([repo, sha]) => `  ${repo} heph/${r.run_id} at ${sha.slice(0, 7)}`,
        ),
        ...Object.entries("prs" in r && r.prs ? r.prs : {}).map(
          ([repo, url]) => `  ${repo}: ${url}`,
        ),
        r.status === "staged" ? `next: review, then heph approve merge ${r.run_id}` : "",
      ]
        .filter(Boolean)
        .join("\n")}\n`,
    usage: [
      "run <run> [--now]",
      "Build the plan, then stage it (pull requests where repos have a remote)",
    ],
  }),
  status: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.status(ctx.args[0])),
    render: (s) => statusText(s),
    usage: ["status [<run>]", "List runs, or show one"],
  }),
  watch: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) =>
        watchRun(
          need(ctx.args, 0, "run id"),
          {
            status: async (id) => {
              const s = await rt.status(id);
              if (!("run" in s)) throw new Error(`no such run ${id}`);
              return s;
            },
            explain: (id) => rt.explain(id),
          },
          // stdout is what an agent's Monitor reads; --json keeps stdout for the envelope.
          (l) => (ctx.flags.json ? ctx.stderr(`${l}\n`) : ctx.stdout(`${l}\n`)),
          ctx.env.HEPH_WATCH_MS ? { intervalMs: Number(ctx.env.HEPH_WATCH_MS) } : {},
        ),
      ),
    render: () => "",
    usage: [
      "watch <run>",
      "One line per milestone of a run until it is staged, failed or needs you (for an agent's Monitor)",
    ],
  }),
  explain: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.explain(need(ctx.args, 0, "run id"), ctx.args[1])),
    render: explainText,
    usage: ["explain <run> [<unit>]", "What happened in a run, one line per event"],
  }),
  hint: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) =>
        rt.hint(
          need(ctx.args, 0, "run id"),
          need(ctx.args, 1, "unit"),
          ctx.args.slice(2).join(" "),
          {
            ...(ctx.flags.budget ? { budget: ctx.flags.budget } : {}),
            ...(ctx.flags.scope?.length ? { scope: ctx.flags.scope } : {}),
          },
        ),
      ),
    render: (h) =>
      `recorded ${h.recorded.join(" and ")} for ${h.unit} in ${h.run_id}${h.scope ? ` (it may also change ${h.scope.join(", ")})` : ""}\n`,
    usage: [
      "hint <run> <unit> [<text>] [--scope <path>]... [--budget <tokens>]",
      "Guide a unit that escalated (--scope lets it change more files), then heph run again",
    ],
  }),
  cancel: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.cancel(need(ctx.args, 0, "run id"))),
    render: (c) => `cancelled ${c.run_id}\n`,
    usage: ["cancel <run>", "Stop a run for good"],
  }),
  "approve merge": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.approveMerge(need(ctx.args, 0, "run id"))),
    render: (m) => mergeText(m as MergeView),
    usage: ["approve merge <run>", "Merge a staged run (only you run this, never an agent)"],
  }),
  "merge status": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.mergeStatus(need(ctx.args, 0, "run id"))),
    render: (m) => mergeText(m as MergeView),
    usage: ["merge status <run>", "Check pull requests merged on GitHub directly"],
  }),
  /**
   * The far side of node-to-node traffic (SPEC section 7), run through `ssh <host> heph peer`:
   * answers protocol requests on stdin until it closes. Prints nothing else on stdout.
   */
  peer: command({
    run: async (ctx) => {
      const home = homeOf(ctx);
      const host = openHost({
        home,
        config: await loadHomeConfig(home),
        ...(ctx.deps ? { deps: ctx.deps } : {}),
        localDaemon: () => daemonAt(home),
      });
      try {
        await servePeer(host.peerMethods(), {
          lines: ctx.stdin ?? stdinLines(Bun.stdin.stream()),
          write: ctx.stdout,
        });
      } finally {
        await host.close();
      }
      return { served: true };
    },
    render: () => "",
  }),
  /** Runs this node's daemon in the foreground until it is stopped (Ctrl-C, SIGTERM). */
  daemon: command({
    run: async (ctx) => {
      const home = homeOf(ctx);
      const config = await loadHomeConfig(home);
      const log = (l: string) => ctx.stderr(daemonLine(l));
      const host = openHost({
        home,
        config,
        daemon: true,
        ...(ctx.deps ? { deps: ctx.deps } : {}),
        notify: log,
        onAppend: (events) => {
          for (const e of events)
            log(
              `${e.run_id} ${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${describeForLog(e, e.run_id)}`,
            );
        },
      });
      // The bundle is built by `bun run build:ui`; without it the daemon runs with no dashboard.
      let uiAssets: UiAssets | undefined;
      try {
        uiAssets = (await import("./ui-assets.ts")).uiAssets;
      } catch {
        log("dashboard bundle not built; no UI");
      }
      const d = await startDaemon(host, {
        home,
        intervalS: config.sync.interval_s,
        log,
        ...(uiAssets ? { uiAssets } : {}),
      });
      log(`node ${host.node} serving ${d.socket}`);
      // A stop leaves running builds as they are; the next start resumes them.
      await new Promise<void>((done) => {
        process.once("SIGINT", done);
        process.once("SIGTERM", done);
      });
      await d.stop();
      process.exit(0);
    },
    render: () => "",
    usage: [
      "daemon",
      "Run this node's daemon in the foreground (the installer runs it as a service)",
    ],
  }),
  /** The MCP server a chat host starts over stdio. Prints nothing else on stdout. */
  mcp: command({
    run: (ctx) =>
      serveStdio({
        home: homeOf(ctx),
        workspace: () => {
          try {
            return workspaceOf(ctx);
          } catch {
            return undefined;
          }
        },
      }),
    render: () => "",
    usage: ["mcp", "Serve heph to a chat host over MCP (stdio); the host starts this"],
  }),
  /** Prints (and opens) the dashboard's URL, once the daemon's listener is verified alive. */
  ui: command({
    run: async (ctx) => {
      const home = homeOf(ctx);
      const ui = readUiFile(home);
      // ui.json outlives the daemon, so a live daemon and the dashboard itself answering are both
      // needed: the page must be 200 and ours, not just any listener (or a 404 with no bundle).
      const live =
        ui !== undefined &&
        (await daemonAt(home)) !== undefined &&
        (await fetch(`http://127.0.0.1:${ui.port}/`, {
          signal: AbortSignal.timeout(1000),
          redirect: "manual",
        }).then(
          async (r) => r.status === 200 && (await r.text()).includes('<div id="root">'),
          () => false,
        ));
      if (!ui || !live)
        throw new Error("the dashboard is not running: no daemon is serving it (run heph doctor)");
      const url = `http://127.0.0.1:${ui.port}/#t=${ui.token}`;
      let opened = false;
      if (!ctx.flags.noOpen && (ctx.tty ?? process.stdout.isTTY)) {
        try {
          const argv = opener(ctx.platform ?? process.platform, url);
          if (ctx.open) ctx.open(argv);
          else Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" }).unref();
          opened = true;
        } catch {}
      }
      return { url, opened };
    },
    render: (r) => `${r.url}\n`,
    usage: ["ui [--no-open]", "Open the read-only dashboard in your browser"],
  }),
  sync: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.sync()),
    render: (r) =>
      `${r.peers.map((p) => (p.ok ? `${p.node}: pulled ${p.pulled}, pushed ${p.pushed}` : `${p.node}: ${p.error}`)).join("\n") || "no nodes configured"}\n`,
    usage: ["sync", "Exchange run events with the other nodes now"],
  }),
  handoff: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) => rt.handoff(need(ctx.args, 0, "run id"), need(ctx.args, 1, "node"))),
    render: (h) => `handed ${h.run_id} to ${h.to}; it continues there (${h.dir})\n`,
    usage: [
      "handoff <run> <node>",
      "Move a run to another node; a build in progress continues there",
    ],
  }),
  adopt: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.adopt(need(ctx.args, 0, "run id"), ctx.flags.force)),
    render: (a) =>
      `ADOPTED ${a.run_id} from ${a.from}: this node now owns it. If ${a.from} comes back, it must not write this run.\n`,
    usage: ["adopt <run> [--force]", "Take over a run whose node is gone"],
  }),
  "config explain": command<LoadedConfig>({
    run: (ctx) =>
      loadConfig({
        workspaceDir: ctx.flags.workspace
          ? resolve(ctx.cwd, ctx.flags.workspace)
          : findWorkspace(ctx.cwd),
        home: ctx.env.HEPH_HOME || join(homedir(), ".heph"),
        overrides: parseSets(ctx.flags.set),
      }),
    render: (loaded) => `${explainConfig(loaded).join("\n")}\n`,
    usage: ["config explain", "Every config value and where it comes from"],
  }),
  doctor: command<DoctorReport>({
    run: async (ctx) => {
      const home = homeOf(ctx);
      const config = await loadHomeConfig(home);
      return doctor({
        home,
        cwd: ctx.flags.workspace ? resolve(ctx.cwd, ctx.flags.workspace) : ctx.cwd,
        tests: ctx.flags.tests,
        env: {
          probeModel: async (pattern, cwd) =>
            (await import("@hephaestus/workers")).probeModel(pattern, cwd),
          daemonUp: async () => !!(await daemonAt(home)),
          helloNode: async (node) => {
            const peer = config.nodes[node];
            const t = ctx.connect ? ctx.connect(node) : sshTransport(peer ?? { ssh: node });
            try {
              return await t.request<Hello>("hello", {
                from: config.node.id,
                protocol: PROTOCOL_VERSION,
              });
            } finally {
              await t.close();
            }
          },
          ghLoggedIn: async () =>
            (await procRun(["gh", "auth", "status", "-h", "github.com"]).catch(() => undefined))
              ?.code === 0,
        },
      });
    },
    render: doctorText,
    exitCode: (r) => (r.ok ? 0 : 1),
    usage: [
      "doctor [--tests]",
      "Check this node can plan, build and land (--tests: each project's tests in the sandbox)",
    ],
  }),
  help: command({
    run: async () => ({ usage: usageText() }),
    render: (h) => h.usage,
  }),
  version: command({
    run: async () => heph_version(),
    render: (v) => `heph ${v.version} (${v.build})\n`,
    usage: ["version", "The version of this heph"],
  }),
};

/** heph help: every listed command, then the options every command takes. */
function usageText(): string {
  const rows = Object.values(COMMANDS).flatMap((c) => (c.usage ? [c.usage] : []));
  const width = Math.max(...rows.map(([u]) => u.length));
  return [
    "usage: heph <command> [options]",
    "",
    ...rows.map(([u, what]) => `  ${u.padEnd(width)}  ${what}`),
    "",
    "options for every command:",
    "  --json              machine-readable output: { schema, command, ok, data | error }",
    "  --workspace <dir>   the workspace (default: the nearest .heph/ at or above here)",
    "  --home <dir>        this node's home (default: $HEPH_HOME, else ~/.heph)",
    "  --set key=value     override a config value for this command",
    "",
  ].join("\n");
}

/** `--set key=value`; the value is parsed as YAML, so numbers and booleans keep their type. */
function parseSets(sets: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const eq = s.indexOf("=");
    if (eq <= 0) throw new Error(`--set expects key=value, got "${s}"`);
    const raw = s.slice(eq + 1);
    out[s.slice(0, eq)] = raw === "" ? "" : Bun.YAML.parse(raw);
  }
  return out;
}

function match(positionals: string[]): { name: string; args: string[] } | undefined {
  for (let n = positionals.length; n > 0; n--) {
    const name = positionals.slice(0, n).join(" ");
    if (COMMANDS[name]) return { name, args: positionals.slice(n) };
  }
  return undefined;
}

/** A daemon log line, timestamped: under launchd the log is a plain file. */
export const daemonLine = (text: string, now = new Date()) =>
  `${text
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => `${now.toISOString()} heph daemon: ${l}`)
    .join("\n")}\n`;

/** Errors whose cause isn't heph's: say what to do about them. */
export function explainError(message: string): string {
  if (/readonly database|unable to open database/i.test(message))
    return `${message}: heph can't write its home (~/.heph). If it runs inside a sandbox (Claude Code's Bash sandbox, say), run it outside: the installer adds heph to sandbox.excludedCommands in ~/.claude/settings.json`;
  return message;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let json = argv.includes("--json");
  let name = argv.filter((a) => !a.startsWith("-")).join(" ");
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        workspace: { type: "string" },
        set: { type: "string", multiple: true, default: [] },
        force: { type: "boolean", default: false },
        brief: { type: "string" },
        "run-id": { type: "string" },
        budget: { type: "string" },
        scope: { type: "string", multiple: true, default: [] },
        now: { type: "boolean", default: false },
        home: { type: "string" },
        on: { type: "string" },
        "stack-on": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
        tests: { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
        version: { type: "boolean", default: false },
      },
    });
    json = values.json ?? false;
    const asked = values.help
      ? ["help"]
      : values.version
        ? ["version"]
        : positionals.length
          ? positionals
          : ["help"];
    const found = match(asked);
    if (!found) {
      name = positionals.join(" ");
      throw new Error(`unknown command "${name}" (heph help lists them)`);
    }
    name = found.name;
    const cmd = COMMANDS[name] as Command<unknown>;
    const flags: Flags = {
      json,
      set: values.set ?? [],
      force: values.force ?? false,
      now: values.now ?? false,
      tests: values.tests ?? false,
      noOpen: values["no-open"] ?? false,
      ...(values.home ? { home: values.home } : {}),
      ...(values.on ? { on: values.on } : {}),
      ...(values["stack-on"] ? { stackOn: values["stack-on"] } : {}),
      ...(values.brief ? { brief: values.brief } : {}),
      ...(values["run-id"] ? { runId: values["run-id"] } : {}),
      ...(values.budget ? { budget: Number.parseInt(values.budget, 10) } : {}),
      ...(values.scope?.length ? { scope: values.scope } : {}),
      ...(values.workspace ? { workspace: values.workspace } : {}),
    };
    // Tests that start heph processes inject a scripted planner and worker this way.
    const deps =
      io.deps ??
      (io.env.HEPH_DEPS_MODULE
        ? ((await import(io.env.HEPH_DEPS_MODULE)) as { deps: Deps }).deps
        : undefined);
    const data = await cmd.run({ ...io, ...(deps ? { deps } : {}), flags, args: found.args });
    if (json) {
      io.stdout(`${JSON.stringify({ schema: JSON_SCHEMA, command: name, ok: true, data })}\n`);
    } else {
      io.stdout(cmd.render(data));
    }
    return cmd.exitCode?.(data) ?? 0;
  } catch (e) {
    const message = explainError(e instanceof Error ? e.message : String(e));
    if (json) {
      io.stdout(
        `${JSON.stringify({ schema: JSON_SCHEMA, command: name, ok: false, error: { message } })}\n`,
      );
    } else {
      io.stderr(`heph: ${message}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
