import { beforeEach, describe, expect, test } from "bun:test";
import { ApiError, createApi, readToken } from "../src/api.ts";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fail = async (p: Promise<unknown>) =>
  (await p.then(
    () => undefined,
    (e) => e,
  )) as ApiError;

describe("api client", () => {
  test("sends the bearer token and posts to /api/<method>", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const api = createApi({
      base: "http://h",
      token: () => "tok",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return reply({ ok: true, data: { n: 1 } });
      }) as unknown as typeof fetch,
    });
    const out = await api.call<{ n: number }>("dashboard", "r-1");
    expect(out).toEqual({ n: 1 });
    if (!seen) throw new Error("fetch was not called");
    expect(seen.url).toBe("http://h/api/dashboard");
    expect(seen.init.method).toBe("POST");
    expect((seen.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(String(seen.init.body))).toEqual({ args: ["r-1"] });
  });

  test("maps 401 to unauthorized", async () => {
    const api = createApi({ token: () => "x", fetch: (async () => reply({}, 401)) as never });
    const e = await fail(api.call("status"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe("unauthorized");
  });

  test("maps a fetch rejection to unreachable", async () => {
    const api = createApi({
      token: () => undefined,
      fetch: (async () => {
        throw new TypeError("network down");
      }) as never,
    });
    const e = await fail(api.call("status"));
    expect(e.kind).toBe("unreachable");
  });

  test("maps ok:false to a daemon error with its message", async () => {
    const api = createApi({
      token: () => "x",
      fetch: (async () => reply({ ok: false, error: { message: "no such run" } })) as never,
    });
    const e = await fail(api.call("explain", "r-9"));
    expect(e.kind).toBe("daemon");
    expect(e.message).toBe("no such run");
  });
});

describe("readToken", () => {
  beforeEach(() => {
    sessionStorage.clear();
    location.hash = "";
  });

  test("moves the fragment token into sessionStorage and leaves the route", () => {
    location.hash = "#t=abc";
    expect(readToken()).toBe("abc");
    expect(sessionStorage.getItem("heph.token")).toBe("abc");
    expect(location.hash).toBe("");
    expect(readToken()).toBe("abc");
  });

  test("returns undefined without a token", () => {
    expect(readToken()).toBeUndefined();
  });
});
