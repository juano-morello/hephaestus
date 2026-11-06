import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Git } from "./git.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type LockOptions = {
  /** How often a waiter looks again. Default 100ms. */
  pollMs?: number;
  /** How long a waiter gives up after. Default 30 minutes (a re-gate can be slow). */
  timeoutMs?: number;
};

/** Holders in this process, per repo: the file lock alone can't tell two of our own runs apart. */
const queues = new Map<string, Promise<unknown>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireFile(file: string, o: Required<LockOptions>): Promise<() => void> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid: number;
    try {
      pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    } catch {
      continue; // released between the two calls
    }
    // In-process holders are serialized by the queue, so a live pid here is another process.
    if (!Number.isInteger(pid) || !alive(pid) || pid === process.pid) {
      try {
        // Only remove the lock we judged stale, not one taken since.
        if (Number.parseInt(readFileSync(file, "utf8"), 10) === pid) rmSync(file, { force: true });
      } catch {}
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(
        `landing is serialized per repo and process ${pid} still holds the lock (${file}); waited ${Math.round(o.timeoutMs / 1000)}s`,
      );
    await sleep(o.pollMs);
  }
}

/**
 * Runs `fn` holding the landing lock of every repo given: landing (rebase, re-gate, fast-forward)
 * on one repo is one at a time, across runs in this process and, through a pid lock file in the
 * repo's git dir, across daemons and nodes sharing it. A lock whose process is gone is taken over.
 */
export async function withRepoLocks<T>(
  gits: Git[],
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const o = { pollMs: options.pollMs ?? 100, timeoutMs: options.timeoutMs ?? 30 * 60_000 };
  // A fixed order, so two landings that share repos can never wait on each other.
  const dirs = [...new Set(await Promise.all(gits.map((g) => g.commonDir())))].sort();
  const held: (() => void)[] = [];
  const gates: (() => void)[] = [];
  try {
    for (const d of dirs) {
      const prev = queues.get(d) ?? Promise.resolve();
      let open!: () => void;
      const mine = new Promise<void>((r) => {
        open = r;
      });
      queues.set(
        d,
        prev.then(() => mine),
      );
      gates.push(open);
      await prev;
      held.push(await acquireFile(join(d, "heph-land.lock"), o));
    }
    return await fn();
  } finally {
    for (const release of held.reverse()) release();
    for (const g of gates) g();
  }
}
