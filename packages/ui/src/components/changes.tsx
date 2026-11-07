import type { Api } from "../api.ts";
import type { DiffSummary } from "../types.ts";
import { Counts, View } from "./view.tsx";

type Unit = DiffSummary["units"][number];

function UnitSection({ u }: { u: Unit }) {
  return (
    <section
      aria-label={`${u.unit_id} in ${u.project}`}
      className="rounded border border-line bg-surface p-3"
    >
      <h3 className="font-semibold">
        <span className="font-mono">{u.unit_id}</span>{" "}
        <span className="text-sm font-normal text-muted">
          {u.project}
          {u.attempt !== undefined && ` · attempt ${u.attempt}`}
        </span>
      </h3>
      {u.status === "unavailable" ? (
        <p className="mt-1 text-sm text-danger">
          <span aria-hidden="true">! </span>
          unavailable: the diff of this unit is not in the ledger
        </p>
      ) : (
        <>
          {u.partial && (
            <p className="mt-1 text-sm text-danger">
              <span aria-hidden="true">! </span>
              partial: the diff was too large or not all readable, so some files may be missing
            </p>
          )}
          {u.files.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No files changed.</p>
          ) : (
            <ul className="mt-1 text-sm">
              {u.files.map((f) => (
                <li key={f.path} className="flex flex-wrap items-baseline gap-x-3">
                  <span className="break-all font-mono">{f.path}</span>
                  <Counts added={f.added} removed={f.removed} />
                  {f.binary && <span className="text-muted">binary</span>}
                  {f.renamed_from && (
                    <span className="break-all text-muted">renamed from {f.renamed_from}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-sm">
            total <Counts added={u.added} removed={u.removed} />
          </p>
        </>
      )}
    </section>
  );
}

function Body({ d }: { d: DiffSummary }) {
  if (d.units.length === 0) return <p className="text-muted">No accepted units yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Projects" className="rounded border border-line bg-surface-2 p-3">
        <h3 className="font-semibold">Projects</h3>
        <ul className="text-sm">
          {d.projects.map((p) => (
            <li key={p.project} className="flex flex-wrap items-baseline gap-x-3">
              <span className="font-mono">{p.project}</span>
              <span>
                {p.files} {p.files === 1 ? "file" : "files"}
              </span>
              <Counts added={p.added} removed={p.removed} />
            </li>
          ))}
        </ul>
      </section>
      {d.units.map((u) => (
        <UnitSection key={u.unit_id} u={u} />
      ))}
    </div>
  );
}

export function Changes({ id, api, live }: { id: string; api: Api; live?: boolean }) {
  return (
    <View<DiffSummary> api={api} method="diffSummary" id={id} live={live ?? false}>
      {(d) => <Body d={d} />}
    </View>
  );
}
