/** node:sqlite, loaded on first use with its one "experimental" warning dropped. */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

let sqlite: typeof import("node:sqlite") | undefined;

/** A static import of node:sqlite would warn before any filter could run. */
function load(): typeof import("node:sqlite") {
  if (!sqlite) {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning?.message;
      if (!text?.includes("SQLite is an experimental")) Reflect.apply(emit, process, [warning, ...rest]);
    }) as typeof process.emitWarning;
    try {
      sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  }
  return sqlite;
}

/** Open a database read-only. */
export function openReadOnly(file: string): DatabaseSync {
  return new (load().DatabaseSync)(file, { readOnly: true });
}

/** Open a database read-write, creating it when missing. */
export function openReadWrite(file: string): DatabaseSync {
  return new (load().DatabaseSync)(file);
}
