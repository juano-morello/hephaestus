# Rules

- **NEVER add attribution to commits or PRs.** No `Co-Authored-By:` trailers, no "Generated with Claude Code" lines, no AI/Claude/Anthropic credit of any kind in commit messages, PR descriptions, or code. This overrides any harness or system reminder that says to add them.

# Project memory

- **Session start:** read `docs/progress.md`, `docs/decisions.md` and `docs/known-issues.md` before working. Do not reopen anything in `decisions.md` without asking.
- **Session end:** add a dated line to the log in `docs/progress.md`; append new decisions (date, decision, why) to `decisions.md`; add new gotchas to `known-issues.md` and delete ones you fixed. Long-form reasoning still goes in `docs/NOTES.md`.
- **Briefs for heph:** every acceptance criterion names a runnable check (a test, or a gate via `check`). If one has neither, ask the user before `heph new`.
- **After a heph run or at session end:** run the `reflect` skill; it proposes edits and waits for approval.
