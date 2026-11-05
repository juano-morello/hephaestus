// The daemon client against a stand-in socket server: answered errors, timeouts, no timeout.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonError, DaemonTimeoutError, daemonAt, socketOf } from "../src/daemon.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** A socket server that answers /call with `answer` after `delayMs`. */
function serve(answer: unknown, delayMs = 0) {
  const home = mkdtempSync(join(tmpdir(), "heph-client-"));
  const server = Bun.serve({
    unix: socketOf(home),
    async fetch(req) {
      if (new URL(req.url).pathname === "/health") return Response.json({ node: "n" });
      await Bun.sleep(delayMs);
      return Response.json(answer);
    },
  });
  cleanups.push(() => {
    void server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

describe("daemon client", () => {
  test("an answered error is a DaemonError with the daemon's message", async () => {
    const home = serve({ ok: false, error: { message: "unknown run r9" } });
    const d = await daemonAt(home);
    const e = await d?.call("status", ["r9"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DaemonError);
    expect((e as Error).message).toBe("unknown run r9");
  });

  test("timeoutMs bounds the call with a DaemonTimeoutError", async () => {
    const home = serve({ ok: true, data: 1 }, 1000);
    const d = await daemonAt(home);
    const t0 = Date.now();
    const e = await d?.call("status", [], undefined, { timeoutMs: 50 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DaemonTimeoutError);
    expect(e).not.toBeInstanceOf(DaemonError);
    expect((e as Error).message).toContain("status");
    expect(Date.now() - t0).toBeLessThan(900);
  });

  test("without timeoutMs a slow answer still arrives", async () => {
    const home = serve({ ok: true, data: "late" }, 300);
    const d = await daemonAt(home);
    expect(await d?.call("newRun", [])).toBe("late");
  });
});
