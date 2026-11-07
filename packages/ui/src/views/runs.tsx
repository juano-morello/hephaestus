import * as ScrollArea from "@radix-ui/react-scroll-area";
import { type Api, ApiError } from "../api.ts";
import { ErrorBanner, runHref } from "../app.tsx";
import { HighlightRow } from "../components/animate-ui/highlight-row.tsx";
import { OverviewStrip } from "../components/overview-strip.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { usePoll } from "../use-poll.ts";

export type RunRow = {
  run_id: string;
  status: string;
  owner_node?: string;
  stack_on?: string | null;
  updated_at?: string;
};
export type StatusList = { runs: RunRow[] };

const byRecent = (a: RunRow, b: RunRow) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "");

const when = (iso: string | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function Runs({ api }: { api: Api }) {
  const { data, error, loading } = usePoll<StatusList>(() => api.call<StatusList>("status"), {
    fastMs: 2000,
    slowMs: 10000,
    fast: (d) => !!d?.runs.some((r) => r.status === "running"),
  });
  const runs = data ? [...data.runs].sort(byRecent) : undefined;
  const failure =
    error && (error instanceof ApiError ? error : new ApiError("daemon", String(error)));

  return (
    <div>
      <ErrorBanner error={failure} />
      {failure?.kind === "daemon" && (
        <p role="alert" className="mb-2 text-danger">
          {failure.message}
        </p>
      )}
      {runs && <OverviewStrip api={api} />}
      {loading && !runs && !failure && <p className="text-muted">Loading…</p>}
      {runs && runs.length === 0 && <p className="text-muted">No runs yet.</p>}
      {runs && runs.length > 0 && (
        <ScrollArea.Root className="w-full overflow-hidden">
          <ScrollArea.Viewport className="w-full">
            <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Stacked on</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <HighlightRow key={r.run_id}>
                    <td className="px-3 py-2">
                      <a className="text-accent underline" href={runHref(r.run_id)}>
                        {r.run_id}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-3 py-2 text-muted">{r.owner_node}</td>
                    <td className="px-3 py-2">
                      {r.stack_on ?? <span className="text-muted">-</span>}
                    </td>
                    <td className="px-3 py-2 text-muted">{when(r.updated_at)}</td>
                  </HighlightRow>
                ))}
              </tbody>
            </table>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="horizontal" className="h-2 bg-surface-2">
            <ScrollArea.Thumb className="rounded bg-line" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      )}
    </div>
  );
}
