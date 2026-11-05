import * as Collapsible from "@radix-ui/react-collapsible";
import * as Tabs from "@radix-ui/react-tabs";
import { useState } from "react";
import type { DashboardAttempt, DashboardGate } from "../types.ts";
import { StatusBadge } from "./status-badge.tsx";

export type PanelUnit = {
  id: string;
  status: string;
  in_plan: boolean;
  title?: string;
  kind?: string;
  project?: string;
};

function Gate({ gate }: { gate: DashboardGate }) {
  const [open, setOpen] = useState(false);
  const pass = gate.verdict === "pass";
  return (
    <li className="rounded border border-line bg-surface p-2" data-gate={gate.gate}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{gate.gate}</span>
        <span
          className={`inline-flex items-center gap-1 text-sm font-medium ${pass ? "text-primary" : "text-danger"}`}
        >
          <span aria-hidden="true">{pass ? "✓" : "✕"}</span>
          {pass ? "pass" : gate.verdict === "fail" ? "fail" : gate.verdict}
        </span>
      </div>
      {gate.reason && <p className="mt-1 text-sm text-muted">{gate.reason}</p>}
      {gate.evidence.length > 0 && (
        <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-1">
          <Collapsible.Trigger className="cursor-pointer text-sm text-accent underline">
            {open ? "Hide" : "Show"} evidence ({gate.evidence.length})
          </Collapsible.Trigger>
          <Collapsible.Content>
            <ul className="mt-1 list-disc pl-5 text-sm">
              {gate.evidence.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: evidence lines can repeat
                <li key={i} className="whitespace-pre-wrap break-words font-mono">
                  {e}
                </li>
              ))}
            </ul>
          </Collapsible.Content>
        </Collapsible.Root>
      )}
    </li>
  );
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function UnitPanel({ unit, attempts }: { unit: PanelUnit; attempts: DashboardAttempt[] }) {
  const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt);
  const latest = sorted[sorted.length - 1];
  return (
    <section aria-label={`Unit ${unit.id}`} className="rounded border border-line bg-surface p-3">
      <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
        {unit.id} <StatusBadge status={unit.status} />
      </h2>
      {!unit.in_plan && <p className="text-sm text-muted">not in current plan</p>}
      {unit.title && <p className="text-sm">{unit.title}</p>}
      {(unit.kind || unit.project) && (
        <p className="text-sm text-muted">
          {[unit.kind, unit.project].filter(Boolean).join(" · ")}
        </p>
      )}
      {sorted.length === 0 || !latest ? (
        <p className="mt-2 text-sm text-muted">No attempts yet.</p>
      ) : (
        <Tabs.Root defaultValue={String(latest.attempt)} className="mt-3">
          <Tabs.List aria-label="Attempts" className="flex flex-wrap gap-1 border-b border-line">
            {sorted.map((a) => (
              <Tabs.Trigger
                key={a.attempt}
                value={String(a.attempt)}
                className="cursor-pointer rounded-t px-3 py-1 text-sm data-[state=active]:bg-surface-2 data-[state=active]:font-semibold"
              >
                Attempt {a.attempt}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {sorted.map((a) => (
            <Tabs.Content key={a.attempt} value={String(a.attempt)} className="pt-3">
              <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge status={a.status} />
                {a.outcome && <span>{a.outcome}</span>}
                {a.model && (
                  <span className="text-muted">
                    {[a.provider, a.model].filter(Boolean).join("/")}
                  </span>
                )}
                {a.duration_ms !== undefined && (
                  <span className="text-muted">{secs(a.duration_ms)}</span>
                )}
              </p>
              {a.gates.length === 0 ? (
                <p className="text-sm text-muted">No gate results yet.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {a.gates.map((g, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a gate name can repeat
                    <Gate key={`${g.gate}-${i}`} gate={g} />
                  ))}
                </ul>
              )}
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </section>
  );
}
