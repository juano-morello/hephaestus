export type ApiMethod =
  | "status"
  | "explain"
  | "planShow"
  | "dashboard"
  | "planDetail"
  | "diffSummary"
  | "runCharts"
  | "overview";

export class ApiError extends Error {
  readonly kind: "unauthorized" | "unreachable" | "daemon";
  constructor(kind: ApiError["kind"], message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
  }
}

export type Api = {
  call<T>(method: ApiMethod, ...args: unknown[]): Promise<T>;
};

export function createApi(o: {
  base?: string;
  token: () => string | undefined;
  fetch?: typeof fetch;
}): Api {
  const base = o.base ?? "";
  return {
    async call<T>(method: ApiMethod, ...args: unknown[]): Promise<T> {
      const doFetch = o.fetch ?? fetch;
      const token = o.token();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = `Bearer ${token}`;
      let res: Response;
      try {
        res = await doFetch(`${base}/api/${method}`, {
          method: "POST",
          headers,
          body: JSON.stringify({ args }),
        });
      } catch (e) {
        throw new ApiError("unreachable", e instanceof Error ? e.message : String(e));
      }
      if (res.status === 401) throw new ApiError("unauthorized", "missing or wrong token");
      // the daemon wraps replies as { ok: true, data } or { ok: false, error: { message } }
      let body: { ok?: boolean; data?: unknown; error?: { message?: string } | string };
      try {
        body = await res.json();
      } catch {
        throw new ApiError("daemon", `unexpected response (${res.status})`);
      }
      if (!res.ok || body.ok === false) {
        const e = body.error;
        const msg = typeof e === "string" ? e : e?.message;
        throw new ApiError("daemon", msg ?? `request failed (${res.status})`);
      }
      return body.data as T;
    },
  };
}

const KEY = "heph.token";

/** Takes a leading `#t=<token>` from the URL once, keeps it in sessionStorage, drops it from the URL. */
export function readToken(): string | undefined {
  const m = /^#t=([^&]+)/.exec(location.hash);
  if (m?.[1]) {
    try {
      sessionStorage.setItem(KEY, decodeURIComponent(m[1]));
    } catch {}
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  try {
    return sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
