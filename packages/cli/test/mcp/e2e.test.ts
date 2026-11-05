// heph mcp over real stdio, against a real daemon (the scripted planner and worker of
// test/fixtures/deps.ts). The test plays both the chat host and the user who approves.
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BRIEF, heph, MAIN, setup, startDaemon } from "./daemon-fixture.ts";

type Result = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function useDaemon(home: string, workerMs = 0) {
  return startDaemon(home, workerMs, (d) =>
    cleanups.push(() => {
      d.kill("SIGKILL");
    }),
  );
}

async function mcpClient(home: string, ws: string) {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [MAIN, "mcp", "--home", home, "--workspace", ws],
    env: { ...(process.env as Record<string, string>), HEPH_HOME: home },
    stderr: "pipe",
  });
  const client = new Client({ name: "heph-e2e", version: "0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as Result;
  return { client, call, transport };
}

const text = (r: Result) => r.content.map((c) => c.text).join("\n");
/** The structured answer, which every successful heph tool call carries. */
const sc = (r: Result) => r.structuredContent ?? {};

async function workspace() {
  const s = await setup();
  cleanups.push(s.cleanup);
  return s;
}

describe("heph mcp end to end", () => {
  test("a chat host plans, waits for the user's approval, builds and watches a run", async () => {
    const { ws, home } = await workspace();
    await useDaemon(home);
    const { client, call } = await mcpClient(home, ws);

    // 1. The nine tools.
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "heph_cancel",
      "heph_explain",
      "heph_hint",
      "heph_new",
      "heph_plan_revise",
      "heph_plan_show",
      "heph_run",
      "heph_status",
      "heph_watch",
    ]);

    // 2. Plan a run; the plan waits for the user.
    const created = await call("heph_new", { brief: BRIEF });
    expect(created.isError).toBeUndefined();
    expect(created.structuredContent).toMatchObject({ status: "planned" });
    const id = sc(created).run_id as string;
    expect(id).toBeTruthy();
    expect((sc(created).tasks as { id: string }[]).map((t) => t.id)).toEqual(["T1", "T2"]);
    const shown = await call("heph_plan_show", { run: id });
    expect(shown.isError).toBeUndefined();
    expect(shown.structuredContent).toMatchObject({ run_id: id, approved: false });

    // 3. heph_run does not start an unapproved plan.
    const early = await call("heph_run", { run: id });
    expect(early.isError).toBeUndefined();
    expect(early.structuredContent).toMatchObject({ state: "awaiting_plan_approval" });
    const before = await call("heph_status", { run: id });
    expect((sc(before).run as { status: string }).status).toBe("planned");
    expect(sc(before).plan_approved).toBe(false);

    // 4. The user approves, through the CLI.
    expect((await heph(ws, home, ["approve", "plan", id])).ok).toBe(true);

    // 5. Now it starts; watch it to the end with the cursor fed back.
    const started = await call("heph_run", { run: id });
    expect(started.isError).toBeUndefined();
    expect(sc(started).state).toBe("started");
    let cursor = sc(started).cursor as string | undefined;
    let outcome = (sc(started).outcome as string | undefined) ?? "running";
    const lines = [...(sc(started).lines as string[])];
    for (let i = 0; i < 20 && !["staged", "finished", "failed"].includes(outcome); i++) {
      const w = await call("heph_watch", {
        run: id,
        wait_s: 5,
        ...(cursor === undefined ? {} : { since: cursor }),
      });
      expect(w.isError).toBeUndefined();
      cursor = (sc(w).cursor as string | undefined) ?? cursor;
      outcome = sc(w).outcome as string;
      lines.push(...(sc(w).lines as string[]));
    }
    expect(outcome).not.toBe("failed");
    expect(["staged", "finished"]).toContain(outcome);
    expect(lines.join("\n")).toContain("T1");
  }, 120_000);

  test("stdout carries only JSON-RPC messages", async () => {
    const { ws, home } = await workspace();
    await useDaemon(home);
    const p = Bun.spawn(["bun", MAIN, "mcp", "--home", home, "--workspace", ws], {
      env: { ...process.env, HEPH_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    cleanups.push(() => {
      p.kill("SIGKILL");
    });
    const send = (m: unknown) => p.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await p.stdin.flush();

    // Read until both answers are in, then hang up and take whatever else it printed.
    let out = "";
    const reader = p.stdout.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 15_000;
    while (!out.includes('"id":2') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    p.stdin.end();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    expect(await p.exited).toBe(0);

    const lines = out.split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(2);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ jsonrpc: "2.0" });
    const [init, list] = lines.map((l) => JSON.parse(l));
    expect(init).toMatchObject({ id: 1, result: { serverInfo: { name: "heph" } } });
    expect(list.result.tools).toHaveLength(9);
  }, 60_000);

  test("the same server recovers when the daemon goes away and comes back", async () => {
    const { ws, home } = await workspace();
    const first = await useDaemon(home);
    const { call, transport } = await mcpClient(home, ws);
    const pid = transport.pid;

    expect((await call("heph_status", {})).isError).toBeUndefined();

    first.kill("SIGKILL");
    await first.exited;
    const down = await call("heph_status", {});
    expect(down.isError).toBe(true);
    expect(text(down)).toContain("heph daemon is not running");

    await useDaemon(home);
    const back = await call("heph_status", {});
    expect(back.isError).toBeUndefined();
    expect(transport.pid).toBe(pid);
  }, 60_000);
});
