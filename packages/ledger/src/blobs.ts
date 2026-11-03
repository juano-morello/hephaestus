import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BlobStore = {
  /** Stores content and returns its sha256 hex id. Storing existing content is a no-op. */
  put(data: string | Uint8Array): string;
  /** Reads a blob, verifying its hash. Throws if missing or corrupted. */
  get(id: string): Uint8Array;
  getText(id: string): string;
  has(id: string): boolean;
};

const SHA256 = /^[0-9a-f]{64}$/;

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Content-addressed store: one file per blob at `<root>/<sha256>` (SPEC section 6). */
export function createBlobStore(root: string): BlobStore {
  mkdirSync(root, { recursive: true });

  const pathOf = (id: string) => {
    if (!SHA256.test(id)) throw new Error(`invalid blob id: ${id}`);
    return join(root, id);
  };

  const get = (id: string) => {
    const path = pathOf(id);
    if (!existsSync(path)) throw new Error(`blob not found: ${id}`);
    const bytes = new Uint8Array(readFileSync(path));
    if (hash(bytes) !== id) throw new Error(`blob corrupted: ${id}`);
    return bytes;
  };

  return {
    put(data) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const id = hash(bytes);
      const path = pathOf(id);
      if (!existsSync(path)) {
        // Write then rename, so a crash never leaves a partial blob under a valid id.
        const tmp = join(root, `.tmp-${randomBytes(8).toString("hex")}`);
        writeFileSync(tmp, bytes);
        renameSync(tmp, path);
      }
      return id;
    },
    get,
    getText: (id) => new TextDecoder().decode(get(id)),
    has: (id) => existsSync(pathOf(id)),
  };
}
