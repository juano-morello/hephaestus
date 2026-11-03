// Validate a golden task suite (SPEC section 14) and report which tasks are ready to run.
//
//   bun run packages/core/scripts/eval-check.ts --suite <dir> [--no-git]
//
// A suite dir holds workspace.yaml, gates.yaml and evals/*.yaml. Repo paths in workspace.yaml
// are resolved against the suite dir, and every pinned commit must exist in its repo
// (skipped with --no-git, for synthetic suites whose repos do not exist).

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadSuite } from "../src/eval/suite.ts";

const { values } = parseArgs({
  options: { suite: { type: "string" }, "no-git": { type: "boolean", default: false } },
});
if (!values.suite) {
  console.error("usage: eval-check.ts --suite <dir>");
  process.exit(2);
}

const suite = await loadSuite(resolve(values.suite));

async function commitExists(repoDir: string, sha: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "-C", repoDir, "cat-file", "-e", `${sha}^{commit}`], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await proc.exited) === 0) return undefined;
  return (await new Response(proc.stderr).text()).trim() || "not found";
}

let invalid = 0;
for (const { task, check } of suite.tasks) {
  const issues = [...check.issues];
  let status = check.status;
  const pins = values["no-git"] ? [] : Object.entries(task?.workspace_ref ?? {});
  for (const [repo, sha] of pins) {
    const path = suite.workspace.repos[repo];
    if (!path) continue;
    const err = await commitExists(resolve(suite.dir, path), sha);
    if (err) {
      issues.push(`workspace_ref: ${repo}@${sha}: ${err}`);
      status = "invalid";
    }
  }
  if (status === "invalid") invalid++;
  const kind = task?.expect === "escalate" ? "escalate" : "oracle";
  console.log(
    `${status.padEnd(12)} ${check.id.padEnd(28)} ${kind.padEnd(9)} ${task?.tags.join(",") ?? ""}`,
  );
  for (const issue of issues) console.log(`             - ${issue}`);
}

const ready = suite.tasks.length - invalid;
console.log(`\n${suite.tasks.length} task(s), ${invalid} invalid, ${ready} well-formed`);
process.exit(invalid ? 1 : 0);
