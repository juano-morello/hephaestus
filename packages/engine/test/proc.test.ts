import { describe, expect, test } from "bun:test";
import { run, runOk } from "../src/proc.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();

describe("proc", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const r = await run(["sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(r).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
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
});
