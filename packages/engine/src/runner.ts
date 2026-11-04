import { join } from "node:path";
import {
  type Complexity,
  type ContextPack,
  type Criterion,
  type GateResult,
  type Return,
  type Task,
  type UnitBrief,
  WorkerResult,
} from "@hephaestus/core";
import type { Usage } from "@hephaestus/ledger";
import type { Sandbox } from "@hephaestus/sandbox";
import { buildContextPack } from "./context.ts";
import { Stopped } from "./effects.ts";
import type { UnitGate } from "./gates.ts";
import { createGit, type Diff } from "./git.ts";
import type { SpawnOutput, Worker } from "./worker.ts";

const DEFAULT_GATE_TIMEOUT_MS = 10 * 60_000;

/** Why a build stopped on purpose: `heph cancel`/a user, or a handoff to another node. */
export type StopReason = "user" | "handoff";

/** An AbortSignal's reason as a StopReason: "handoff" when it says so, else "user". */
export const stopReason = (signal: AbortSignal | undefined): StopReason =>
  signal?.reason === "handoff" ? "handoff" : "user";

/** Everything one attempt needs, decided by the coordinator (SPEC section 7). */
export type AttemptRequest = {
  runId: string;
  task: Task;
  attempt: number;
  tier: Complexity;
  role: string;
  model: string;
  effort?: string | undefined;
  repoDir: string;
  projectPath: string;
  /** The attempt's branch and the run-branch commit it starts from. */
  branch: string;
  tip: string;
  locked: string[];
  constraints: string[];
  budgetTokens: number;
  feedback?: Return | undefined;
  criteria: Criterion[];
  decisions: string[];
  project: ContextPack["project"];
  signal?: AbortSignal | undefined;
};

export type AttemptStarted = { sizeTokens: number; truncated: string[] };

export type AttemptResult =
  | {
      kind: "interrupted";
      reason: "rate_limit" | StopReason;
      retryAfter?: string | undefined;
      promptHash?: string | undefined;
    }
  | {
      kind: "finished";
      outcome: "green" | "red" | "blocked" | "error";
      /** The attempt's commit on its branch, and its diff against `tip`. */
      sha: string;
      diff: Diff;
      transcript: string;
      usage: Usage;
      durationMs: number;
      /** Every gate result, worker_output included, in order. */
      gates: GateResult[];
      blocked?: string | undefined;
      promptHash?: string | undefined;
    };

/**
 * Runs attempts (SPEC section 7). The coordinator decides what to run and writes every ledger
 * event; a runner only executes. `started` is called once the worker is about to start, so the
 * coordinator can record the attempt before anything can go wrong in it.
 */
export interface Runner {
  runAttempt(
    req: AttemptRequest,
    hooks: { started(s: AttemptStarted): void },
  ): Promise<AttemptResult>;
}

export type LocalRunnerOptions = {
  worker: Worker;
  gates: UnitGate[];
  gateSandbox?: ((workdir: string, task: Task) => Promise<Sandbox>) | undefined;
  worktreesDir: string;
  tools: string[];
  gateTimeoutMs?: number | undefined;
};

/** The in-process runner: a worktree per attempt, the worker, a commit, then the unit gates. */
export function localRunner(o: LocalRunnerOptions): Runner {
  return {
    async runAttempt(req, hooks) {
      const t = req.task;
      const git = createGit(req.repoDir);
      const worktree = join(o.worktreesDir, req.runId, t.id, `a${req.attempt}`);
      await git.worktreeAdd(worktree, req.branch, req.tip);
      try {
        const workdir = join(worktree, req.projectPath === "." ? "" : req.projectPath);
        const built = await buildContextPack({
          git,
          worktree,
          projectPath: req.projectPath,
          project: req.project,
          task: t,
          locked: req.locked,
          constraints: req.constraints,
          ...(req.feedback ? { feedback: req.feedback } : {}),
          budgetTokens: req.budgetTokens,
        });
        const brief: UnitBrief = {
          schema: 1,
          task: t,
          criteria: req.criteria,
          decisions: req.decisions,
          role: req.role,
          tier: req.tier,
          context: built.pack,
          constraints: req.constraints,
          locked_paths: req.locked,
          ...(req.feedback ? { feedback: req.feedback } : {}),
          output_schema: "WorkerResult",
        };
        hooks.started({ sizeTokens: built.sizeTokens, truncated: built.truncated });

        const started = Date.now();
        let out: SpawnOutput;
        try {
          out = await o.worker.spawn({
            role: req.role,
            brief,
            workdir,
            tools: o.tools,
            model: req.model,
            ...(req.effort ? { effort: req.effort } : {}),
            ...(req.signal ? { signal: req.signal } : {}),
          });
        } catch (e) {
          if (e instanceof Stopped) throw e;
          out = {
            output: undefined,
            transcript: `worker threw: ${e}`,
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            exit: "error",
          };
        }

        // Interrupted or rate-limited attempts never count and never escalate (SPEC sections 10, 13).
        if (out.exit === "rate_limited" || out.exit === "interrupted") {
          return {
            kind: "interrupted",
            reason: out.exit === "rate_limited" ? "rate_limit" : stopReason(req.signal),
            retryAfter: out.retry_after,
            promptHash: out.prompt_hash,
          };
        }

        const sha = await git.commitAll(
          worktree,
          `${t.title}\n\nHeph-Run: ${req.runId}\nHeph-Unit: ${t.id}\nHeph-Attempt: ${req.attempt}\n`,
        );
        const diff = await git.diff(req.tip, sha);
        const parsed = WorkerResult.safeParse(out.output);
        const gates: GateResult[] = [];
        let outcome: "green" | "red" | "blocked" | "error";
        if (out.exit === "error" || !parsed.success) {
          outcome = "error";
          gates.push({
            gate: "worker_output",
            verdict: "fail",
            reason: parsed.success
              ? "worker exited with an error"
              : "worker output does not match WorkerResult",
            evidence: parsed.success
              ? ["worker exited with an error"]
              : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
          });
        } else if (parsed.data.blocked) {
          outcome = "blocked";
        } else {
          // Gates run in a fresh sandbox over the attempt (SPEC section 11), opened only if needed.
          const sandbox =
            o.gateSandbox && o.gates.some((g) => g.needsSandbox)
              ? await o.gateSandbox(workdir, t)
              : undefined;
          try {
            for (const gate of o.gates) {
              try {
                gates.push(
                  await gate.run({
                    task: t,
                    attempt: req.attempt,
                    project: t.project,
                    projectPath: req.projectPath,
                    workdir,
                    diff,
                    lockedPaths: req.locked,
                    worker: parsed.data,
                    commands: req.project.commands,
                    timeoutMs: o.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
                    ...(sandbox ? { sandbox } : {}),
                  }),
                );
              } catch (e) {
                if (e instanceof Stopped) throw e;
                gates.push({
                  gate: gate.name,
                  verdict: "fail",
                  reason: `gate crashed: ${e}`,
                  evidence: [String(e)],
                });
              }
            }
          } finally {
            await sandbox?.dispose();
          }
          outcome = gates.some((g) => g.verdict === "fail") ? "red" : "green";
        }
        return {
          kind: "finished",
          outcome,
          sha,
          diff,
          transcript: out.transcript,
          usage: out.usage,
          durationMs: Date.now() - started,
          gates,
          blocked: parsed.success ? parsed.data.blocked?.reason : undefined,
          promptHash: out.prompt_hash,
        };
      } finally {
        await git.worktreeRemove(worktree);
      }
    },
  };
}
