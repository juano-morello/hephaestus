import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One process drives a run at a time: `$HEPH_HOME/locks/<run>.lock` holds its pid. A lock
 * whose process is gone (it was killed) is taken over. Returns the release function.
 */
export function lockRun(home: string, runId: string): () => void {
  const dir = join(home, "locks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.lock`);
  for (;;) {
    try {
      writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
      if (Number.isInteger(pid) && pid !== process.pid && alive(pid))
        throw new Error(`run ${runId} is being driven by process ${pid}`);
      rmSync(file, { force: true });
    }
  }
  return () => rmSync(file, { force: true });
}
