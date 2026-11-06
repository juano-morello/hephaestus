import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, run } from "../src/main.ts";
import { parseWaitFlag } from "../src/wait-flag.ts";

const BARE =
  "--wait takes a number of seconds of at least 1, or nothing to wait up to the attempt timeout";
const WORD = "--wait takes seconds, or nothing; put it after the run and node";

describe("parseWaitFlag", () => {
  test("no flag leaves argv alone", () => {
    expect(parseWaitFlag(["handoff", "R1", "denver"])).toEqual({
      argv: ["handoff", "R1", "denver"],
    });
  });

  test("a bare --wait at the end waits up to the attempt timeout", () => {
    expect(parseWaitFlag(["handoff", "R1", "denver", "--wait"])).toEqual({
      argv: ["handoff", "R1", "denver"],
      wait: "attempt",
    });
  });

  test("a bare --wait before another flag keeps that flag", () => {
    expect(parseWaitFlag(["handoff", "R1", "denver", "--wait", "--json"])).toEqual({
      argv: ["handoff", "R1", "denver", "--json"],
      wait: "attempt",
    });
  });

  test("--wait N takes N seconds and removes both tokens", () => {
    expect(parseWaitFlag(["handoff", "R1", "denver", "--wait", "300"])).toEqual({
      argv: ["handoff", "R1", "denver"],
      wait: 300,
    });
  });

  test("--wait=N works anywhere in argv", () => {
    expect(parseWaitFlag(["handoff", "--wait=45", "R1", "denver"])).toEqual({
      argv: ["handoff", "R1", "denver"],
      wait: 45,
    });
  });

  test("zero, an empty value and a non-number after = are usage errors", () => {
    for (const bad of [["--wait", "0"], ["--wait=0"], ["--wait="], ["--wait=abc"]]) {
      expect(() => parseWaitFlag(["handoff", "R1", "denver", ...bad])).toThrow(BARE);
    }
  });

  test("a word after --wait is a usage error that says where the flag goes", () => {
    expect(() => parseWaitFlag(["handoff", "--wait", "R1", "denver"])).toThrow(WORD);
    expect(() => parseWaitFlag(["handoff", "R1", "denver", "--wait", "abc"])).toThrow(WORD);
  });
});

describe("heph handoff --wait through the CLI", () => {
  test("a bad value fails with the usage error and touches nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "heph-wait-"));
    try {
      let out = "";
      const io: Io = {
        cwd: home,
        env: { HEPH_HOME: home },
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      };
      const code = await run(["handoff", "R1", "denver", "--wait", "abc", "--json"], io);
      expect(code).not.toBe(0);
      expect(JSON.parse(out)).toMatchObject({ ok: false, error: { message: WORD } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
