// The real dashboard listener joined to the real UI client: the reply shapes the server writes
// must be the ones the client reads (a fake on either side once hid a {ok,data} vs result gap).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "../src/ui-server.ts";

// The UI is type-checked as its own (DOM) project; load the real client at run time, by path, so
// the cli project does not compile it.
type ApiErrorLike = Error & { kind: "unauthorized" | "unreachable" | "daemon" };
type UiApi = {
  createApi(o: { base?: string; token: () => string | undefined; fetch?: typeof fetch }): {
    call<T>(method: string, ...args: unknown[]): Promise<T>;
  };
  ApiError: new (...a: never[]) => ApiErrorLike;
};
const uiApi = join(import.meta.dir, "..", "..", "ui", "src", "api.ts");
const { createApi, ApiError } = (await import(uiApi)) as UiApi;

let home: string;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "heph-wire-"));
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  rmSync(home, { recursive: true, force: true });
});

async function start() {
  const ui = await startUiServer({
    home,
    port: 0,
    assets: { "/": { body: "<html></html>", type: "text/html; charset=utf-8" } },
    call: async (method, args) => {
      if (args[0] === "boom") throw new Error("boom failed");
      return { method, args, nested: { n: 1 } };
    },
  });
  if (!ui) throw new Error("no listener");
  stops.push(ui.stop);
  return ui;
}

const clientFor = (ui: { port: number }, token: string | undefined) =>
  createApi({ base: `http://127.0.0.1:${ui.port}`, token: () => token, fetch });

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiErrorLike;
  }
  throw new Error("expected the call to fail");
};

describe("ui server and ui client", () => {
  test("success: the call result comes back as data", async () => {
    const ui = await start();
    const api = clientFor(ui, ui.token);
    expect(await api.call("status")).toEqual({ method: "status", args: [], nested: { n: 1 } });
    expect(await api.call("dashboard", "R1")).toEqual({
      method: "dashboard",
      args: ["R1"],
      nested: { n: 1 },
    });
  });

  test("a throw in call is a daemon ApiError with the exact message", async () => {
    const ui = await start();
    const e = await failure(clientFor(ui, ui.token).call("dashboard", "boom"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("daemon");
    expect(e.message).toBe("boom failed");
  });

  test("a wrong or missing token is unauthorized", async () => {
    const ui = await start();
    for (const t of ["wrong", undefined]) {
      const e = await failure(clientFor(ui, t).call("status"));
      expect(e.kind).toBe("unauthorized");
    }
  });

  test("a non-allowlisted method gets the plain-text 404, which the client survives", async () => {
    const ui = await start();
    const raw = await fetch(`http://127.0.0.1:${ui.port}/api/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${ui.token}` },
      body: JSON.stringify({ args: ["R1"] }),
    });
    expect(raw.status).toBe(404);
    expect(await raw.text()).toBe("not found");
    const e = await failure(clientFor(ui, ui.token).call("approve", "R1"));
    expect(e.kind).toBe("daemon");
    expect(e.message).toBe("unexpected response (404)");
  });

  test("a malformed body gets a plain-text 400 (not reachable through the client's own calls)", async () => {
    const ui = await start();
    const raw = await fetch(`http://127.0.0.1:${ui.port}/api/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${ui.token}` },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect(await raw.text()).toBe("bad request");
    expect(
      (
        await fetch(`http://127.0.0.1:${ui.port}/api/status`, {
          method: "POST",
          headers: { authorization: `Bearer ${ui.token}` },
          body: JSON.stringify({ args: "x" }),
        })
      ).status,
    ).toBe(400);
  });

  test("a stopped server is unreachable", async () => {
    const ui = await start();
    const api = clientFor(ui, ui.token);
    await ui.stop();
    const e = await failure(api.call("status"));
    expect(e.kind).toBe("unreachable");
  });
});
