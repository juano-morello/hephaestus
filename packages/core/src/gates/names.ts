const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const baseOf = (p: string) => p.slice(dirOf(p).length);

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

const stemOf = (b: string) => (b.lastIndexOf(".") > 0 ? b.slice(0, b.lastIndexOf(".")) : b);

/**
 * Existing files in the same directory as `target`: names sharing its stem first (cap.go and
 * cap_test.go), then by edit distance between base names, ties by path. The hint when a plan
 * names a file that does not exist.
 */
export function closestNames(target: string, existing: string[], limit = 3): string[] {
  const dir = dirOf(target);
  const base = baseOf(target);
  const stem = stemOf(base);
  return existing
    .filter((f) => dirOf(f) === dir)
    .map((f) => {
      const other = stemOf(baseOf(f));
      const shares = other.includes(stem) || stem.includes(other);
      return { f, tier: shares ? 0 : 1, d: editDistance(base, baseOf(f)) };
    })
    .sort((x, y) => x.tier - y.tier || x.d - y.d || (x.f < y.f ? -1 : x.f > y.f ? 1 : 0))
    .slice(0, limit)
    .map((x) => x.f);
}
