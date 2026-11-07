import * as Collapsible from "@radix-ui/react-collapsible";
import { useState } from "react";
import type { Api } from "../api.ts";
import type { PlanDetail } from "../types.ts";
import { View } from "./view.tsx";

type Task = PlanDetail["tasks"][number];
type Criterion = PlanDetail["criteria"][number];

function Labeled({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted">none</p>
      ) : (
        <ul className="text-sm">
          {items.map((x) => (
            <li key={x} className="break-all font-mono">
              {x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskCard({ t }: { t: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      aria-label={`${t.id} ${t.title}`}
      className="rounded border border-line bg-surface p-3"
    >
      <h3 className="font-semibold">
        <span className="font-mono">{t.id}</span> <span>{t.title}</span>
      </h3>
      <p className="mt-1 text-sm text-muted">
        {t.kind} · {t.project} · {t.lane} · {t.complexity} ({t.complexity_reason})
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Labeled label="Scope" items={t.scope} />
        <Labeled label="Creates" items={t.creates} />
        <Labeled label="Covers" items={t.covers} />
        <Labeled label="Produces" items={t.produces} />
        <Labeled label="Consumes" items={t.consumes} />
      </div>
      <Collapsible.Root open={open} onOpenChange={setOpen} className="mt-2">
        <Collapsible.Trigger className="cursor-pointer text-sm text-accent underline">
          {open ? "Hide spec" : "Show spec"}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm">{t.spec}</p>
        </Collapsible.Content>
      </Collapsible.Root>
    </article>
  );
}

const checkedBy = (c: Criterion) =>
  c.check
    ? `gate ${c.check}`
    : c.projects?.length
      ? `test task in ${c.projects.join(", ")}`
      : "a test task";

function Body({ d }: { d: PlanDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        <span aria-hidden="true">{d.approved ? "✓ " : "○ "}</span>
        {d.approved ? "plan approved" : "plan not approved"}
      </p>
      {d.tasks.length === 0 ? (
        <p className="text-muted">No tasks in the plan.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {d.tasks.map((t) => (
            <TaskCard key={t.id} t={t} />
          ))}
        </div>
      )}
      {d.risks.length > 0 && (
        <section aria-label="Risks">
          <h3 className="font-semibold">Risks</h3>
          <ul className="list-disc pl-5 text-sm">
            {d.risks.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}
      {d.criteria.length > 0 && (
        <table aria-label="Criteria" className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-line text-muted">
              <th className="px-2 py-1 font-medium">Id</th>
              <th className="px-2 py-1 font-medium">Criterion</th>
              <th className="px-2 py-1 font-medium">Checked by</th>
              <th className="px-2 py-1 font-medium">Covered by</th>
            </tr>
          </thead>
          <tbody>
            {d.criteria.map((c) => (
              <tr key={c.id} className="border-b border-line align-top">
                <td className="px-2 py-1 font-mono">{c.id}</td>
                <td className="px-2 py-1">{c.text}</td>
                <td className="px-2 py-1">{checkedBy(c)}</td>
                <td className="px-2 py-1">
                  {c.covered_by.length ? (
                    <span className="font-mono">{c.covered_by.join(", ")}</span>
                  ) : (
                    <span className="text-danger">
                      <span aria-hidden="true">! </span>not covered
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function PlanReview({ id, api, live }: { id: string; api: Api; live?: boolean }) {
  return (
    <View<PlanDetail> api={api} method="planDetail" id={id} live={live ?? false}>
      {(d) => <Body d={d} />}
    </View>
  );
}
