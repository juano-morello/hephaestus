import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/proc.ts";
import { type ContainerSpec, openSandbox, removeContainers, type Sandbox } from "../src/sandbox.ts";
import { tempDir } from "./helpers.ts";

const IMAGE = "alpine:3.20";
const daemon = (await run(["docker", "info"], { timeoutMs: 10_000 })).code === 0;
if (!daemon)
  console.warn("docker sandbox tests skipped: no Docker daemon reachable (`docker info` failed)");

const dir = tempDir();

async function container(): Promise<{ host: string; sb: Sandbox & { id?: string } }> {
  const host = dir();
  const spec: ContainerSpec = { mode: "container", hostDir: host, image: IMAGE };
  return { host, sb: await openSandbox(spec) };
}

describe.skipIf(!daemon)("container sandbox", () => {
  test("runs commands in /work as the host user", async () => {
    const { sb } = await container();
    try {
      expect(sb).toMatchObject({ kind: "container", root: "/work" });
      const r = await sb.exec("pwd; id -u");
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(`/work\n${process.getuid?.()}\n`);
      expect((await sb.exec("cat", { stdin: "piped" })).stdout).toBe("piped");
    } finally {
      await sb.dispose();
    }
  }, 60_000);

  test("files written inside show up on the host, owned by the host user, and can be cleaned up", async () => {
    const { host, sb } = await container();
    try {
      await sb.writeFile("inventory/stack.go", "package inventory\n");
      await sb.exec("mkdir -p build && echo out > build/x.txt");
      expect(readFileSync(join(host, "inventory/stack.go"), "utf8")).toBe("package inventory\n");
      expect(statSync(join(host, "build/x.txt")).uid).toBe(process.getuid?.() as number);
      writeFileSync(join(host, "from-host.txt"), "hello");
      expect(await sb.readFile("from-host.txt")).toBe("hello");
      expect(await sb.readFile("/work/from-host.txt")).toBe("hello");
    } finally {
      await sb.dispose();
    }
    rmSync(join(host, "build"), { recursive: true });
    expect(existsSync(join(host, "build"))).toBe(false);
  }, 60_000);

  test("has no network", async () => {
    const { sb } = await container();
    try {
      const r = await sb.exec(
        "ip route; wget -q -T 2 -O- http://1.1.1.1 >/dev/null 2>&1; echo exit=$?",
      );
      expect(r.stdout).not.toContain("default");
      expect(r.stdout).toContain("exit=1");
    } finally {
      await sb.dispose();
    }
  }, 60_000);

  test("refuses paths outside /work and reports missing files", async () => {
    const { sb } = await container();
    try {
      await expect(sb.readFile("../etc/passwd")).rejects.toThrow("path escapes the sandbox");
      await expect(sb.writeFile("/etc/hosts", "x")).rejects.toThrow("path escapes the sandbox");
      await expect(sb.exec("pwd", { cwd: "/tmp" })).rejects.toThrow("path escapes the sandbox");
      await expect(sb.readFile("missing.txt")).rejects.toThrow("cannot read missing.txt");
    } finally {
      await sb.dispose();
    }
  }, 60_000);

  test("kills a command past its timeout", async () => {
    const { sb } = await container();
    try {
      const started = Date.now();
      const r = await sb.exec("sleep 30", { timeoutMs: 1000 });
      expect(r.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await sb.dispose();
    }
  }, 60_000);

  test("containers a killed process left are removed by their labels, others are kept", async () => {
    const run1 = `t${Date.now()}`;
    const open = (labels: Record<string, string>) =>
      openSandbox({ mode: "container", hostDir: dir(), image: IMAGE, labels }) as Promise<
        Sandbox & { id: string }
      >;
    const left = await open({ "heph.run": run1 });
    const other = await open({ "heph.run": `${run1}x` });
    try {
      // Nothing disposes `left`: its process was killed.
      expect(await removeContainers("docker", { "heph.run": run1 })).toBe(1);
      expect((await run(["docker", "inspect", left.id])).code).not.toBe(0);
      expect((await run(["docker", "inspect", other.id])).code).toBe(0);
      expect(await removeContainers("docker", { "heph.run": run1 })).toBe(0);
    } finally {
      await other.dispose();
    }
  }, 60_000);

  test("dispose removes the container", async () => {
    const { sb } = await container();
    await sb.dispose();
    expect((await run(["docker", "inspect", sb.id as string])).code).not.toBe(0);
  }, 60_000);
});
