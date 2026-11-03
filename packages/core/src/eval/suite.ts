import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Brief } from "../schemas/brief.ts";
import { EvalTask } from "../schemas/eval.ts";
import { ProjectGates } from "../schemas/gates.ts";
import { Workspace } from "../schemas/workspace.ts";
import { checkEvalTask, type EvalCheck } from "./check.ts";

export type SuiteTask = { file: string; task?: EvalTask; brief?: Brief; check: EvalCheck };
export type Suite = {
  dir: string;
  workspace: Workspace;
  projectGates: ProjectGates;
  tasks: SuiteTask[];
};

const loadYaml = async (path: string): Promise<unknown> =>
  Bun.YAML.parse(await Bun.file(path).text());

/**
 * A suite directory mirrors a workspace `.heph/`: workspace.yaml, gates.yaml and evals/*.yaml.
 * Paths inside a task file (brief, hidden tests) are relative to that file.
 */
export async function loadSuite(dir: string, opts: { evalsDir?: string } = {}): Promise<Suite> {
  const workspace = Workspace.parse(await loadYaml(join(dir, "workspace.yaml")));
  const projectGates = ProjectGates.parse(await loadYaml(join(dir, "gates.yaml")));
  const evalsDir = opts.evalsDir ?? join(dir, "evals");
  const files = readdirSync(evalsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const tasks: SuiteTask[] = [];
  for (const name of files) {
    const file = join(evalsDir, name);
    const parsed = EvalTask.safeParse(await loadYaml(file));
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      tasks.push({ file, check: { id: name, status: "invalid", issues } });
      continue;
    }

    const task = parsed.data;
    const base = dirname(file);
    let brief: Brief | undefined;
    let briefError: string | undefined;
    try {
      const result = Brief.safeParse(await loadYaml(resolve(base, task.brief)));
      if (result.success) brief = result.data;
      else
        briefError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) {
      briefError = String(e);
    }

    const exists = new Map<string, boolean>();
    for (const ht of task.oracle?.hidden_tests ?? []) {
      exists.set(ht.from, await Bun.file(resolve(base, ht.from)).exists());
    }

    const check = checkEvalTask(task, {
      workspace,
      projectGates,
      ...(brief ? { brief } : {}),
      ...(briefError ? { briefError } : {}),
      hiddenTestExists: (from) => exists.get(from) ?? false,
    });
    tasks.push({ file, task, ...(brief ? { brief } : {}), check });
  }
  return { dir, workspace, projectGates, tasks };
}
