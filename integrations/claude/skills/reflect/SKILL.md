---
name: reflect
description: After a heph run finishes or a work session ends, review what went wrong or took too long, and propose the smallest edit to a skill, CLAUDE.md, docs/known-issues.md or a role prompt that would have prevented it. Use at the end of a heph run, when the user says "reflect" or "what did we learn", or when CLAUDE.md says to run it at session end. Proposes only; never applies an edit without the user's approval.
---

# Reflect

Turn this session's friction into one small, evidenced edit. Never apply anything until the user says yes.

## 1. Gather evidence (read only)

- Heph runs touched this session: `heph stats --list` (class and reasons per run), then for each assisted or failed run `heph_status` or `heph explain <run>` for escalations, stalls, hints and replans.
- This session: commands that failed and were retried, corrections the user gave, work redone, anything that took far longer than expected.
- Read `docs/decisions.md` and `docs/known-issues.md` so you do not propose what is already recorded.

## 2. List what went wrong

Short list, each item with its evidence (run id and event, or the moment in the session). Skip anything that went fine and anything with no evidence. If nothing went wrong, say so and stop.

## 3. Propose the smallest edit per item

For each item, one proposal:

- **Where:** `docs/known-issues.md` (a gotcha), `docs/decisions.md` (a settled choice), CLAUDE.md, the heph skill (`integrations/claude/skills/heph/SKILL.md`), a role prompt file, or a project gate config.
- **The exact text** to add or change, a line or two.
- **Why it would have prevented the problem**, naming the evidence.

Prefer deleting or tightening existing text over adding. One occurrence is a note for `known-issues.md`; a rule in a skill or CLAUDE.md needs the same failure at least twice or a clear cause. Do not propose engine code changes here; that is a normal task.

## 4. Wait

Show the proposals and ask which to apply. Apply only the approved ones, then add a line to the `docs/progress.md` log. A rule added to the heph skill should be mirrored in `integrations/codex/AGENTS.md` when that file covers the same ground.
