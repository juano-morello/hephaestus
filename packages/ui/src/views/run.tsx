import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Tabs from "@radix-ui/react-tabs";
import { useEffect, useMemo, useState } from "react";
import { type Api, ApiError } from "../api.ts";
import { ErrorBanner, runHref } from "../app.tsx";
import { Changes } from "../components/changes.tsx";
import { Charts } from "../components/charts.tsx";
import { PlanReview } from "../components/plan-review.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { UnitGraph } from "../components/unit-graph.tsx";
import { type PanelUnit, UnitPanel } from "../components/unit-panel.tsx";
import { layoutGraph } from "../graph-layout.ts";
import type { Dashboard } from "../types.ts";
import { usePoll } from "../use-poll.ts";

const TABS = [
  ["graph", "Graph"],
  ["plan", "Plan"],
  ["changes", "Changes"],
  ["charts", "Charts"],
] as const;

const BACK = (
  <a className="text-accent underline" href="#/">
    All runs
  </a>
);

function Header({ d }: { d: Dashboard }) {
  const { run } = d;
  return (
    <header className="mb-4">
      <p className="text-sm text-muted">{BACK}</p>
      <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
        <span className="break-all">{run.run_id}</span>
        <StatusBadge status={run.status} />
        <span className="text-sm font-normal text-muted">
          <span aria-hidden="true">{d.plan_approved ? "✓ " : "○ "}</span>
          {d.plan_approved ? "plan approved" : "plan not approved"}
        </span>
      </h1>
      {d.stale && (
        <p role="status" className="mt-1 text-sm text-danger">
          <span aria-hidden="true">! </span>
          Stale: {d.stale}
        </p>
      )}
      {d.stack_on && (
        <p className="mt-1 text-sm">
          Stacked on{" "}
          <a className="text-accent underline" href={runHref(d.stack_on.run_id)}>
            {d.stack_on.run_id}
          </a>{" "}
          <StatusBadge status={d.stack_on.status} />
        </p>
      )}
      {d.pauses.length > 0 && (
        <ul aria-label="Pause reasons" className="mt-1 text-sm">
          {d.pauses.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: reasons can repeat
            <li key={i}>
              <span aria-hidden="true">⏸ </span>
              Paused: {p}
            </li>
          ))}
        </ul>
      )}
      {d.usage.length > 0 && (
        <ul aria-label="Usage" className="mt-1 text-sm text-muted">
          {d.usage.map((u) => (
            <li key={`${u.provider}/${u.model}`}>
              {u.provider}/{u.model}
              {Object.entries(u)
                .filter(([, v]) => typeof v === "number")
                .map(([k, v]) => ` · ${k.replaceAll("_", " ")} ${String(v)}`)
                .join("")}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

export function Run({ id, api }: { id: string; api: Api }) {
  const { data, error, loading } = usePoll<Dashboard>(() => api.call<Dashboard>("dashboard", id), {
    fastMs: 2000,
    slowMs: 10000,
    fast: (d) => d?.run.status === "running",
  });
  const [selected, setSelected] = useState<string | undefined>();
  // A selection whose unit left both the plan and the unit list (a newer poll) is dropped.
  useEffect(() => {
    if (!data || selected === undefined) return;
    const known =
      data.plan.units.some((u) => u.id === selected) ||
      data.units.some((u) => u.unit_id === selected && !u.in_plan);
    if (!known) setSelected(undefined);
  }, [data, selected]);
  const layout = useMemo(() => layoutGraph(data?.plan.units ?? []), [data]);

  const failure =
    error && (error instanceof ApiError ? error : new ApiError("daemon", String(error)));
  if (!data && failure?.kind === "daemon") {
    return (
      <div role="alert">
        <h1 className="text-xl font-semibold">Run not found</h1>
        <p className="text-muted">{failure.message}</p>
        <p>{BACK}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <ErrorBanner error={failure} />
        {loading && !failure && <p className="text-muted">Loading…</p>}
        <p>{BACK}</p>
      </div>
    );
  }

  const statuses = Object.fromEntries(data.units.map((u) => [u.unit_id, u.status]));
  const titles = Object.fromEntries(data.plan.units.map((u) => [u.id, u.title]));
  const dropped = data.units.filter((u) => !u.in_plan);
  const live = data.run.status === "running";
  const status = (id: string) =>
    Object.hasOwn(statuses, id) ? (statuses[id] as string) : "pending";
  const planned = data.plan.units.find((u) => u.id === selected);
  const droppedSel = dropped.find((u) => u.unit_id === selected);
  const panelUnit: PanelUnit | undefined = planned
    ? { ...planned, status: status(planned.id), in_plan: true }
    : droppedSel
      ? { id: droppedSel.unit_id, status: droppedSel.status, in_plan: false }
      : undefined;

  return (
    <div>
      <ErrorBanner error={failure} />
      <Header d={data} />
      <Tabs.Root defaultValue="graph">
        <Tabs.List aria-label="Run views" className="mb-4 flex gap-1 border-b border-line">
          {TABS.map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm data-[state=active]:border-accent data-[state=active]:font-semibold"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="graph">
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              {data.plan.units.length === 0 ? (
                <p className="text-muted">No plan yet.</p>
              ) : (
                <ScrollArea.Root className="w-full overflow-hidden rounded border border-line">
                  <ScrollArea.Viewport className="w-full">
                    <UnitGraph
                      layout={layout}
                      statuses={statuses}
                      titles={titles}
                      selected={selected}
                      onSelect={setSelected}
                    />
                  </ScrollArea.Viewport>
                  <ScrollArea.Scrollbar orientation="horizontal" className="h-2 bg-surface-2">
                    <ScrollArea.Thumb className="rounded bg-line" />
                  </ScrollArea.Scrollbar>
                </ScrollArea.Root>
              )}
              {dropped.length > 0 && (
                <div className="mt-3">
                  <h2 className="text-sm font-semibold">Not in current plan</h2>
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {dropped.map((u) => (
                      <li key={u.unit_id}>
                        <button
                          type="button"
                          aria-pressed={selected === u.unit_id}
                          onClick={() => setSelected(u.unit_id)}
                          className="cursor-pointer rounded border border-dashed border-line px-2 py-1 text-sm aria-pressed:border-accent aria-pressed:border-solid"
                        >
                          {u.unit_id} <span className="text-muted">({u.status})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <div className="min-w-0 lg:w-96">
              {panelUnit ? (
                <UnitPanel
                  key={panelUnit.id}
                  unit={panelUnit}
                  attempts={data.attempts.filter((a) => a.unit_id === panelUnit.id)}
                />
              ) : (
                <p className="text-sm text-muted">Select a unit to see its attempts.</p>
              )}
            </div>
          </div>
        </Tabs.Content>
        <Tabs.Content value="plan">
          <PlanReview id={id} api={api} live={live} />
        </Tabs.Content>
        <Tabs.Content value="changes">
          <Changes id={id} api={api} live={live} />
        </Tabs.Content>
        <Tabs.Content value="charts">
          <Charts id={id} api={api} live={live} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
