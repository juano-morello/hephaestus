// A file-level summary of a unified git diff: paths and line counts, never the diff text itself.
// The dashboard shows this; the text of a change stays in the ledger's blobs.

export const MAX_DIFF_BYTES = 5 * 1024 * 1024;

export type DiffFile = {
  path: string;
  added: number;
  removed: number;
  binary?: true;
  renamed_from?: string;
};

/** The `a/` and `b/` paths of a `diff --git` header line (what follows the keyword). */
function headerPaths(rest: string): { a: string; b: string } | undefined {
  const quoted = /^"a\/(.*)" "b\/(.*)"$/.exec(rest);
  if (quoted) return { a: quoted[1] as string, b: quoted[2] as string };
  if (!rest.startsWith("a/")) return undefined;
  // Same path on both sides (every case but a rename): a/X b/X, so the halves are equal.
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0 && rest.slice(2, 2 + len) === rest.slice(rest.length - len))
    return { a: rest.slice(2, 2 + len), b: rest.slice(rest.length - len) };
  const cut = rest.lastIndexOf(" b/");
  if (cut < 0) return undefined;
  return { a: rest.slice(2, cut), b: rest.slice(cut + 3) };
}

/** Per-file added/removed counts of a git diff; `partial` when the text was cut or not all readable. */
export function summarizeDiff(text: string): { files: DiffFile[]; partial: boolean } {
  let partial = false;
  if (Buffer.byteLength(text) > MAX_DIFF_BYTES) {
    text = Buffer.from(text).subarray(0, MAX_DIFF_BYTES).toString("utf8");
    partial = true;
  }
  const files: DiffFile[] = [];
  type Cur = { file: DiffFile; a: string; deleted: boolean; inHunk: boolean; binaryPatch: boolean };
  let cur: Cur | undefined;
  const flush = () => {
    if (!cur) return;
    if (cur.deleted) cur.file.path = cur.a;
    files.push(cur.file);
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const p = headerPaths(line.slice("diff --git ".length));
      if (!p) {
        cur = undefined;
        partial = true;
        continue;
      }
      cur = {
        file: { path: p.b, added: 0, removed: 0 },
        a: p.a,
        deleted: false,
        inHunk: false,
        binaryPatch: false,
      };
      continue;
    }
    if (!cur) continue;
    if (cur.inHunk) {
      // Inside a hunk every +/- line is a change, even one that begins with ++ or --.
      if (line.startsWith("+")) cur.file.added++;
      else if (line.startsWith("-")) cur.file.removed++;
      continue;
    }
    if (cur.binaryPatch) continue;
    if (line.startsWith("@@")) cur.inHunk = true;
    else if (line.startsWith("rename from ")) cur.file.renamed_from = line.slice(12);
    else if (line.startsWith("deleted file mode")) cur.deleted = true;
    else if (line.startsWith("GIT binary patch") || /^Binary files .* differ$/.test(line)) {
      cur.file.binary = true;
      cur.binaryPatch = true;
    }
  }
  flush();
  if (files.length === 0 && text.trim() !== "") partial = true;
  return { files, partial };
}
