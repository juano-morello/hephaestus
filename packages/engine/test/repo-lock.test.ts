import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGit } from "../src/git.ts";
import { withRepoLocks } from "../src/repo-lock.ts";
import { initRepo, tempDir } from "./helpers.ts";

const dir = tempDir();

async function repo() {
  const d = join(dir(), "r");
  mkdirSync(d);
  await initRepo(d, { "a.txt": "a\n" });
  return createGit(d);
}

describe("withRepoLocks", () => {
  test("runs holders of the same repo one at a time", async () => {
    const git = await repo();
    const order: string[] = [];
    const hold = (name: string) =>
      withRepoLocks([git], async () => {
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`${name}:out`);
      });
    await Promise.all([hold("a"), hold("b"), hold("c")]);
    // Never interleaved, whichever got in first.
    expect(order).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) {
      expect(order[i]?.endsWith(":in")).toBe(true);
      expect(order[i + 1]).toBe(`${order[i]?.[0]}:out`);
    }
  });

  test("holds a pid lock file in the repo's git dir, and releases it, even on a throw", async () => {
    const git = await repo();
    const file = join(await git.commonDir(), "heph-land.lock");
    await withRepoLocks([git], async () => {
      expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
    });
    expect(existsSync(file)).toBe(false);
    await expect(
      withRepoLocks([git], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(file)).toBe(false);
  });

  test("waits for a lock another live process holds", async () => {
    const git = await repo();
    const file = join(await git.commonDir(), "heph-land.lock");
    // pid 1 is alive and never us: stands in for another daemon.
    writeFileSync(file, "1\n");
    setTimeout(() => writeFileSync(file, "999999999\n"), 80);
    const t = Date.now();
    await withRepoLocks([git], async () => {}, { pollMs: 10 });
    expect(Date.now() - t).toBeGreaterThanOrEqual(60);
  });

  test("times out with the holder named", async () => {
    const git = await repo();
    writeFileSync(join(await git.commonDir(), "heph-land.lock"), "1\n");
    await expect(
      withRepoLocks([git], async () => {}, { pollMs: 5, timeoutMs: 30 }),
    ).rejects.toThrow(/process 1/);
  });

  test("takes over a lock whose process is gone", async () => {
    const git = await repo();
    writeFileSync(join(await git.commonDir(), "heph-land.lock"), "999999999\n");
    let ran = false;
    await withRepoLocks([git], async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
