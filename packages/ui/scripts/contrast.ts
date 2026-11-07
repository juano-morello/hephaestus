/** WCAG AA check of the theme's text pairs; reads the three theme blocks out of theme.css. */

type Vars = Record<string, string>;

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
};

export const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const block = (css: string, selector: string): Vars => {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`theme.css: no block for ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const vars: Vars = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6});/g))
    vars[m[1] as string] = m[2] as string;
  return vars;
};

/** Pairs that carry text: [foreground, background]. */
const PAIRS: [string, string][] = [
  ["--text", "--bg"],
  ["--text", "--surface"],
  ["--text", "--surface-2"],
  ["--muted", "--bg"],
  ["--muted", "--surface"],
  ["--accent", "--bg"],
  ["--accent", "--surface"],
  ["--danger", "--bg"],
  ["--danger", "--surface"],
  ["--accent", "--surface-2"],
  ["--on-primary", "--primary"],
  ["--primary", "--bg"],
  ["--primary", "--surface"],
  ["--danger", "--surface-2"],
];

/** Pairs that carry meaning without text (WCAG 1.4.11, 3:1): [foreground, background]. */
const NON_TEXT_PAIRS: [string, string][] = [["--border-strong", "--bg"]];

export function checkContrast(css: string, textMin = 4.5): string[] {
  const themes: [string, Vars][] = [
    ["light", block(css, ":root")],
    ["dark (media)", block(css, '  :root:not([data-theme="light"])')],
    ["dark (attribute)", block(css, ':root[data-theme="dark"]')],
  ];
  const problems: string[] = [];
  for (const [name, vars] of themes) {
    for (const [fg, bg, min] of [
      ...PAIRS.map(([f, b]) => [f, b, textMin] as const),
      ...NON_TEXT_PAIRS.map(([f, b]) => [f, b, 3] as const),
    ]) {
      const f = vars[fg];
      const b = vars[bg];
      if (!f || !b) {
        problems.push(`${name}: ${fg} or ${bg} is not defined`);
        continue;
      }
      const r = ratio(f, b);
      if (r < min)
        problems.push(`${name}: ${fg} ${f} on ${bg} ${b} is ${r.toFixed(2)}:1 (< ${min})`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const css = await Bun.file(new URL("../src/theme.css", import.meta.url)).text();
  const problems = checkContrast(css);
  if (problems.length) {
    console.error(`contrast check failed:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("contrast check passed");
}
