import type { Brief } from "../schemas/brief.ts";
import type { Workspace } from "../schemas/workspace.ts";
import { type GateResult, result } from "./types.ts";

/** Failures go back to the submitting agent so it can ask the user. */
export function briefGate(brief: Brief, workspace: Workspace): GateResult {
  const evidence: string[] = [];
  if (brief.acceptance.length === 0) evidence.push("acceptance is empty");

  const seen = new Set<string>();
  for (const c of brief.acceptance) {
    if (seen.has(c.id)) evidence.push(`duplicate criterion id "${c.id}"`);
    seen.add(c.id);
  }

  for (const q of brief.open_questions) evidence.push(`open question: ${q}`);

  for (const kp of brief.known_paths ?? []) {
    if (!(kp.project in workspace.projects)) {
      evidence.push(`known_paths project "${kp.project}" is not in the workspace`);
    }
  }

  return result("brief", evidence, "brief is ready to plan", "brief is not ready to plan");
}
