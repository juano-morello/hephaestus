import type { ReactNode } from "react";

/*
 * The running pulse is a small CSS animation (.heph-pulse in theme.css) authored locally. No
 * uiverse.io snippet was ported, so there is no third-party license to carry here.
 */

type Tone = { cls: string; icon: ReactNode };

const svg = (d: ReactNode) => (
  <svg
    data-icon
    aria-hidden="true"
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);

const check = svg(<path d="M2.5 6.5l2.5 2.5 4.5-5.5" />);
const cross = svg(<path d="M3 3l6 6M9 3l-6 6" />);
const bang = svg(<path d="M6 2.5v4.5M6 9.2v.1" />);
const pause = svg(<path d="M4 3v6M8 3v6" />);
const dot = svg(<circle cx="6" cy="6" r="2.2" />);
const spin = svg(<circle cx="6" cy="6" r="3.5" strokeDasharray="14 8" />);

const GREEN = "text-primary border-primary";
const AMBER = "text-fg border-line bg-surface-2";

const TONES: Record<string, Tone> = {
  running: { cls: "text-accent border-accent heph-pulse", icon: spin },
  staged: { cls: GREEN, icon: check },
  landed: { cls: GREEN, icon: check },
  finished: { cls: GREEN, icon: check },
  paused: { cls: AMBER, icon: pause },
  escalated: { cls: AMBER, icon: bang },
  failed: { cls: "text-danger border-danger", icon: cross },
};

const NEUTRAL: Tone = { cls: "text-muted border-line", icon: dot };

export function StatusBadge({ status }: { status: string }) {
  const tone = TONES[status] ?? NEUTRAL;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tone.cls}`}
    >
      {tone.icon}
      <span>{status}</span>
    </span>
  );
}
