/** Short-lived private answers shared by CLI processes and MCP; never part of a spec or report. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { capOutput, pick, pickEntry, splitRegex } from "./extract.js";
import { home, readJson, withLock, writePrivate } from "./session.js";

export interface ResultView {
  fields?: string[];
  maxChars?: number;
}

export interface ResultCursor extends ResultView {
  resultId: string;
  /** Item index, or a character offset when format is json. */
  offset: number;
  format?: "json";
}

export interface ResultSlice {
  data: unknown;
  truncated?: string;
  resultId?: string;
  more?: ResultCursor;
  /** data is a fragment of serialized JSON; concatenate fragments, then JSON.parse. */
  encoding?: "json";
}

export interface GetResultOptions extends ResultView {
  offset?: number;
  format?: "json";
}

export const RESULT_TTL_MS = 15 * 60_000;
export const RESULT_LIMIT = 20;
export const MIN_RESULT_CHARS = 256;
export const MAX_RESULT_CHARS = 200_000;

interface Kept {
  id: string;
  expiresAt: number;
  data: unknown;
}

/** The kept answers together, serialized: a new one evicts the oldest to fit, and one over it alone is not kept. */
export const RESULT_BYTES = 16 * 1024 * 1024;

const file = () => join(home(), "results.json");
const alive = (now: number) => {
  const all = readJson<Kept[]>(file(), []);
  const kept = all.filter((r) => r.expiresAt > now);
  // every call reads the store while it exists: rewrite it only when something expired
  if (kept.length !== all.length) writePrivate(file(), JSON.stringify(kept));
  return kept;
};

/** The newest kept answers that fit RESULT_LIMIT and RESULT_BYTES. */
function fit(kept: Kept[]): Kept[] {
  const out: Kept[] = [];
  let bytes = 2;
  for (const r of kept.slice(-RESULT_LIMIT).reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(r)) + 1;
    if (bytes > RESULT_BYTES) break;
    out.unshift(r);
  }
  return out;
}

export function viewProblem(view: ResultView | undefined): string | undefined {
  if (view === undefined) return undefined;
  if (!view || typeof view !== "object" || Array.isArray(view)) return "view must be an object";
  if (
    view.maxChars !== undefined &&
    (!Number.isInteger(view.maxChars) || view.maxChars < MIN_RESULT_CHARS || view.maxChars > MAX_RESULT_CHARS)
  )
    return `view.maxChars must be an integer from ${MIN_RESULT_CHARS} to ${MAX_RESULT_CHARS}`;
  if (view.fields !== undefined) {
    if (
      !Array.isArray(view.fields) ||
      !view.fields.length ||
      view.fields.length > 100 ||
      view.fields.some((p) => typeof p !== "string" || !p.trim() || p.length > 512)
    )
      return "view.fields must contain 1 to 100 non-empty pick paths (at most 512 characters each)";
    // a view's fields come from the agent, which may be acting on page text: a regex there could hang the
    // server on a kept answer (catastrophic backtracking), and no time limit interrupts a running match
    if (view.fields.some((p) => splitRegex(p).regex !== undefined))
      return "view.fields takes pick paths and renames (name=path), not path~regex";
    try {
      for (const p of view.fields) {
        const { path } = pickEntry(p);
        for (const m of path.matchAll(/\["((?:[^"\\]|\\.)*)"\]/g)) JSON.parse(`"${m[1]}"`);
      }
    } catch {
      return "view.fields contains an invalid pick expression";
    }
  }
  return undefined;
}

// A view must not drop items whose selected fields are absent: offsets name the original items.
const project = (value: unknown, fields?: string[]): unknown => (fields ? pick(value, fields, true) : value);

// A call-only host offers no get_result or maxChars, so its note names only what a caller can change.
const HOST_HINT = "pass fields to keep fewer fields per item, or narrow the arguments";

function slice(
  value: unknown,
  opts: GetResultOptions,
  hint = "use fields/maxChars to shape output",
): ResultSlice & { next?: number; format?: "json" } {
  const max = opts.maxChars ?? 20_000;
  const offset = opts.offset ?? 0;
  if (opts.format === "json") {
    const text = JSON.stringify(value) ?? "null";
    const data = capOutput(text.slice(offset), max).data as string;
    const next = offset + data.length;
    return {
      data,
      encoding: "json",
      ...(next < text.length ? { next, format: "json", truncated: "more local JSON fragments remain" } : {}),
    };
  }
  const rest = Array.isArray(value) ? value.slice(offset) : value;
  const capped = capOutput(rest, max, hint);
  if (!capped.truncated) return capped;
  if (Array.isArray(rest) && Array.isArray(capped.data)) {
    const n = capped.data.length;
    if (n && capped.data[n - 1] === rest[n - 1]) return { ...capped, next: offset + n };
  }
  // A shortened item/object cannot be skipped without losing its tail. Read its serialized JSON.
  return { ...capped, next: 0, format: "json" };
}

function cursor(id: string, r: ReturnType<typeof slice>, view: ResultView): ResultSlice {
  const { next, format, ...out } = r;
  return {
    ...out,
    resultId: id,
    ...(next !== undefined
      ? {
          more: {
            resultId: id,
            offset: next,
            ...(format ? { format } : {}),
            ...(view.fields ? { fields: view.fields } : {}),
            ...(view.maxChars !== undefined ? { maxChars: view.maxChars } : {}),
          },
          truncated: `${out.truncated}; use get_result with more (CLI: api-anything result ${id}), or fields/maxChars to reshape the kept answer; no site request`,
        }
      : {}),
  };
}

/** Call only after classification, extraction, and any write readback have finished. */
export function resultView(value: unknown, view: ResultView = {}, now = Date.now(), callOnly = false): ResultSlice {
  const r = slice(project(value, view.fields), view, callOnly ? HOST_HINT : undefined);
  // Nothing continues a call-only answer, so none is kept for it.
  if (callOnly) {
    const { next: _next, format: _format, ...out } = r;
    return out;
  }
  if (!r.truncated && !existsSync(file())) return { data: r.data };
  try {
    return withLock(file(), () => {
      const kept = alive(now);
      if (!r.truncated) {
        const { next: _next, format: _format, ...out } = r;
        return out;
      }
      const id = randomUUID();
      const fitted = fit([...kept, { id, expiresAt: now + RESULT_TTL_MS, data: value }]);
      if (fitted.at(-1)?.id !== id) throw new Error(`the answer is over ${RESULT_BYTES} bytes`);
      writePrivate(file(), JSON.stringify(fitted));
      return cursor(id, r, view);
    });
  } catch {
    const { next: _next, format: _format, ...out } = r;
    return {
      ...out,
      ...(r.truncated ? { truncated: `${r.truncated}; local retention failed; the full answer is not available` } : {}),
    };
  }
}

/** No network, no spec lookup, and no TTL extension on retrieval. */
export function getResult(
  id: string,
  opts: GetResultOptions = {},
  now = Date.now(),
): ({ ok: true; class: "ok" } & ResultSlice) | { ok: false; class: "input" | "error"; reason: string } {
  const problem = viewProblem(opts);
  if (problem) return { ok: false, class: "input", reason: problem };
  if (!Number.isSafeInteger(opts.offset ?? 0) || (opts.offset ?? 0) < 0)
    return { ok: false, class: "input", reason: "offset must be a non-negative safe integer" };
  if (opts.format !== undefined && opts.format !== "json")
    return { ok: false, class: "input", reason: "format must be json when supplied" };
  if (!/^[0-9a-f-]{36}$/.test(id)) return { ok: false, class: "input", reason: "invalid resultId" };
  try {
    return withLock(file(), () => {
      const kept = alive(now);
      const found = kept.find((r) => r.id === id);
      if (!found) return { ok: false, class: "input", reason: "result not found, expired, or evicted" };
      const value = project(found.data, opts.fields);
      if (!Array.isArray(value) && opts.format !== "json" && (opts.offset ?? 0) !== 0)
        return {
          ok: false,
          class: "input",
          reason: "an item offset requires a list; use format json for character offsets",
        };
      return { ok: true, class: "ok", ...cursor(id, slice(value, opts), opts) };
    });
  } catch {
    return { ok: false, class: "error", reason: "could not read the local result store" };
  }
}
