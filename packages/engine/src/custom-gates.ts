import type { Criterion, Task } from "@hephaestus/core";
import { namedCommandGate } from "./builtin-gates.ts";
import type { EngineConfig } from "./config.ts";
import type { UnitGate } from "./gates.ts";

/**
 * The custom gates one attempt of `task` runs, after the built-ins: the gate of every criterion
 * that names one (`check: { gate }`) and that the task covers (test tasks never run these), then
 * the project's `always` gates, in key order. A name selected twice runs once.
 */
export function customGatesFor(o: {
  task: Task;
  criteria: Criterion[];
  specs: EngineConfig["customGates"];
}): UnitGate[] {
  const { task, criteria, specs } = o;
  const own = specs?.[task.project];
  const picked: string[] = [];
  const add = (name: string) => {
    if (!picked.includes(name)) picked.push(name);
  };
  if (task.kind !== "test") {
    for (const c of criteria) {
      if (c.check?.gate !== undefined && task.covers.includes(c.id)) add(c.check.gate);
    }
  }
  for (const [name, spec] of Object.entries(own ?? {})) if (spec.always) add(name);
  return picked.map((name) => namedCommandGate(name, own?.[name], task.project));
}
