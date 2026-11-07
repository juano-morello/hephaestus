import type { ReactNode } from "react";
import { type Api, ApiError, type ApiMethod } from "../api.ts";
import { ErrorBanner } from "../app.tsx";
import { usePoll } from "../use-poll.ts";

/** Fetches one read method with the run page's polling rule and renders it, or why it could not. */
export function View<T extends { stale?: string }>({
  api,
  method,
  id,
  live = false,
  children,
}: {
  api: Api;
  method: ApiMethod;
  id: string;
  /** The run is running: poll fast, as the page does. */
  live?: boolean;
  children: (data: T) => ReactNode;
}) {
  const { data, error, loading } = usePoll<T>(() => api.call<T>(method, id), {
    fastMs: 2000,
    slowMs: 10000,
    fast: () => live,
  });
  const failure =
    error && (error instanceof ApiError ? error : new ApiError("daemon", String(error)));
  if (!data) {
    if (failure?.kind === "daemon")
      return (
        <p role="alert" className="text-danger">
          {failure.message}
        </p>
      );
    return (
      <div>
        <ErrorBanner error={failure} />
        {loading && !failure && <p className="text-muted">Loading…</p>}
      </div>
    );
  }
  return (
    <div>
      <ErrorBanner error={failure} />
      {data.stale && (
        <p role="status" className="mb-2 text-sm text-danger">
          <span aria-hidden="true">! </span>
          Stale: {data.stale}
        </p>
      )}
      {children(data)}
    </div>
  );
}

export const num = (n: number) => n.toLocaleString("en-US");

/** `+3 -1`: the words are the signs; color only adds to them. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono">
      <span className="text-primary">+{added}</span> <span className="text-danger">-{removed}</span>
    </span>
  );
}
