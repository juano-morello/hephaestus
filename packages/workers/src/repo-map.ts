import type { GateResult } from "@hephaestus/core";

export type RepoMapOptions = {
  /** The Brief as text: directories it mentions are listed in full. */
  brief?: string;
  /** Paths from the last failure: the directories holding them are listed in full too. */
  focus?: string[];
  /** Budget per project (default 200 lines). */
  maxLines?: number;
};

type State = "collapsed" | "split" | "full" | { cut: number };

type Node = {
  /** Directory path with a trailing slash; "" for the project root. */
  path: string;
  files: string[];
  dirs: Map<string, Node>;
  total: number;
};

function buildTree(list: string[]): Node {
  const root: Node = { path: "", files: [], dirs: new Map(), total: list.length };
  for (const file of [...list].sort()) {
    const parts = file.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = `${parts.slice(0, i + 1).join("/")}/`;
      let child = node.dirs.get(path);
      if (!child) {
        child = { path, files: [], dirs: new Map(), total: 0 };
        node.dirs.set(path, child);
      }
      child.total++;
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

const allFiles = (node: Node): string[] => [
  ...node.files,
  ...[...node.dirs.values()].flatMap(allFiles),
];

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const child of node.dirs.values()) yield* walk(child);
}

const PARTIAL =
  "(listing is partial: dir/ (N files) entries are collapsed and (N more files) marks a cut list)";

function renderProject(list: string[], opts: RepoMapOptions, maxLines: number): string[] {
  const root = buildTree(list);
  const state = new Map<Node, State>();
  const get = (n: Node): State => state.get(n) ?? (n === root ? "split" : "collapsed");

  const render = (n: Node): string[] => {
    const s = get(n);
    if (s === "collapsed") return [`${n.path} (${n.total} files)`];
    if (s === "full") return allFiles(n);
    if (typeof s === "object") {
      const files = allFiles(n);
      return [...files.slice(0, s.cut), `(${files.length - s.cut} more files)`];
    }
    const own =
      n === root && n.files.length > maxLines
        ? [...n.files.slice(0, maxLines), `(${n.files.length - maxLines} more files)`]
        : n.files;
    return [...own, ...[...n.dirs.values()].flatMap(render)];
  };

  // Which directories to list in full: failure paths first, then what the Brief mentions.
  const brief = (opts.brief ?? "").toLowerCase();
  const focus = opts.focus ?? [];
  const baseCount = new Map<string, number>();
  for (const f of list) {
    const b = f.slice(f.lastIndexOf("/") + 1);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }
  // A term counts when the Brief has it as a whole word: "app" is not in "happen".
  const word = /[a-z0-9_]/;
  const hasWord = (term: string) => {
    for (let i = brief.indexOf(term); i >= 0; i = brief.indexOf(term, i + 1)) {
      if (!word.test(brief[i - 1] ?? " ") && !word.test(brief[i + term.length] ?? " ")) return true;
    }
    return false;
  };
  const mentioned = (n: Node) => {
    const bare = n.path.slice(0, -1).toLowerCase();
    const seg = bare.slice(bare.lastIndexOf("/") + 1);
    return (
      hasWord(bare) ||
      (seg.length >= 3 && hasWord(seg)) ||
      n.files.some((f) => {
        const raw = f.slice(f.lastIndexOf("/") + 1);
        return raw.length >= 3 && baseCount.get(raw) === 1 && hasWord(raw.toLowerCase());
      })
    );
  };
  // A failure path names the directory that holds it, not every ancestor.
  const failed = (n: Node) => focus.some((p) => p.slice(0, p.lastIndexOf("/") + 1) === n.path);
  const dirs = [...walk(root)].filter((n) => n !== root);
  const parentOf = new Map<Node, Node>();
  for (const p of walk(root)) for (const c of p.dirs.values()) parentOf.set(c, p);
  const candidates = [...dirs.filter(failed), ...dirs.filter((n) => !failed(n) && mentioned(n))];
  // The most specific directory wins: a parent that only matched through its child is dropped.
  const wanted = candidates
    .filter((w) => !candidates.some((o) => o !== w && o.path.startsWith(w.path)))
    .slice(0, 50);

  const within = (n: Node, anc: Node) => n.path.startsWith(anc.path);
  const ancestors = (n: Node) => dirs.filter((a) => a !== n && within(n, a));
  const expanded: Node[] = [];
  for (const w of wanted) {
    if (expanded.some((e) => within(w, e))) continue;
    const before = new Map(state);
    for (const a of ancestors(w)) if (get(a) === "collapsed") state.set(a, "split");
    state.set(w, "full");
    if (render(root).length <= maxLines) {
      expanded.push(w);
      continue;
    }
    state.set(w, "collapsed");
    const k = maxLines - render(root).length;
    if (k >= 1) {
      state.set(w, { cut: k });
      expanded.push(w);
    } else {
      state.clear();
      for (const [n, s] of before) state.set(n, s);
    }
  }

  // Spend what is left opening collapsed directories one level at a time, shallowest first.
  // Opening a directory replaces its one line with its files and one line per subdirectory.
  let count = render(root).length;
  const byDepth = [...dirs].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const n of byDepth) {
    const parent = parentOf.get(n) ?? root;
    if (get(n) !== "collapsed" || get(parent) === "collapsed") continue;
    const added = n.files.length + n.dirs.size - 1;
    if (count + added > maxLines) continue;
    state.set(n, "split");
    count += added;
  }

  const lines = render(root);
  const partial = lines.some((l) => /^\(\d+ more files\)$/.test(l) || / \(\d+ files\)$/.test(l));
  return partial ? [...lines, PARTIAL] : lines;
}

/**
 * The planner's view of each project's tracked files. A small project is listed whole; a large
 * one becomes a tree within `maxLines`: directories the Brief mentions (or the last failure
 * named) in full, the rest as `dir/ (N files)`, then leftover budget opens more levels.
 */
export function repoMapFromFiles(
  files: Record<string, string[]>,
  opts: RepoMapOptions = {},
): string {
  const maxLines = opts.maxLines ?? 200;
  return Object.entries(files)
    .map(([project, list]) => {
      if (!list.length) return `## ${project}\n(no tracked files)`;
      if (list.length <= maxLines) return [`## ${project}`, ...list].join("\n");
      return [`## ${project}`, ...renderProject(list, opts, maxLines)].join("\n");
    })
    .join("\n\n");
}

/** Path-looking tokens (they contain a `/`) from gate evidence: where the planner went wrong. */
export function pathsInEvidence(feedback: GateResult[]): string[] {
  return feedback.flatMap((g) =>
    g.evidence.flatMap((e) =>
      e
        .split(/\s+/)
        .map((t) => t.replace(/[:,)(]+$/, "").replace(/^[(]+/, ""))
        .filter((t) => t.includes("/")),
    ),
  );
}

/** The string values of a structure, newline-joined; keys are left out. */
export function textOf(value: unknown): string {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return out.join("\n");
}
