import type { Api } from "../api.ts";
import type { RunCharts } from "../types.ts";
import { num, View } from "./view.tsx";

const MARKS: Record<string, { glyph: string; word: string; cls: string }> = {
  green: { glyph: "✓", word: "green", cls: "text-primary" },
  red: { glyph: "✗", word: "red", cls: "text-danger" },
  blocked: { glyph: "⊘", word: "blocked", cls: "text-fg" },
  error: { glyph: "!", word: "error", cls: "text-danger" },
};
const NONE = { glyph: "·", word: "none yet", cls: "text-muted" };
const markOf = (outcome: string | undefined) =>
  outcome !== undefined && Object.hasOwn(MARKS, outcome)
    ? (MARKS[outcome] as (typeof MARKS)[string])
    : outcome
      ? { glyph: "?", word: outcome, cls: "text-muted" }
      : NONE;

function Bars({ tokens }: { tokens: RunCharts["tokens"] }) {
  const byModel = new Map<string, { input: number; output: number }>();
  for (const t of tokens) {
    const m = byModel.get(t.model) ?? { input: 0, output: 0 };
    m.input += t.input;
    m.output += t.output;
    byModel.set(t.model, m);
  }
  const rows = [...byModel];
  const max = Math.max(1, ...rows.map(([, m]) => m.input + m.output));
  return (
    <ul aria-label="Tokens by model" className="flex flex-col gap-2">
      {rows.map(([model, m]) => (
        <li key={model}>
          <p className="text-sm">
            <span className="font-mono">{model}</span>{" "}
            <span className="text-muted">
              input {num(m.input)} · output {num(m.output)}
            </span>
          </p>
          <div aria-hidden="true" className="flex h-3 rounded bg-surface-2">
            <div className="rounded-l bg-primary" style={{ width: `${(m.input / max) * 100}%` }} />
            <div className="bg-accent" style={{ width: `${(m.output / max) * 100}%` }} />
          </div>
        </li>
      ))}
      <li className="text-xs text-muted">
        <span aria-hidden="true">■ </span>input <span aria-hidden="true">■ </span>output (bar length
        is input plus output)
      </li>
    </ul>
  );
}

function Body({ d }: { d: RunCharts }) {
  const attempts = d.units.flatMap((u) => u.attempts.map((a) => ({ unit: u.unit_id, ...a })));
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="font-semibold">Attempts per unit</h3>
        {d.units.length === 0 ? (
          <p className="text-muted">No attempts yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {d.units.map((u) => (
              <li key={u.unit_id} className="flex flex-wrap items-baseline gap-x-3 text-sm">
                <span className="w-24 shrink-0 break-all font-mono">{u.unit_id}</span>
                <ul aria-label={`Attempts of ${u.unit_id}`} className="flex flex-wrap gap-x-3">
                  {u.attempts.map((a) => {
                    const k = markOf(a.outcome);
                    return (
                      <li key={a.attempt} className={k.cls}>
                        a{a.attempt} <span aria-hidden="true">{k.glyph}</span> {k.word}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
        <table className="sr-only">
          <caption>Attempts data</caption>
          <thead>
            <tr>
              {["unit", "attempt", "outcome", "tier", "model", "role", "input", "output", "ms"].map(
                (h) => (
                  <th key={h}>{h}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={`${a.unit}#${a.attempt}`}>
                <td>{a.unit}</td>
                <td>{a.attempt}</td>
                <td>{a.outcome ?? "none yet"}</td>
                <td>{a.tier ?? ""}</td>
                <td>{a.model ?? ""}</td>
                <td>{a.role ?? ""}</td>
                <td>{a.input}</td>
                <td>{a.output}</td>
                <td>{a.duration_ms ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h3 className="mb-1 font-semibold">Tokens</h3>
        {d.tokens.length === 0 ? (
          <p className="text-muted">No tokens used yet.</p>
        ) : (
          <Bars tokens={d.tokens} />
        )}
        <table className="sr-only">
          <caption>Tokens data</caption>
          <thead>
            <tr>
              {["model", "role", "input", "output", "cache read", "cache write"].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.tokens.map((t) => (
              <tr key={`${t.model}/${t.role}`}>
                <td>{t.model}</td>
                <td>{t.role}</td>
                <td>{t.input}</td>
                <td>{t.output}</td>
                <td>{t.cache_read}</td>
                <td>{t.cache_write}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="text-sm">
        Escalations <strong>{d.escalations}</strong>
        <span className="mx-2 text-muted">·</span>
        Stalls <strong>{d.stalls}</strong>
      </p>
    </div>
  );
}

export function Charts({ id, api, live }: { id: string; api: Api; live?: boolean }) {
  return (
    <View<RunCharts> api={api} method="runCharts" id={id} live={live ?? false}>
      {(d) => <Body d={d} />}
    </View>
  );
}
