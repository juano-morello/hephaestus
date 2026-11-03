import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBlobStore } from "../src/blobs.ts";
import { tempDir } from "./helpers.ts";

const dir = tempDir();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("blob store", () => {
  test("stores content under its sha256 and reads it back", () => {
    const root = join(dir(), "blobs");
    const blobs = createBlobStore(root);
    const id = blobs.put("diff --git a/x b/x");
    expect(id).toBe(sha("diff --git a/x b/x"));
    expect(existsSync(join(root, id))).toBe(true);
    expect(blobs.getText(id)).toBe("diff --git a/x b/x");
    expect(blobs.get(id)).toEqual(new TextEncoder().encode("diff --git a/x b/x"));
    expect(blobs.has(id)).toBe(true);
  });

  test("accepts bytes", () => {
    const blobs = createBlobStore(dir());
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(blobs.get(blobs.put(bytes))).toEqual(bytes);
  });

  test("writing the same content twice keeps one file and leaves no temp files", () => {
    const root = dir();
    const blobs = createBlobStore(root);
    const a = blobs.put("same");
    const b = blobs.put("same");
    expect(a).toBe(b);
    expect(readdirSync(root)).toEqual([a]);
  });

  test("a missing blob is reported, not returned empty", () => {
    const blobs = createBlobStore(dir());
    const missing = sha("nope");
    expect(blobs.has(missing)).toBe(false);
    expect(() => blobs.get(missing)).toThrow(`blob not found: ${missing}`);
  });

  test("a corrupted blob fails its hash check on read", () => {
    const root = dir();
    const blobs = createBlobStore(root);
    const id = blobs.put("original");
    writeFileSync(join(root, id), "tampered");
    expect(() => blobs.get(id)).toThrow(`blob corrupted: ${id}`);
  });

  test("rejects anything that is not a sha256 hex id", () => {
    const blobs = createBlobStore(dir());
    for (const bad of ["../../etc/passwd", "ABC", sha("x").toUpperCase()]) {
      expect(() => blobs.get(bad)).toThrow("invalid blob id");
      expect(() => blobs.has(bad)).toThrow("invalid blob id");
    }
  });
});
