import type { UnitBrief } from "@hephaestus/core";
import documenter from "../prompts/roles/documenter.md" with { type: "text" };
import implementer from "../prompts/roles/implementer.md" with { type: "text" };
import testAuthor from "../prompts/roles/test_author.md" with { type: "text" };

export const ROLES = ["test_author", "implementer", "documenter"] as const;

/** Role prompts are files (SPEC section 5), loaded as the worker's system prompt. */
const ROLE_PROMPTS: Record<(typeof ROLES)[number], string> = {
  test_author: testAuthor,
  implementer,
  documenter,
};

/** Embedded at build time, so the compiled binary needs no prompt files next to it. */
export async function loadRolePrompt(role: string, instructions?: string): Promise<string> {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`no role prompt for ${role}`);
  const base = ROLE_PROMPTS[role as (typeof ROLES)[number]];
  // Project files only ever add to the built-in prompt, never replace it.
  return instructions?.trim() ? `${base}\n\n## Project instructions\n\n${instructions}` : base;
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
      .map(
        (r) =>
          `- ${r.gate}: ${r.reason}${r.evidence.length ? `\n\n${fence(r.evidence.join("\n"))}` : ""}`,
      )
      .join("\n\n");
    sections.push(
      `## Feedback from attempt ${brief.feedback.attempt}\n\nThe checks failed. Instruction: ${brief.feedback.instruction}.\n\n${reasons}${brief.feedback.diff_stat ? `\n\nThat attempt changed: ${brief.feedback.diff_stat}. Do not repeat it unchanged; the same result will fail the same way.` : ""}`,
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
