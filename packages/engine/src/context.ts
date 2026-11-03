import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ContextPack, globsOverlap, type Return, type Task } from "@hephaestus/core";
import type { Git } from "./git.ts";

export type PackInput = {
  git: Git;
  /** Root of the attempt's worktree (the repo root). */
  worktree: string;
  /** Project root inside the repo, "." for the repo root. */
  projectPath: string;
  project: ContextPack["project"];
  task: Task;
  /** Project-relative locked paths. */
  locked: string[];
  constraints: string[];
  feedback?: Return;
  budgetTokens: number;
};

export type BuiltPack = { pack: ContextPack; sizeTokens: number; truncated: string[] };

/** Rough token estimate; only used to keep packs near their budget. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Minimal v0 pack (SPEC section 9): locked files in full, then scope files in full by path order
 * until the budget is reached; the rest are recorded as truncated. No neighbors or repo map yet.
 */
export async function buildContextPack(input: PackInput): Promise<BuiltPack> {
  const prefix = input.projectPath === "." ? "" : `${input.projectPath.replace(/\/$/, "")}/`;
  const projectFiles = (await input.git.lsFiles(input.worktree))
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .sort();
  const read = (rel: string) => readFileSync(join(input.worktree, prefix, rel), "utf8");

  const lockedSet = new Set(input.locked);
  const locked = input.locked
    .filter((p) => projectFiles.includes(p))
    .map((path) => ({ path, content: read(path) }));

  let size =
    locked.reduce((n, f) => n + estimateTokens(f.content), 0) +
    (input.feedback ? estimateTokens(JSON.stringify(input.feedback)) : 0);
  const files: ContextPack["files"] = [];
  const truncated: string[] = [];
  for (const path of projectFiles) {
    if (lockedSet.has(path) || !input.task.scope.some((g) => globsOverlap(g, path))) continue;
    const content = read(path);
    const cost = estimateTokens(content);
    if (size + cost > input.budgetTokens) {
      truncated.push(path);
      continue;
    }
    size += cost;
    files.push({ path, content, why: "scope" });
  }

  const pack: ContextPack = {
    schema: 1,
    budget_tokens: input.budgetTokens,
    project: input.project,
    conventions: "",
    repo_map: "",
    files,
    contracts: [],
    locked,
    constraints: input.constraints,
    ...(input.feedback ? { feedback: input.feedback } : {}),
  };
  return { pack, sizeTokens: size, truncated };
}
