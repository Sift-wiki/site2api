/** node:sqlite, loaded on first use with its one "experimental" warning dropped. */
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

let sqlite: typeof import("node:sqlite") | undefined;

/** Open a database read-only. A static import of node:sqlite would warn before any filter could run. */
export function openReadOnly(file: string): DatabaseSync {
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
  return new sqlite.DatabaseSync(file, { readOnly: true });
}
