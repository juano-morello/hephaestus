import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { daemonLine, explainError, mergeText, run } from "../src/main.ts";
import { describe as said } from "../src/runtime.ts";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ctx: {
      cwd: tmpdir(),
      env: { HEPH_HOME: tmpdir() },
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    },
  };
}

describe("usage", () => {
  for (const argv of [[], ["help"], ["--help"], ["-h"]])
    test(`heph ${argv.join(" ") || "(nothing)"} prints usage and exits 0`, async () => {
      const { out, ctx } = io();
      expect(await run(argv, ctx)).toBe(0);
      const text = out.join("");
      expect(text).toStartWith("usage: heph <command> [options]");
      expect(text).toContain("  new --brief <file>");
      expect(text).toContain("  approve merge <run>");
      expect(text).toContain("--stack-on <run>");
      expect(text).toContain("  doctor");
      expect(text).toContain("  stats [--since");
      expect(text).toContain("  eval --suite <dir>");
      expect(text).toContain("  eval compare <labelA> <labelB>");
      // Node plumbing stays out of the list.
      expect(text).not.toContain("  peer");
    });

  test("an unknown command points at heph help", async () => {
    const { err, ctx } = io();
    expect(await run(["frobnicate"], ctx)).toBe(1);
    expect(err.join("")).toBe('heph: unknown command "frobnicate" (heph help lists them)\n');
  });

  test("--version and version print the version and build", async () => {
    const { out, ctx } = io();
    expect(await run(["--version"], ctx)).toBe(0);
    expect(out.join("")).toMatch(/^heph \d+\.\d+\.\d+ \(.+\)\n$/);
    const json = io();
    expect(await run(["version", "--json"], json.ctx)).toBe(0);
    expect(JSON.parse(json.out.join("")).data).toMatchObject({
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      build: expect.any(String),
    });
  });
});

describe("merge output", () => {
  test("says what happened in words", () => {
    expect(mergeText({ run_id: "R1", result: { status: "merged" } })).toBe("R1: merged\n");
    expect(
      mergeText({
        run_id: "R1",
        result: { status: "not_ready", reasons: ["calc: checks still running: ci"] },
      }),
    ).toBe(
      "R1: not merged yet\n  calc: checks still running: ci\nnext: heph approve merge R1 again once that is fixed\n",
    );
    expect(mergeText({ run_id: "R1", result: { status: "open", open: ["calc"] } })).toBe(
      "R1: pull requests still open: calc\n",
    );
    expect(
      mergeText({
        run_id: "R1",
        result: { status: "half_landed", merged: ["proto"], reason: "server: blocked" },
      }),
    ).toBe("R1: HALF LANDED (merged: proto): server: blocked\n");
    expect(mergeText({ run_id: "R1", result: { status: "closed" } })).toBe(
      "R1: a pull request was closed without merging; the run is aborted\n",
    );
    expect(mergeText({ run_id: "R1", result: { status: "aborted", reason: "x" } })).toBe(
      "R1: aborted: x\n",
    );
  });
});

test("a refused write to heph's home says it is probably a sandbox, and what to do", () => {
  expect(explainError("attempt to write a readonly database")).toContain(
    "If it runs inside a sandbox (Claude Code's Bash sandbox, say), run it outside",
  );
  expect(explainError("run R1 is failed")).toBe("run R1 is failed");
});

test("daemon log lines carry the time", () => {
  expect(daemonLine("r-1 staged", new Date("2026-11-04T19:59:15.875Z"))).toBe(
    "2026-11-04T19:59:15.875Z heph daemon: r-1 staged\n",
  );
});

test("a pause for the user and a scope hint read as what they mean", () => {
  const e = (type: string, data: unknown) => ({ type, data }) as Parameters<typeof said>[0];
  expect(said(e("run.paused", { reason: "user" }))).toBe("run paused: waiting for you");
  expect(said(e("run.paused", { reason: "handoff" }))).toBe("run paused: handoff");
  expect(said(e("human.input", { kind: "scope", scope: ["NOTES.md"] }))).toBe(
    "scope: may also change NOTES.md",
  );
});
