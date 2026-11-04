#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { LedgerEvent } from "@hephaestus/ledger";
import { servePeer, stdinLines, type Transport } from "@hephaestus/node";
import { explainConfig, type LoadedConfig, loadConfig, loadHomeConfig } from "./config.ts";
import { daemonAt, startDaemon } from "./daemon.ts";
import { openHost } from "./host.ts";
import { type InitResult, initWorkspace } from "./init.ts";
import { type Deps, describe, type Runtime } from "./runtime.ts";

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
};

type Flags = {
  json: boolean;
  workspace?: string;
  set: string[];
  force: boolean;
  brief?: string;
  runId?: string;
  budget?: number;
  now: boolean;
  home?: string;
  on?: string;
};
type Ctx = Io & { flags: Flags; args: string[] };

type Command<T> = {
  run: (ctx: Ctx) => Promise<T>;
  /** Human output; `--json` prints `data` in the envelope instead. */
  render: (data: T) => string;
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
    newRun: (brief: unknown, o: { runId?: string; on?: string }) =>
      c<Awaited<ReturnType<Runtime["newRun"]>> & { node?: string }>("newRun", brief, o),
    planShow: (id: string) => c<ReturnType<Runtime["planShow"]>>("planShow", id),
    revise: (id: string, text: string) =>
      c<Awaited<ReturnType<Runtime["revise"]>>>("revise", id, text),
    approvePlan: (id: string) => c<ReturnType<Runtime["approvePlan"]>>("approvePlan", id),
    status: (id?: string) =>
      c<ReturnType<Runtime["status"]> & { stale?: string }>("status", ...(id ? [id] : [])),
    explain: (id: string, unit?: string) =>
      c<ReturnType<Runtime["explain"]>>("explain", id, ...(unit ? [unit] : [])),
    hint: (id: string, unit: string, text: string, budget?: number) =>
      c<ReturnType<Runtime["hint"]>>("hint", id, unit, text, ...(budget ? [budget] : [])),
    cancel: (id: string) => c<ReturnType<Runtime["cancel"]>>("cancel", id),
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
      let after: string | undefined;
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

const tasksText = (
  tasks: { id: string; kind: string; project: string; lane: string; title: string }[] = [],
) => tasks.map((t) => `  ${t.id} ${t.kind} ${t.project} (${t.lane}): ${t.title}`).join("\n");

const planText = (r: Awaited<ReturnType<Runtime["newRun"]>>) =>
  `${[
    `run ${r.run_id}: ${r.status} after ${r.planner_attempts} planner attempt(s)`,
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
  }),
  new: newCommand,
  "new feature": newCommand,
  "plan show": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.planShow(need(ctx.args, 0, "run id"))),
    render: (p) =>
      `plan ${p.plan_id} of ${p.run_id} (${p.approved ? "approved" : "not approved"})\n${tasksText(p.tasks)}\norder: ${p.order.join(" -> ")}\n${p.risks.map((r) => `risk: ${r}`).join("\n")}\n`,
  }),
  "plan revise": command({
    run: (ctx) =>
      withRuntime(ctx, (rt) => rt.revise(need(ctx.args, 0, "run id"), ctx.args.slice(1).join(" "))),
    render: planText,
  }),
  "approve plan": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.approvePlan(need(ctx.args, 0, "run id"))),
    render: (a) => `approved plan ${a.plan_id} of ${a.run_id}; next: heph run ${a.run_id}\n`,
  }),
  run: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) => rt.build(need(ctx.args, 0, "run id"), { now: ctx.flags.now }), true),
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
  }),
  status: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.status(ctx.args[0])),
    render: (s) => {
      if (s.runs)
        return `${s.runs.map((r) => `${r.run_id}  ${r.status}  ${r.updated_at}`).join("\n") || "no runs"}\n`;
      return [
        `run ${s.run.run_id}: ${s.run.status}${s.plan_approved ? "" : " (plan not approved)"}`,
        ...s.units.map(
          (u) => `  ${u.unit_id} ${u.status} (${u.attempts} attempt${u.attempts === 1 ? "" : "s"})`,
        ),
        ...s.usage.map((u) => `  ${u.model}: in ${u.input} out ${u.output} cache ${u.cache_read}`),
        ...Object.entries(s.prs ?? {}).map(([repo, url]) => `  ${repo}: ${url}`),
        "",
      ].join("\n");
    },
  }),
  explain: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.explain(need(ctx.args, 0, "run id"), ctx.args[1])),
    render: (x) =>
      `${x.events.map((e) => `${e.ts.slice(11, 19)} ${e.unit_id ? `${e.unit_id}${e.attempt ? `/a${e.attempt}` : ""} ` : ""}${e.summary}`).join("\n")}\n`,
  }),
  hint: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) =>
        rt.hint(
          need(ctx.args, 0, "run id"),
          need(ctx.args, 1, "unit"),
          ctx.args.slice(2).join(" "),
          ctx.flags.budget,
        ),
      ),
    render: (h) => `recorded ${h.recorded.join(" and ")} for ${h.unit} in ${h.run_id}\n`,
  }),
  cancel: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.cancel(need(ctx.args, 0, "run id"))),
    render: (c) => `cancelled ${c.run_id}\n`,
  }),
  "approve merge": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.approveMerge(need(ctx.args, 0, "run id"))),
    render: (m) => `merge of ${m.run_id}: ${JSON.stringify(m.result)}\n`,
  }),
  "merge status": command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.mergeStatus(need(ctx.args, 0, "run id"))),
    render: (m) => `merge of ${m.run_id}: ${JSON.stringify(m.result)}\n`,
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
      const log = (l: string) => ctx.stderr(`heph daemon: ${l}\n`);
      const host = openHost({
        home,
        config,
        daemon: true,
        ...(ctx.deps ? { deps: ctx.deps } : {}),
        notify: log,
        onAppend: (events) => {
          for (const e of events) log(`${e.run_id} ${line(e).trim()}`);
        },
      });
      const d = await startDaemon(host, { home, intervalS: config.sync.interval_s, log });
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
  }),
  sync: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.sync()),
    render: (r) =>
      `${r.peers.map((p) => (p.ok ? `${p.node}: pulled ${p.pulled}, pushed ${p.pushed}` : `${p.node}: ${p.error}`)).join("\n") || "no nodes configured"}\n`,
  }),
  handoff: command({
    run: (ctx) =>
      withRuntime(ctx, (rt) => rt.handoff(need(ctx.args, 0, "run id"), need(ctx.args, 1, "node"))),
    render: (h) => `handed ${h.run_id} to ${h.to}; it continues there (${h.dir})\n`,
  }),
  adopt: command({
    run: (ctx) => withRuntime(ctx, (rt) => rt.adopt(need(ctx.args, 0, "run id"), ctx.flags.force)),
    render: (a) =>
      `ADOPTED ${a.run_id} from ${a.from}: this node now owns it. If ${a.from} comes back, it must not write this run.\n`,
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
  }),
};

/** The nearest directory at or above `cwd` with `.heph/workspace.yaml`, else `cwd` itself. */
export function findWorkspace(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".heph", "workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
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
        now: { type: "boolean", default: false },
        home: { type: "string" },
        on: { type: "string" },
      },
    });
    json = values.json ?? false;
    const found = match(positionals);
    if (!found) {
      name = positionals.join(" ");
      throw new Error(`unknown command "${name}"; known: ${Object.keys(COMMANDS).join(", ")}`);
    }
    name = found.name;
    const cmd = COMMANDS[name] as Command<unknown>;
    const flags: Flags = {
      json,
      set: values.set ?? [],
      force: values.force ?? false,
      now: values.now ?? false,
      ...(values.home ? { home: values.home } : {}),
      ...(values.on ? { on: values.on } : {}),
      ...(values.brief ? { brief: values.brief } : {}),
      ...(values["run-id"] ? { runId: values["run-id"] } : {}),
      ...(values.budget ? { budget: Number.parseInt(values.budget, 10) } : {}),
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
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
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
