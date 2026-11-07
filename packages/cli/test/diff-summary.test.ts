import { describe, expect, test } from "bun:test";
import { MAX_DIFF_BYTES, summarizeDiff } from "../src/diff-summary.ts";

const two = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 keep
-old
+new
+more
 tail
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;

describe("summarizeDiff", () => {
  test("counts added and removed lines per file and ignores the ---/+++ headers", () => {
    expect(summarizeDiff(two)).toEqual({
      files: [
        { path: "a.txt", added: 2, removed: 1 },
        { path: "src/b.ts", added: 1, removed: 1 },
      ],
      partial: false,
    });
  });

  test("a rename with edits keeps the new path and where it came from", () => {
    const d = `diff --git a/old.ts b/new.ts
similarity index 80%
rename from old.ts
rename to new.ts
index 1..2 100644
--- a/old.ts
+++ b/new.ts
@@ -1 +1,2 @@
 a
+b
`;
    expect(summarizeDiff(d).files).toEqual([
      { path: "new.ts", added: 1, removed: 0, renamed_from: "old.ts" },
    ]);
  });

  test("a new file counts only additions, a deleted file keeps its a/ path", () => {
    const d = `diff --git a/n.txt b/n.txt
new file mode 100644
index 0..1
--- /dev/null
+++ b/n.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1..0
--- a/gone.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c
`;
    expect(summarizeDiff(d).files).toEqual([
      { path: "n.txt", added: 2, removed: 0 },
      { path: "gone.txt", added: 0, removed: 3 },
    ]);
  });

  test("a binary file is flagged with zero counts, in both git forms", () => {
    const d = `diff --git a/i.png b/i.png
index 1..2 100644
Binary files a/i.png and b/i.png differ
diff --git a/j.bin b/j.bin
index 1..2 100644
GIT binary patch
literal 4
LcmZQzU|?VY00ahL

`;
    expect(summarizeDiff(d).files).toEqual([
      { path: "i.png", added: 0, removed: 0, binary: true },
      { path: "j.bin", added: 0, removed: 0, binary: true },
    ]);
  });

  test("a changed line that itself starts with ++ or -- is counted", () => {
    const d = `diff --git a/c.sh b/c.sh
--- a/c.sh
+++ b/c.sh
@@ -1 +1 @@
--- not a header
+++ not a header either
`;
    expect(summarizeDiff(d).files).toEqual([{ path: "c.sh", added: 1, removed: 1 }]);
  });

  test("empty text is no files and not partial; garbage is no files and partial", () => {
    expect(summarizeDiff("")).toEqual({ files: [], partial: false });
    expect(summarizeDiff("  \n")).toEqual({ files: [], partial: false });
    expect(summarizeDiff("this is not a diff")).toEqual({ files: [], partial: true });
  });

  test("a diff over the cap is cut and says partial, listing the files in the first part", () => {
    expect(MAX_DIFF_BYTES).toBe(5 * 1024 * 1024);
    const filler = `+${"x".repeat(99)}\n`.repeat(Math.ceil((6 * 1024 * 1024) / 101));
    const text = `${two}diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1 @@\n${filler}`;
    expect(text.length).toBeGreaterThan(6 * 1024 * 1024);
    const r = summarizeDiff(text);
    expect(r.partial).toBe(true);
    expect(r.files.map((f) => f.path)).toEqual(["a.txt", "src/b.ts", "big"]);
  });

  test("a path with a space or quotes still parses from the b/ side", () => {
    const d = `diff --git a/my file.txt b/my file.txt
--- a/my file.txt
+++ b/my file.txt
@@ -1 +1 @@
-a
+b
`;
    expect(summarizeDiff(d).files[0]).toMatchObject({ path: "my file.txt", added: 1, removed: 1 });
  });
});
