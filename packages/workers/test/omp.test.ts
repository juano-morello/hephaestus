import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitBrief } from "@hephaestus/core";
import type { SpawnInput } from "@hephaestus/engine";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent";
import {
  createOmpWorker,
  defaultModelPattern,
  exitFrom,
  type OmpSession,
  serializeCreation,
  sessionOptions,
  thinkingFor,
} from "../src/omp.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

const brief = (locked: string[] = []): UnitBrief => ({
  schema: 1,
  task: {
    id: "T2",
    title: "impl",
    kind: "implement",
    project: "server",
    lane: "contained",
    complexity: "standard",
    complexity_reason: "x",
    scope: ["add.sh"],
    covers: ["AC1"],
    spec: "write add.sh",
  },
  role: "implementer",
  tier: "standard",
  context: {
    schema: 1,
    budget_tokens: 1000,
    project: { name: "server", stack: "sh", commands: {} },
    conventions: "",
    repo_map: "",
    files: [],
    contracts: [],
    locked: [],
    constraints: [],
  },
  constraints: [],
  criteria: [{ id: "AC1", text: "sh add.sh 2 3 prints 5", kind: "behavior" }],
  decisions: [],
  locked_paths: locked,
  output_schema: "WorkerResult",
});

describe("session options", () => {
  test("only our tools, nothing discovered, nothing that reaches the host", () => {
    const opts = sessionOptions({
      cwd: "/w",
      modelPattern: "sonnet",
      thinking: "high",
      systemPrompt: "role",
      tools: [],
    });
    expect(opts).toMatchObject({
      cwd: "/w",
      modelPattern: "sonnet",
      thinkingLevel: "high",
      systemPrompt: ["role"],
      restrictToolNames: true,
      allowRestrictedCustomTools: true,
      toolNames: [...TOOL_NAMES],
      enableMCP: false,
      enableLsp: false,
      disableExtensionDiscovery: true,
      disableModelFallback: true,
      skills: [],
      contextFiles: [],
      rules: [],
    });
    expect(opts.settings).toBeDefined();
    expect(opts.sessionManager).toBeDefined();
  });

  test("model ids and effort map onto OMP's names", () => {
    expect(defaultModelPattern("claude/sonnet")).toBe("sonnet");
    expect(defaultModelPattern("openai/gpt-5.2")).toBe("gpt-5.2");
    expect(defaultModelPattern("opus")).toBe("opus");
    expect(thinkingFor("high")).toBe("high");
    expect(thinkingFor(undefined)).toBe("medium");
    expect(thinkingFor("turbo")).toBe("medium");
  });
});

describe("exitFrom", () => {
  const msg = (m: object) =>
    ({ stopReason: "stop", ...m }) as Parameters<typeof exitFrom>[0]["last"];
  test("maps how the session ended to the worker exit", () => {
    expect(exitFrom({ last: msg({}) })).toBe("ok");
    expect(exitFrom({ last: msg({ stopReason: "error", errorMessage: "boom" }) })).toBe("error");
    expect(exitFrom({ last: msg({ stopReason: "error", errorStatus: 429 }) })).toBe("rate_limited");
    expect(
      exitFrom({
        last: msg({ stopReason: "error", errorMessage: "You have hit your usage limit" }),
      }),
    ).toBe("rate_limited");
    expect(exitFrom({ threw: new Error("429 Too Many Requests") })).toBe("rate_limited");
    expect(exitFrom({ threw: new Error("socket hang up") })).toBe("error");
    expect(exitFrom({ timedOut: true, last: msg({ stopReason: "aborted" }) })).toBe("error");
    expect(exitFrom({ interrupted: true, last: msg({ stopReason: "aborted" }) })).toBe(
      "interrupted",
    );
  });
});

/** Stands in for an OMP session: "the model" calls tools by name, then stops. */
function fakeSession(
  script: (call: (name: string, params: object) => Promise<string>) => Promise<void>,
) {
  const state = { disposed: false, aborted: false, prompt: "" };
  const make = async (opts: ReturnType<typeof sessionOptions>) => {
    const tools = new Map((opts.customTools ?? []).map((t) => [t.name, t]));
    const call = async (name: string, params: object) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      const r = await (tool as CustomTool).execute("id", params as never, undefined, {} as never);
      return (r.content[0] as { text: string }).text;
    };
    const session: OmpSession = {
      async prompt(text) {
        state.prompt = text;
        await script(call);
        return true;
      },
      async abort() {
        state.aborted = true;
      },
      getLastAssistantMessage: () => ({ stopReason: "stop" }),
      getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheRead: 300, cacheWrite: 4 } }),
      get messages() {
        return [{ role: "user", content: "x" }];
      },
      async dispose() {
        state.disposed = true;
      },
    };
    return { session };
  };
  return { make, state };
}

const input = (workdir: string, b = brief()): SpawnInput => ({
  role: "implementer",
  brief: b,
  workdir,
  tools: [],
  model: "claude/sonnet",
  effort: "medium",
});

describe("createOmpWorker", () => {
  test("runs the model's tool calls in the sandbox and returns its result", async () => {
    const work = dir();
    const { make, state } = fakeSession(async (call) => {
      await call("write", { path: "add.sh", content: "echo $(($1 + $2))\n" });
      expect(await call("bash", { command: "sh add.sh 2 3" })).toBe("exit 0\n5\n");
      await call("submit_result", { summary: "added", claims: ["2+3=5"], touched: ["add.sh"] });
    });
    const worker = createOmpWorker({
      sandbox: (i) => ({ mode: "native", hostDir: i.workdir }),
      createSession: make,
    });
    const out = await worker.spawn(input(work));

    expect(readFileSync(join(work, "add.sh"), "utf8")).toBe("echo $(($1 + $2))\n");
    expect(out).toMatchObject({
      exit: "ok",
      output: { schema: 1, summary: "added", claims: ["2+3=5"], touched: ["add.sh"] },
      usage: { input: 10, output: 20, cache_read: 300, cache_write: 4 },
    });
    expect(out.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.transcript).toContain('"role":"user"');
    expect(state.prompt).toContain("# Task T2: impl");
    expect(state.disposed).toBe(true);
  });

  test("tool errors go back to the model instead of crashing the attempt", async () => {
    const work = dir();
    let seen = "";
    const { make } = fakeSession(async (call) => {
      seen = await call("write", { path: "a_test.sh", content: "x" });
    });
    const worker = createOmpWorker({
      sandbox: (i) => ({ mode: "native", hostDir: i.workdir }),
      createSession: make,
    });
    const out = await worker.spawn(input(work, brief(["a_test.sh"])));
    expect(seen).toStartWith("error: a_test.sh is locked");
    expect(existsSync(join(work, "a_test.sh"))).toBe(false);
    expect(out).toMatchObject({ exit: "ok", output: undefined });
  });

  test("an aborted signal stops the session and the attempt exits interrupted", async () => {
    const work = dir();
    const stop = new AbortController();
    const { make, state } = fakeSession(async () => {
      stop.abort("handoff");
      while (!state.aborted) await Bun.sleep(5);
    });
    const worker = createOmpWorker({
      sandbox: (i) => ({ mode: "native", hostDir: i.workdir }),
      createSession: make,
    });
    const out = await worker.spawn({ ...input(work), signal: stop.signal });
    expect(state.aborted).toBe(true);
    expect(out.exit).toBe("interrupted");
    expect(state.disposed).toBe(true);
  });

  test("a session past its timeout is aborted and counts as an error", async () => {
    const work = dir();
    const { make, state } = fakeSession(() => new Promise((r) => setTimeout(r, 2000)));
    const worker = createOmpWorker({
      sandbox: (i) => ({ mode: "native", hostDir: i.workdir }),
      createSession: make,
      timeoutMs: 100,
    });
    const out = await worker.spawn(input(work));
    expect(state.aborted).toBe(true);
    expect(out.exit).toBe("error");
    expect(state.disposed).toBe(true);
  });
});

describe("serializeCreation", () => {
  test("concurrent creations never overlap, and a failure does not block the next", async () => {
    let active = 0;
    let maxActive = 0;
    const create = async (fail = false) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(20);
      active--;
      if (fail) throw new Error("boom");
      return "ok";
    };
    const results = await Promise.allSettled([
      serializeCreation(() => create()),
      serializeCreation(() => create(true)),
      serializeCreation(() => create()),
    ]);
    expect(maxActive).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});
