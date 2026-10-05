import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export const DB_PATH = process.env.DB_PATH ?? "state/mentions.db";

/** Open (or create) the SQLite DB in WAL mode so the UI can read while the engine writes. */
export function openDatabase(opts: { readonly?: boolean } = {}): Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = opts.readonly
    ? new Database(DB_PATH, { readonly: true })
    : new Database(DB_PATH);
  if (!opts.readonly) {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL;");
  }
  return db;
}
