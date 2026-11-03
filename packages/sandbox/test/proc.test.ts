import { describe, expect, test } from "bun:test";
import { run, runOk } from "../src/proc.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

describe("proc", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const r = await run(["sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  test("runs in the given directory", async () => {
    const d = dir();
    const r = await run(["pwd", "-P"], { cwd: d });
    expect(r.stdout.trim().endsWith(d.split("/").at(-1) as string)).toBe(true);
  });

  test("runOk returns stdout and throws with stderr on failure", async () => {
    expect(await runOk(["sh", "-c", "printf ok"])).toBe("ok");
    await expect(runOk(["sh", "-c", "echo boom >&2; exit 1"])).rejects.toThrow(
      "sh -c echo boom >&2; exit 1 exited 1: boom",
    );
  });

  test("kills a command that runs past its timeout", async () => {
    const started = Date.now();
    const r = await run(["sh", "-c", "sleep 5; true"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("stops when the signal aborts", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const r = await run(["sh", "-c", "sleep 5; true"], { signal: ctrl.signal });
    expect(r.code).not.toBe(0);
  });

  test("passes stdin and can replace the environment", async () => {
    expect((await run(["cat"], { stdin: "piped" })).stdout).toBe("piped");
    process.env.HEPH_TEST_SECRET = "s3cret";
    const inherited = await run(["sh", "-c", 'printf "%s|" "$HEPH_TEST_SECRET"']);
    const clean = await run(["sh", "-c", 'printf "%s|" "$HEPH_TEST_SECRET"'], {
      env: { PATH: process.env.PATH ?? "" },
      inheritEnv: false,
    });
    delete process.env.HEPH_TEST_SECRET;
    expect(inherited.stdout).toBe("s3cret|");
    expect(clean.stdout).toBe("|");
  });
});
