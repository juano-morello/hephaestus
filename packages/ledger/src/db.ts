// The only runtime-specific module in the ledger (SPEC section 3): everything else talks to
// this interface, so a node:sqlite implementation can be added without touching callers.
import { Database } from "bun:sqlite";

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export type Statement = {
  run(...params: SqlValue[]): void;
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
};

export type Db = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Runs fn in a transaction; a throw rolls everything back. Nests via savepoints. */
  transaction<T>(fn: () => T): T;
  close(): void;
};

export function openDb(path: string): Db {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        run: (...params) => void stmt.run(...params),
        get: <T>(...params: SqlValue[]) => (stmt.get(...params) as T | null) ?? undefined,
        all: <T>(...params: SqlValue[]) => stmt.all(...params) as T[],
      };
    },
    transaction: <T>(fn: () => T) => db.transaction(fn)() as T,
    close: () => db.close(),
  };
}
