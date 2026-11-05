import { createHash } from "node:crypto";
import type { SpawnInput, SpawnOutput, Worker } from "@hephaestus/engine";
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

function toCustomTools(handlers: Handlers): CustomTool[] {
  return TOOL_NAMES.map(
    (name) =>
      ({
        name,
        label: name,
        description: TOOL_DESCRIPTIONS[name],
        parameters: PARAMS[name],
        loadMode: "essential",
        async execute(_id: string, params: unknown) {
          try {
            const text = await (handlers[name] as (p: unknown) => Promise<string>)(params);
            return { content: [{ type: "text", text }] };
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return { content: [{ type: "text", text: `error: ${message}` }], isError: true };
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

export type OmpWorkerOptions = {
  /** Where this attempt's tools run. */
  sandbox: (input: SpawnInput) => SandboxSpec;
  /** Wall-clock limit per attempt; the session is aborted after it. Default 20 minutes. */
  timeoutMs?: number;
  modelPattern?: (model: string) => string;
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
  const run = creating.then(fn, fn);
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
        const { handlers, result } = createToolHandlers(sb, {
          lockedPaths: input.brief.locked_paths,
        });
        const systemPrompt = await loadRolePrompt(input.role);
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
            tools: toCustomTools(handlers),
          }),
        ));
        const s = session;

        let timedOut = false;
        const timer = setTimeout(
          () => {
            timedOut = true;
            void s.abort({ reason: "hephaestus: attempt timeout" });
          },
          opts.timeoutMs ?? 20 * 60_000,
        );
        // A handoff or cancel aborts the attempt; it then counts as interrupted, not failed.
        let interrupted = false;
        const onAbort = () => {
          interrupted = true;
          void s.abort({ reason: "hephaestus: attempt stopped" });
        };
        if (input.signal?.aborted) onAbort();
        else input.signal?.addEventListener("abort", onAbort, { once: true });
        let threw: unknown;
        try {
          await s.prompt(renderUnitPrompt(input.brief));
        } catch (e) {
          threw = e;
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
        }

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
          exit: exitFrom({ last: s.getLastAssistantMessage(), threw, timedOut, interrupted }),
          prompt_hash: promptHash,
        };
      } finally {
        await session?.dispose();
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
