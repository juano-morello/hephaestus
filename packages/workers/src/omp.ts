import { createHash } from "node:crypto";
import type { SpawnInput, SpawnOutput, Worker, WorkerFailure } from "@hephaestus/engine";
import { openSandbox, type SandboxSpec } from "@hephaestus/sandbox";
import {
  type CreateAgentSessionOptions,
  type CustomTool,
  createAgentSession,
  SessionManager,
  Settings,
  z,
} from "@oh-my-pi/pi-coding-agent";
import { loadRolePrompt, renderUnitPrompt } from "./prompt.ts";
import { createToolHandlers, TOOL_DESCRIPTIONS, TOOL_NAMES, type ToolName } from "./tools.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingName = (typeof THINKING)[number];

/** "claude/sonnet" -> "sonnet", handed to OMP's fuzzy model matching. */
export const defaultModelPattern = (model: string) => model.split("/").slice(1).join("/") || model;

export const thinkingFor = (effort: string | undefined): ThinkingName =>
  ((THINKING as readonly string[]).includes(effort ?? "") ? effort : "medium") as ThinkingName;

/** The slice of OMP's AgentSession the worker uses, so tests can stand in for it. */
export type OmpSession = {
  prompt(text: string): Promise<boolean>;
  abort(options?: { reason?: string }): Promise<void>;
  getLastAssistantMessage():
    | { stopReason: string; errorMessage?: string; errorStatus?: number }
    | undefined;
  getSessionStats(): {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  readonly messages: unknown[];
  dispose(): Promise<void>;
};

const PARAMS: Record<ToolName, unknown> = {
  read: z.object({
    path: z.string().describe("File path relative to the project root"),
    offset: z.number().int().positive().optional().describe("First line to return, 1-based"),
    limit: z.number().int().positive().optional().describe("Number of lines, at most 2000"),
  }),
  write: z.object({
    path: z.string().describe("File path relative to the project root"),
    content: z.string().describe("The complete new file content"),
  }),
  edit: z.object({
    path: z.string().describe("File path relative to the project root"),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence"),
  }),
  bash: z.object({
    command: z.string().describe("Shell command, run with sh -c in the project root"),
    timeout_ms: z.number().int().positive().optional(),
  }),
  submit_result: z.object({
    summary: z.string().describe("What you did, in a sentence or two"),
    claims: z
      .array(z.string())
      .describe("Facts you verified, e.g. which test covers which criterion"),
    touched: z.array(z.string()).describe("Every file you changed, relative to the project root"),
    notes_for_reviewer: z.string().optional(),
    blocked_reason: z
      .string()
      .optional()
      .describe("Set only to stop honestly instead of breaking a rule"),
  }),
};

type Handlers = ReturnType<typeof createToolHandlers>["handlers"];

/** What the tools are doing, so the idle watchdog can tell a long test run from a hung model call. */
export type ToolActivity = { inFlight: number; lastTool?: string; lastToolAt: number };

function toCustomTools(handlers: Handlers, activity: ToolActivity): CustomTool[] {
  return TOOL_NAMES.map(
    (name) =>
      ({
        name,
        label: name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: PARAMS[name],
        loadMode: "essential",
        async execute(_id: string, params: unknown) {
          activity.inFlight++;
          activity.lastTool = name;
          try {
            const text = await (handlers[name] as (p: unknown) => Promise<string>)(params);
            return { content: [{ type: "text", text }] };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
          } finally {
            activity.inFlight--;
            activity.lastToolAt = Date.now();
          }
        },
      }) as unknown as CustomTool,
  );
}

/**
 * Every built-in is off: OMP's own file tools run on the host with no path limits. The model
 * gets only our five tools, which act inside the sandbox; OMP, credentials and model calls stay
 * on the host. Nothing is discovered from the worktree (settings, extensions, skills, MCP).
 */
export function sessionOptions(a: {
  cwd: string;
  modelPattern: string;
  thinking: ThinkingName;
  systemPrompt: string;
  tools: CustomTool[];
}): CreateAgentSessionOptions {
  return {
    cwd: a.cwd,
    modelPattern: a.modelPattern,
    // OMP types this as an enum whose values are these same strings.
    thinkingLevel: a.thinking as CreateAgentSessionOptions["thinkingLevel"],
    systemPrompt: [a.systemPrompt],
    restrictToolNames: true,
    allowRestrictedCustomTools: true,
    toolNames: [...TOOL_NAMES],
    customTools: a.tools,
    enableMCP: false,
    enableLsp: false,
    disableExtensionDiscovery: true,
    disableModelFallback: true,
    skills: [],
    contextFiles: [],
    rules: [],
    settings: Settings.isolated({
      "tools.xdev": false,
      "fetch.enabled": false,
      "retry.modelFallback": false,
    }),
    sessionManager: SessionManager.inMemory(),
  };
}

const RATE_LIMIT = /rate.?limit|usage limit|quota|too many requests|\b429\b/i;

export function exitFrom(e: {
  last?: ReturnType<OmpSession["getLastAssistantMessage"]>;
  threw?: unknown;
  timedOut?: boolean;
  interrupted?: boolean;
}): SpawnOutput["exit"] {
  if (e.interrupted) return "interrupted";
  if (e.timedOut) return "error";
  const message = [e.last?.errorMessage, e.threw instanceof Error ? e.threw.message : e.threw]
    .filter(Boolean)
    .join(" ");
  if (e.last?.errorStatus === 429 || RATE_LIMIT.test(message)) return "rate_limited";
  if (e.threw !== undefined || e.last?.stopReason === "error") return "error";
  return "ok";
}

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_ABORT_GRACE_MS = 30_000;

/** 90_000 -> "1m30s"; short spans keep milliseconds. */
export function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `${sec}s`;
  return sec === 0 ? `${m}m` : `${m}m${sec}s`;
}

export type OmpWorkerOptions = {
  /** Where this attempt's tools run. */
  sandbox: (input: SpawnInput) => SandboxSpec;
  /** Wall-clock limit per attempt; the session is aborted after it. Default 20 minutes. */
  timeoutMs?: number;
  /** Abort when the model and the tools have been silent this long. Default 10 minutes. */
  idleTimeoutMs?: number;
  /** After an abort, how long to wait for the session to wind down before giving up on it. */
  abortGraceMs?: number;
  modelPattern?: (model: string) => string;
  /** Project text appended to a role's built-in prompt; may throw to fail the attempt. */
  roleInstructions?: (role: string, project: string) => string | undefined;
  /** Injection point for tests; defaults to OMP's createAgentSession. */
  createSession?: (opts: CreateAgentSessionOptions) => Promise<{ session: OmpSession }>;
};

/**
 * Runs `fn` after every earlier call has settled. OMP sessions cannot be created concurrently in
 * one process ("Agent Main was replaced"); only creation needs this, running sessions overlap.
 * One chain per process, so several workers share it.
 */
let creating: Promise<unknown> = Promise.resolve();
export function serializeCreation<T>(fn: () => Promise<T>): Promise<T> {
  // `creating` never rejects (each link swallows its error), so no rejection handler is needed.
  const run = creating.then(() => fn());
  creating = run.catch(() => undefined);
  return run;
}

/** OMP in-process as the single-unit worker (SPEC section 3), sandboxed per attempt. */
export function createOmpWorker(opts: OmpWorkerOptions): Worker {
  const make =
    opts.createSession ??
    (async (o: CreateAgentSessionOptions) =>
      (await createAgentSession(o)) as unknown as { session: OmpSession });
  const create = (o: CreateAgentSessionOptions) => serializeCreation(() => make(o));
  return {
    async spawn(input) {
      const sb = await openSandbox(opts.sandbox(input));
      let session: OmpSession | undefined;
      try {
        const activity: ToolActivity = { inFlight: 0, lastToolAt: 0 };
        const { handlers, result } = createToolHandlers(sb, {
          lockedPaths: input.brief.locked_paths,
        });
        const systemPrompt = await loadRolePrompt(
          input.role,
          opts.roleInstructions?.(input.role, input.brief.task.project),
        );
        const promptHash = createHash("sha256")
          .update(systemPrompt)
          .update(JSON.stringify(TOOL_DESCRIPTIONS))
          .digest("hex");
        ({ session } = await create(
          sessionOptions({
            cwd: input.workdir,
            modelPattern: (opts.modelPattern ?? defaultModelPattern)(input.model),
            thinking: thinkingFor(input.effort),
            systemPrompt,
            tools: toCustomTools(handlers, activity),
          }),
        ));
        const s = session;
        const limit = input.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const idleLimit = input.idleTimeoutMs ?? opts.idleTimeoutMs ?? DEFAULT_IDLE_MS;
        const grace = opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
        const begun = Date.now();

        // Where the attempt stood, for the failure message: which tool ran last, whether the
        // last model turn ended asking for a tool (then the next model call hung).
        const snapshot = () => {
          const last = s.getLastAssistantMessage();
          const quiet = Date.now() - Math.max(lastProgress, activity.lastToolAt, begun);
          return (
            `${s.messages.length} messages, last tool: ${activity.lastTool ?? "none"}, ` +
            `last stop reason: ${last?.stopReason ?? "none"}, quiet for ${formatSpan(quiet)}`
          );
        };
        let failure: WorkerFailure | undefined;
        let release: () => void = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const timers: ReturnType<typeof setTimeout>[] = [];
        // Aborts the session, and stops waiting for it after `grace` if it ignores the abort.
        const stop = (f: WorkerFailure) => {
          if (failure) return;
          failure = f;
          void Promise.resolve(s.abort({ reason: `hephaestus: ${f.kind}` })).catch(() => {});
          timers.push(setTimeout(release, grace));
        };

        let lastProgress = begun;
        let lastCount = s.messages.length;
        const watchdog = setInterval(
          () => {
            const count = s.messages.length;
            if (count !== lastCount || activity.inFlight > 0) {
              lastCount = count;
              lastProgress = Date.now();
              return;
            }
            const quiet = Date.now() - Math.max(lastProgress, activity.lastToolAt);
            if (quiet >= idleLimit) {
              stop({
                kind: "idle",
                detail: `no model or tool activity for ${formatSpan(quiet)} (${snapshot()})`,
              });
            }
          },
          Math.max(10, Math.min(idleLimit / 4, 5000)),
        );
        timers.push(
          setTimeout(
            () =>
              stop({
                kind: "timeout",
                detail: `attempt limit of ${formatSpan(limit)} reached (${snapshot()})`,
              }),
            limit,
          ),
        );
        // A handoff or cancel aborts the attempt; it then counts as interrupted, not failed.
        let interrupted = false;
        const onAbort = () => {
          interrupted = true;
          void Promise.resolve(s.abort({ reason: "hephaestus: attempt stopped" })).catch(() => {});
        };
        if (input.signal?.aborted) onAbort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
        let threw: unknown;
        try {
          const prompting = s.prompt(renderUnitPrompt(input.brief));
          // A late rejection after we stopped waiting must not become an unhandled one.
          prompting.catch(() => {});
          await Promise.race([prompting, released]);
        } catch (e) {
          threw = e;
        } finally {
          clearInterval(watchdog);
          for (const t of timers) clearTimeout(t);
          input.signal?.removeEventListener("abort", onAbort);
        }

        const last = s.getLastAssistantMessage();
        const exit = exitFrom({ last, threw, timedOut: failure !== undefined, interrupted });
        const why: WorkerFailure | undefined =
          exit !== "error"
            ? undefined
            : (failure ?? {
                kind: "error",
                detail:
                  threw !== undefined
                    ? threw instanceof Error
                      ? threw.message
                      : String(threw)
                    : (last?.errorMessage ?? "the session ended with an error"),
              });
        const tokens = s.getSessionStats().tokens;
        return {
          output: result(),
          transcript: JSON.stringify(s.messages),
          usage: {
            input: tokens.input,
            output: tokens.output,
            cache_read: tokens.cacheRead,
            cache_write: tokens.cacheWrite,
          },
          exit,
          ...(why ? { failure: why } : {}),
          prompt_hash: promptHash,
        };
      } finally {
        // A wedged session must not wedge the build: give disposal the same grace as an abort.
        if (session) {
          await Promise.race([
            Promise.resolve(session.dispose()).catch(() => {}),
            Bun.sleep(opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS),
          ]);
        }
        await sb.dispose();
      }
    },
  };
}

export type ModelProbe = { model: string } | { error: string };

/**
 * One tiny call to a model (`heph doctor`): which model the pattern resolves to, or why it
 * can't be used (no login, unknown model, provider error). Costs a few tokens.
 */
export async function probeModel(modelPattern: string, cwd: string): Promise<ModelProbe> {
  try {
    const { session } = (await createAgentSession(
      sessionOptions({
        cwd,
        modelPattern,
        thinking: "off",
        systemPrompt: "Reply with the single word OK.",
        tools: [],
      }),
    )) as unknown as {
      session: OmpSession & { model?: { provider: string; id: string }; dispose?: () => unknown };
    };
    try {
      await session.prompt("ping");
      const last = session.getLastAssistantMessage() as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      if (last?.stopReason === "error") return { error: firstLine(last.errorMessage ?? "error") };
      return { model: `${session.model?.provider} ${session.model?.id}` };
    } finally {
      await session.dispose?.();
    }
  } catch (e) {
    return { error: firstLine(e instanceof Error ? e.message : String(e)) };
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? s;
