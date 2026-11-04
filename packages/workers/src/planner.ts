import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type Brief,
  briefHash,
  DEFAULT_LIMITS,
  type Evaluation,
  evaluatePlannerOutput,
  type GateContext,
  type GateResult,
  type Plan,
  type PlanLimits,
  type ProjectGates,
  type Workspace,
} from "@hephaestus/core";
import type { Usage } from "@hephaestus/ledger";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import plannerTemplate from "../prompts/planner.md" with { type: "text" };
import { defaultModelPattern, sessionOptions, thinkingFor } from "./omp.ts";

const SYSTEM = "You are the Hephaestus planner. You output one JSON object and nothing else.";
/** On-disk path of the default prompt, for tools that pass `promptPath` (plan-proto --prompt). */
export const PLANNER_PROMPT = join(import.meta.dir, "..", "prompts", "planner.md");

/** The slice of OMP's AgentSession the planner uses, so tests can stand in for it. */
export type PlannerSession = {
  prompt(text: string): Promise<boolean>;
  abort(options?: { reason?: string }): Promise<void>;
  getLastAssistantMessage():
    | { stopReason: string; errorMessage?: string; content?: unknown[] }
    | undefined;
  getSessionStats(): {
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  readonly messages: unknown[];
  dispose(): Promise<void>;
};

export type PlannerInput = {
  brief: Brief;
  workspace: Workspace;
  projectGates: ProjectGates;
  /** Tracked files per project; the plan gates check scopes against them. */
  files?: Record<string, string[]>;
  repoMap: string;
  route: { model: string; effort?: string };
  limits?: PlanLimits;
  /** A revision: the plan being revised and what the user wants changed. */
  previous?: Plan;
  instructions?: string;
  /** Plan gates the previous answer failed, fed back so the planner can fix them. */
  feedback?: GateResult[];
  promptPath?: string;
  timeoutMs?: number;
  modelPattern?: (model: string) => string;
  createSession?: (opts: CreateAgentSessionOptions) => Promise<{ session: PlannerSession }>;
};

export type PlannerResult = {
  evaluation: Evaluation;
  output: string;
  usage: Usage;
  transcript: string;
  prompt_hash: string;
};

/** Tracked files per project as a trimmed listing, until per-stack repo maps exist. */
export function repoMapFromFiles(files: Record<string, string[]>, maxLines = 200): string {
  return Object.entries(files)
    .map(([project, list]) => {
      if (!list.length) return `## ${project}\n(no tracked files)`;
      const shown = list.slice(0, maxLines);
      const more = list.length - shown.length;
      return [`## ${project}`, ...shown, ...(more > 0 ? [`(${more} more files)`] : [])].join("\n");
    })
    .join("\n\n");
}

const yaml = (v: unknown) => Bun.YAML.stringify(v, null, 2).trim();

export function renderPlannerPrompt(template: string, input: PlannerInput): string {
  const revision = input.previous
    ? [
        "### Revision",
        "",
        "You planned this Brief before:",
        "",
        "```json",
        JSON.stringify(input.previous, null, 2),
        "```",
        "",
        `The user asks for these changes: ${input.instructions ?? "(none given)"}`,
        "",
        "Return a complete new Plan (or an Escalation), not a diff.",
      ].join("\n")
    : "";
  const feedback = input.feedback?.length
    ? [
        "### Your previous answer failed these checks",
        "",
        ...input.feedback.map((g) =>
          [`- ${g.gate}: ${g.reason}`, ...g.evidence.map((e) => `  - ${e}`)].join("\n"),
        ),
        "",
        "Fix every one of them and answer again with the whole Plan.",
      ].join("\n")
    : "";
  return template
    .replace("{{brief}}", JSON.stringify(input.brief, null, 2))
    .replace("{{workspace}}", yaml(input.workspace))
    .replace("{{project_gates}}", yaml(input.projectGates))
    .replace("{{repo_maps}}", input.repoMap)
    .replace("{{revision}}", revision)
    .replace("{{feedback}}", feedback);
}

/**
 * One planner call (SPEC section 8): OMP with no tools at all, the Brief and repo context in
 * the prompt, the answer checked by the plan gates. Code decides what happens next.
 */
export async function runPlanner(input: PlannerInput): Promise<PlannerResult> {
  // Embedded by default, so the compiled binary needs no files next to it.
  const template = input.promptPath ? await Bun.file(input.promptPath).text() : plannerTemplate;
  const prompt = renderPlannerPrompt(template, input);
  const create =
    input.createSession ??
    (async (o: CreateAgentSessionOptions) =>
      (await createAgentSession(o)) as unknown as { session: PlannerSession });
  const { session } = await create({
    ...sessionOptions({
      cwd: process.cwd(),
      modelPattern: (input.modelPattern ?? defaultModelPattern)(input.route.model),
      thinking: thinkingFor(input.route.effort),
      systemPrompt: SYSTEM,
      tools: [],
    }),
    toolNames: [],
  });
  try {
    const timer = setTimeout(
      () => void session.abort({ reason: "hephaestus: planner timeout" }),
      input.timeoutMs ?? 10 * 60_000,
    );
    try {
      await session.prompt(prompt);
    } finally {
      clearTimeout(timer);
    }
    const last = session.getLastAssistantMessage();
    const output =
      (last?.content ?? [])
        .flatMap((b) => {
          const block = b as { type?: string; text?: unknown };
          return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
        })
        .join("") ||
      (last?.errorMessage ?? "");
    const ctx: GateContext = {
      brief: input.brief,
      workspace: input.workspace,
      limits: input.limits ?? DEFAULT_LIMITS,
      projectGates: input.projectGates,
      ...(input.files ? { files: input.files } : {}),
    };
    const tokens = session.getSessionStats().tokens;
    return {
      evaluation: evaluatePlannerOutput(output, ctx, briefHash(input.brief)),
      output,
      usage: {
        input: tokens.input,
        output: tokens.output,
        cache_read: tokens.cacheRead,
        cache_write: tokens.cacheWrite,
      },
      transcript: JSON.stringify(session.messages),
      prompt_hash: createHash("sha256").update(SYSTEM).update(template).digest("hex"),
    };
  } finally {
    await session.dispose();
  }
}
