import { MotionConfig, motion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { type Layout, NODE_H, NODE_W } from "../graph-layout.ts";

type Look = { glyph: string; stroke: string; fill: string; dash?: string; text: string };

/* Every status has a glyph and its word inside the node; color only reinforces them. */
const LOOKS: Record<string, Look> = {
  accepted: {
    glyph: "✓",
    stroke: "var(--primary)",
    fill: "var(--surface)",
    text: "var(--primary)",
  },
  running: { glyph: "◐", stroke: "var(--accent)", fill: "var(--surface)", text: "var(--accent)" },
  failed: { glyph: "✕", stroke: "var(--danger)", fill: "var(--surface)", text: "var(--danger)" },
  escalated: {
    glyph: "!",
    stroke: "var(--danger)",
    fill: "var(--surface-2)",
    text: "var(--danger)",
  },
  pending: {
    glyph: "○",
    stroke: "var(--border-strong)",
    fill: "var(--bg)",
    dash: "5 3",
    text: "var(--muted)",
  },
};
const FALLBACK: Look = { ...LOOKS.pending, glyph: "·" } as Look;
export const lookOf = (status: string): Look =>
  Object.hasOwn(LOOKS, status) ? (LOOKS[status] as Look) : FALLBACK;

const QUERY = "(prefers-reduced-motion: reduce)";

const mql = () => (typeof matchMedia === "function" ? matchMedia(QUERY) : undefined);

/** Live prefers-reduced-motion, read from matchMedia on each mount (motion's own hook caches it). */
function usePrefersReducedMotion(): boolean {
  const [reduce, set] = useState(() => mql()?.matches ?? false);
  useEffect(() => {
    const m = mql();
    if (!m) return;
    const on = () => set(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export type UnitGraphProps = {
  layout: Layout;
  statuses: Record<string, string>;
  selected: string | undefined;
  onSelect: (id: string) => void;
  titles?: Record<string, string>;
};

export function UnitGraph({ layout, statuses, selected, onSelect, titles = {} }: UnitGraphProps) {
  const marker = useId();
  const reduce = usePrefersReducedMotion();
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  return (
    <MotionConfig reducedMotion="user">
      {/* biome-ignore lint/a11y/useSemanticElements: an <svg> cannot be a <fieldset> */}
      <svg
        role="group"
        aria-label="Unit graph"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block"
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10z" fill="var(--muted)" />
          </marker>
        </defs>
        {layout.edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + NODE_W;
          const y1 = a.y + NODE_H / 2;
          const x2 = b.x;
          const y2 = b.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${e.from}>${e.to}`}
              data-edge={`${e.from}>${e.to}`}
              d={`M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2 - 2} ${y2}`}
              fill="none"
              stroke="var(--muted)"
              strokeWidth="1.5"
              markerEnd={`url(#${marker})`}
            />
          );
        })}
        {layout.nodes.map((n) => {
          const status = statuses[n.id] ?? "pending";
          const look = lookOf(status);
          const isSel = selected === n.id;
          const title = titles[n.id];
          const pulsing = status === "running" && !reduce;
          const pick = () => onSelect(n.id);
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG nodes cannot be <button>s
            <g
              key={n.id}
              role="button"
              tabIndex={0}
              aria-pressed={isSel}
              aria-label={`${n.id}${title ? `, ${title}` : ""}: ${status}`}
              data-node={n.id}
              data-status={status}
              data-selected={isSel}
              className="cursor-pointer outline-none"
              transform={`translate(${n.x} ${n.y})`}
              onClick={pick}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick();
                }
              }}
            >
              <title>{title ? `${n.id}: ${title}` : n.id}</title>
              {/* keyboard focus: dashed, wider offset; selection: solid and tight */}
              <rect
                data-ring="focus"
                x={-8}
                y={-8}
                width={NODE_W + 16}
                height={NODE_H + 16}
                rx={14}
                fill="none"
                stroke="var(--text)"
                strokeWidth={2}
                strokeDasharray="6 4"
                opacity={0}
              />
              <rect
                data-ring="selected"
                x={-4}
                y={-4}
                width={NODE_W + 8}
                height={NODE_H + 8}
                rx={12}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={3}
                opacity={isSel ? 1 : 0}
              />
              <motion.rect
                data-pulse={pulsing ? "on" : "off"}
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={look.fill}
                stroke={look.stroke}
                strokeDasharray={look.dash}
                strokeWidth={2}
                animate={pulsing ? { strokeWidth: [2, 4, 2] } : { strokeWidth: 2 }}
                transition={{ duration: 1.6, repeat: pulsing ? Infinity : 0 }}
              />
              <text x={12} y={23} fontSize={13} fontWeight={600} fill="var(--text)">
                {clip(n.id, 20)}
              </text>
              <text x={12} y={42} fontSize={12} fill={look.text}>
                <tspan>{look.glyph} </tspan>
                {status}
              </text>
            </g>
          );
        })}
      </svg>
    </MotionConfig>
  );
}
