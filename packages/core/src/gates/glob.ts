// Conservative glob intersection: answers "could one path match both globs?".
// It may report overlap where none exists, never the reverse, so parallel tasks it
// accepts are safe to run side by side.

const WILDCARD = /[*?[]/;

function expandBraces(glob: string): string[] {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  const head = glob.slice(0, match.index);
  const tail = glob.slice(match.index + match[0].length);
  return (match[1] ?? "").split(",").flatMap((alt) => expandBraces(head + alt + tail));
}

function segmentRegex(segment: string): RegExp {
  let source = "";
  for (const ch of segment) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function segmentsCompatible(a: string, b: string): boolean {
  const aWild = WILDCARD.test(a);
  const bWild = WILDCARD.test(b);
  if (!aWild && !bWild) return a === b;
  if (aWild && !bWild) return segmentRegex(a).test(b);
  if (!aWild && bWild) return segmentRegex(b).test(a);
  const prefix = (s: string) => s.slice(0, s.search(WILDCARD));
  const suffix = (s: string) => s.slice(Math.max(s.lastIndexOf("*"), s.lastIndexOf("?")) + 1);
  const [pa, pb, sa, sb] = [prefix(a), prefix(b), suffix(a), suffix(b)];
  return (pa.startsWith(pb) || pb.startsWith(pa)) && (sa.endsWith(sb) || sb.endsWith(sa));
}

function segmentsOverlap(a: string[], i: number, b: string[], j: number): boolean {
  if (i === a.length && j === b.length) return true;
  if (a[i] === "**") {
    return segmentsOverlap(a, i + 1, b, j) || (j < b.length && segmentsOverlap(a, i, b, j + 1));
  }
  if (b[j] === "**") {
    return segmentsOverlap(a, i, b, j + 1) || (i < a.length && segmentsOverlap(a, i + 1, b, j));
  }
  if (i === a.length || j === b.length) return false;
  return segmentsCompatible(a[i] as string, b[j] as string) && segmentsOverlap(a, i + 1, b, j + 1);
}

const split = (glob: string) => glob.replace(/^\.\//, "").split("/").filter(Boolean);

export function globsOverlap(a: string, b: string): boolean {
  return expandBraces(a).some((x) =>
    expandBraces(b).some((y) => segmentsOverlap(split(x), 0, split(y), 0)),
  );
}
