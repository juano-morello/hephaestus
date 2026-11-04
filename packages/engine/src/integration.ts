import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { GateResult, Workspace } from "@hephaestus/core";
import type { Sandbox } from "@hephaestus/sandbox";
import { tail } from "./builtin-gates.ts";
import { createGit } from "./git.ts";

export type IntegrationInput = {
  workspace: Workspace;
  workspaceRoot: string;
  /** Repo -> ref to assemble: the run branch for touched repos, the target for the rest. */
  refs: Record<string, string>;
  /** A fresh, empty directory to assemble into; removed afterwards. */
  assembleDir: string;
  sandbox?: (dir: string) => Promise<Sandbox>;
  timeoutMs: number;
};

const result = (ok: boolean, reason: string, evidence: string[] = []): GateResult => ({
  gate: "integration",
  verdict: ok ? "pass" : "fail",
  reason,
  evidence: ok ? [] : evidence,
});

/**
 * The workspace integration gate (SPEC section 11): every repo checked out in the workspace
 * layout at the changeset's refs, the integration script run over the whole thing in a sandbox.
 */
export async function runIntegrationGate(input: IntegrationInput): Promise<GateResult> {
  const script = input.workspace.integration?.gate;
  if (!script) return result(true, "skipped: no integration gate configured");
  if (!input.sandbox) return result(false, "no sandbox configured for the integration gate");

  const scriptRel = relative(input.workspaceRoot, resolve(input.workspaceRoot, script));
  if (scriptRel.startsWith("..") || isAbsolute(scriptRel)) {
    return result(false, `integration gate is outside the workspace: ${script}`);
  }

  // The repo at "." (if any) goes first so the others can nest inside it.
  const repos = Object.entries(input.workspace.repos).sort(
    ([, a], [, b]) => normalize(a).length - normalize(b).length,
  );
  const added: { repo: string; path: string }[] = [];
  mkdirSync(input.assembleDir, { recursive: true });
  try {
    for (const [repo, repoPath] of repos) {
      const ref = input.refs[repo];
      if (!ref) continue;
      const path = join(input.assembleDir, normalize(repoPath));
      mkdirSync(dirname(path), { recursive: true });
      await createGit(resolve(input.workspaceRoot, repoPath)).worktreeAddDetached(path, ref);
      added.push({ repo, path });
    }
    // A script inside a repo comes from the changeset itself; one outside every repo is copied in.
    const scriptPath = join(input.assembleDir, scriptRel);
    if (!existsSync(scriptPath)) {
      mkdirSync(dirname(scriptPath), { recursive: true });
      copyFileSync(resolve(input.workspaceRoot, scriptRel), scriptPath);
    }

    const sb = await input.sandbox(input.assembleDir);
    try {
      const r = await sb.exec(`sh ${scriptRel}`, { timeoutMs: input.timeoutMs });
      const out = tail(r.stdout, r.stderr);
      const evidence = [`exit ${r.code}`, ...(out ? [out] : [])];
      if (r.timedOut) return result(false, `timed out after ${input.timeoutMs} ms`, evidence);
      return r.code === 0
        ? result(true, "integration gate passed")
        : result(false, "integration gate failed", evidence);
    } finally {
      await sb.dispose();
    }
  } finally {
    for (const { repo, path } of added.reverse()) {
      await createGit(
        resolve(input.workspaceRoot, input.workspace.repos[repo] as string),
      ).worktreeRemove(path);
    }
    rmSync(input.assembleDir, { recursive: true, force: true });
  }
}
