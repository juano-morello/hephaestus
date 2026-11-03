import { join } from "node:path";
import type { UnitBrief } from "@hephaestus/core";

export const ROLES = ["test_author", "implementer", "documenter"] as const;

/** Role prompts are files (SPEC section 5), loaded as the worker's system prompt. */
export async function loadRolePrompt(role: string): Promise<string> {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`no role prompt for ${role}`);
  return Bun.file(join(import.meta.dir, "..", "prompts", "roles", `${role}.md`)).text();
}

const fence = (text: string) => `\`\`\`\n${text.replace(/\n$/, "")}\n\`\`\``;
const bullets = (items: string[], empty = "None.") =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : empty;

/** The user message for one attempt, built by code from the UnitBrief only. */
export function renderUnitPrompt(brief: UnitBrief): string {
  const { task, context } = brief;
  const commands = Object.entries(context.project.commands)
    .filter(([, cmd]) => cmd)
    .map(([name, cmd]) => `${name}: \`${cmd}\``);
  const sections = [
    `# Task ${task.id}: ${task.title}`,
    `Kind: ${task.kind}. Project: ${context.project.name} (${context.project.stack}). Lane: ${task.lane}. Tier: ${brief.tier}.`,
    `## What to do\n\n${task.spec}`,
    `## Scope\n\nChange only files matching these globs (relative to the project root, your working directory):\n\n${bullets(task.scope)}`,
    `## Locked files (never modify)\n\n${bullets(brief.locked_paths)}`,
    `## Constraints\n\n${bullets(brief.constraints)}`,
    `## Acceptance criteria this task covers\n\n${bullets(
      brief.criteria.map(
        (c) =>
          `${c.id}: ${c.text}${c.check ? ` (checked by the ${c.check.gate} gate, not by a test)` : ""}`,
      ),
    )}`,
    `## Decisions (settled, do not reopen)\n\n${bullets(brief.decisions)}`,
  ];

  if (brief.feedback) {
    const reasons = brief.feedback.reasons
      .map((r) => `- ${r.gate}: ${r.reason}${r.evidence ? `\n\n${fence(r.evidence)}` : ""}`)
      .join("\n\n");
    sections.push(
      `## Feedback from attempt ${brief.feedback.attempt}\n\nThe checks failed. Instruction: ${brief.feedback.instruction}.\n\n${reasons}`,
    );
  }

  const files = [
    ...context.files.map((f) => `### ${f.path}\n\n${fence(f.content ?? f.outline ?? "")}`),
    ...context.locked.map((f) => `### ${f.path} (locked)\n\n${fence(f.content)}`),
  ];
  sections.push(
    `## Project files\n\n${files.length ? files.join("\n\n") : "None included; use the tools to look."}`,
  );
  sections.push(`## Commands\n\n${bullets(commands)}`);
  sections.push(
    "## When you are done\n\nRun the relevant checks yourself first. Then call `submit_result` exactly once: a short summary, the claims you verified, and every file you changed in `touched`. If the task cannot be done without breaking a rule above, call it with `blocked_reason` instead of working around the rule.",
  );
  return `${sections.join("\n\n")}\n`;
}
