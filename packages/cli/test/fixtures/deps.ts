// Scripted planner and worker for heph processes started by tests (HEPH_DEPS_MODULE): the calc
// plan, and a worker that writes each unit's files after HEPH_TEST_WORKER_MS.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Worker } from "@hephaestus/engine";
import { type PlannerInput, type PlannerSession, runPlanner } from "@hephaestus/workers";
import type { Deps } from "../../src/runtime.ts";

const task = (t: Record<string, unknown>) => ({
  lane: "contained",
  complexity: "standard",
  complexity_reason: "small",
  covers: ["AC1"],
  project: "calc",
  ...t,
});
export const PLAN = JSON.stringify({
  schema: 1,
  tasks: [
    task({
      id: "T1",
      title: "tests",
      kind: "test",
      scope: ["test_add.sh"],
      creates: ["test_add.sh"],
      produces: ["test:Add"],
      spec: "write test_add.sh",
    }),
    task({
      id: "T2",
      title: "impl",
      kind: "implement",
      scope: ["add.sh"],
      creates: ["add.sh"],
      consumes: ["test:Add"],
      spec: "write add.sh",
    }),
  ],
  risks: [],
});
export const FILES: Record<string, Record<string, string>> = {
  T1: { "test_add.sh": '[ "$(sh add.sh 2 3)" = "5" ]\n' },
  T2: { "add.sh": "echo $(($1 + $2))\n" },
};

const planner = (input: PlannerInput) =>
  runPlanner({
    ...input,
    createSession: async () => {
      const session: PlannerSession = {
        async prompt() {
          return true;
        },
        async abort() {},
        getLastAssistantMessage: () => ({
          stopReason: "stop",
          content: [{ type: "text", text: PLAN }],
        }),
        getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }),
        messages: [],
        async dispose() {},
      };
      return { session };
    },
  });

const worker: Worker = {
  async spawn(input) {
    const ms = Number(process.env.HEPH_TEST_WORKER_MS ?? 0);
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (input.signal?.aborted)
        return {
          output: undefined,
          transcript: "",
          usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          exit: "interrupted",
        };
      await Bun.sleep(20);
    }
    const files = FILES[input.brief.task.id] ?? {};
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(input.workdir, p)), { recursive: true });
      writeFileSync(join(input.workdir, p), c);
    }
    return {
      output: { schema: 1, summary: "", claims: [], touched: Object.keys(files) },
      transcript: "",
      usage: { input: 10, output: 20, cache_read: 0, cache_write: 0 },
      exit: "ok",
    };
  },
};

export const deps: Deps = { planner, worker };
