import type { Api } from "../api.ts";
import type { Overview } from "../types.ts";
import { usePoll } from "../use-poll.ts";
import { StatusBadge } from "./status-badge.tsx";
import { num } from "./view.tsx";

/** A reply that is not the Overview shape (or a stub's reply to another method) shows nothing. */
const valid = (d: Overview | undefined): d is Overview =>
  !!d &&
  Array.isArray(d.runs) &&
  Array.isArray(d.tokens) &&
  d.runs.every((r) => typeof r?.status === "string" && typeof r.count === "number") &&
  d.tokens.every((t) => typeof t?.model === "string");

/** Runs by status, tokens by model, escalations and stalls across every run; hidden if it fails. */
export function OverviewStrip({ api }: { api: Api }) {
  const { data } = usePoll<Overview>(() => api.call<Overview>("overview"), {
    fastMs: 10000,
    slowMs: 10000,
    fast: () => false,
  });
  if (!valid(data)) return null;
  if (data.runs.length === 0 && data.tokens.length === 0) return null;
  return (
    <section
      aria-label="Overview"
      className="mb-4 flex flex-wrap items-start gap-x-8 gap-y-2 rounded border border-line bg-surface p-3 text-sm"
    >
      <ul aria-label="Runs by status" className="flex flex-wrap items-center gap-2">
        {data.runs.map((r) => (
          <li key={r.status} className="flex items-center gap-1">
            <StatusBadge status={r.status} />
            <span className="font-medium">{r.count}</span>
          </li>
        ))}
      </ul>
      <ul aria-label="Tokens by model">
        {data.tokens.map((t) => (
          <li key={t.model}>
            <span className="font-mono">{t.model}</span>{" "}
            <span className="text-muted">
              input {num(t.input)} · output {num(t.output)}
            </span>
          </li>
        ))}
      </ul>
      <p>
        Escalations <strong>{data.escalations}</strong>
        <span className="mx-2 text-muted">·</span>
        Stalls <strong>{data.stalls}</strong>
      </p>
    </section>
  );
}
