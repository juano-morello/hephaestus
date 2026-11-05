import { useEffect, useMemo, useState } from "react";
import { type Api, type ApiError, createApi, readToken } from "./api.ts";
import { Runs } from "./views/runs.tsx";

export type Route = { page: "runs" } | { page: "run"; id: string };

export function parseRoute(hash: string): Route {
  const m = /^#\/run\/(.+)$/.exec(hash);
  if (m?.[1]) {
    try {
      return { page: "run", id: decodeURIComponent(m[1]) };
    } catch {}
  }
  return { page: "runs" };
}

export const runHref = (id: string) => `#/run/${encodeURIComponent(id)}`;

export function useRoute(): Route {
  const [route, set] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => set(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

/** The api client for the page, with the token taken from the URL fragment once. */
export function useApi(): Api {
  return useMemo(() => {
    readToken();
    return createApi({ token: () => readToken() });
  }, []);
}

export function ErrorBanner({ error }: { error: ApiError | undefined }) {
  if (!error || error.kind === "daemon") return null;
  const text =
    error.kind === "unreachable"
      ? "The daemon is not answering, retrying."
      : "This page has no valid token: run `heph ui` again.";
  return (
    <div role="alert" className="border-b border-danger bg-surface px-4 py-2 text-sm text-danger">
      <span aria-hidden="true">! </span>
      {text}
    </div>
  );
}

function RunPlaceholder({ id }: { id: string }) {
  return (
    <p className="text-muted">
      <a className="text-accent underline" href="#/">
        All runs
      </a>{" "}
      / {id}
    </p>
  );
}

export function App() {
  const route = useRoute();
  const api = useApi();
  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line bg-surface px-4 py-3 font-semibold">
        Hephaestus
      </header>
      <main className="p-4">
        {route.page === "runs" ? <Runs api={api} /> : <RunPlaceholder id={route.id} />}
      </main>
    </div>
  );
}
