/**
 * Read and write values inside a captured request through its decoded layers.
 *
 * A step path like ["form:f.req", "json:/1", "json:/0/1/0/0"] means: take form field f.req, parse it
 * as JSON, take /1 (a string), parse that as JSON, take /0/1/0/0. setAt re-encodes only the layers
 * on that path and splices the result back, so every other byte (key order, whitespace, RestLi
 * parens, big integers, the site's own percent-encoding) stays identical.
 *
 * Root steps: path:<i> (i-th segment after the leading slash), query:<key>, header:<name>,
 * form:<key> (urlencoded body), body. A repeated key's later occurrences are query[<n>]:<key> and
 * form[<n>]:<key> (n counts from 0). Below them json:<RFC 6901 pointer>, and b64 (the current
 * string is base64 of JSON, as some apps pack their state into one query param).
 */
import type { Request } from "./spec.js";

export type Step = string;

export interface Leaf {
  at: Step[];
  /** decoded text; JSON numbers/booleans/null as their source text */
  value: string;
  type: "string" | "number" | "boolean" | "null";
  /** the string was itself JSON and its leaves follow in the walk */
  container?: boolean;
  /** on a container: the keys objects in its JSON repeat. Step paths reach such a key's first occurrence only. */
  repeated?: Step[][];
}

/* ------------------------------------------------------------- JSON spans */

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const skipWs = (s: string, i: number) => {
  while (isWs(s[i])) i++;
  return i;
};
const LITERAL = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** Index just past the JSON value that starts at i. */
export function jsonValueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') {
    for (i++; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === '"') return i + 1;
    }
    throw new SyntaxError("unterminated JSON string");
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"') i = jsonValueEnd(s, i) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if ((ch === "}" || ch === "]") && --depth === 0) return i + 1;
    }
    throw new SyntaxError("unterminated JSON container");
  }
  LITERAL.lastIndex = i;
  const m = LITERAL.exec(s);
  if (!m) throw new SyntaxError(`unexpected JSON at ${i}`);
  return i + m[0].length;
}

/** Visit each member/element of the container at i as (key, valueStart). Return true to stop. */
// biome-ignore lint/suspicious/noConfusingVoidType: a visitor that never stops returns nothing
function eachChild(s: string, i: number, fn: (key: string, start: number) => boolean | void): void {
  const obj = s[i] === "{";
  const close = obj ? "}" : "]";
  i = skipWs(s, i + 1);
  if (s[i] === close) return;
  for (let idx = 0; ; idx++) {
    let key = String(idx);
    if (obj) {
      const keyEnd = jsonValueEnd(s, i);
      key = JSON.parse(s.slice(i, keyEnd)) as string;
      i = skipWs(s, keyEnd);
      if (s[i] !== ":") throw new SyntaxError(`expected ':' at ${i}`);
      i = skipWs(s, i + 1);
    }
    if (fn(key, i) === true) return;
    i = skipWs(s, jsonValueEnd(s, i));
    if (s[i] === ",") i = skipWs(s, i + 1);
    else if (s[i] === close) return;
    else throw new SyntaxError(`expected ',' or '${close}' at ${i}`);
  }
}

const unescapeToken = (t: string) => t.replace(/~1/g, "/").replace(/~0/g, "~");
const escapeToken = (t: string) => t.replace(/~/g, "~0").replace(/\//g, "~1");

/** [start, end) of the value at an RFC 6901 pointer. */
function locate(s: string, pointer: string): [number, number] {
  if (pointer !== "" && !pointer.startsWith("/")) throw new Error(`bad JSON pointer "${pointer}"`);
  let start = skipWs(s, 0);
  for (const token of pointer ? pointer.slice(1).split("/").map(unescapeToken) : []) {
    let found = -1;
    if (s[start] === "{" || s[start] === "[") {
      eachChild(s, start, (key, at) => {
        if (key !== token) return false;
        found = at;
        return true;
      });
    }
    if (found < 0) throw new Error(`JSON pointer "${pointer}" not found`);
    start = found;
  }
  return [start, jsonValueEnd(s, start)];
}

/** A body nested past the JSON reviver's stack depth: nothing here can walk it, and the depth is the answer's. */
export class BodyTooDeep extends Error {
  constructor() {
    super("the body nests too deeply to parse");
  }
}

/** JSON.parse that keeps integers beyond 2^53 as their exact digit strings. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text, (_key: string, value: unknown, ctx?: { source?: string }) =>
      typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value) && ctx?.source
        ? ctx.source
        : value,
    );
  } catch (error) {
    // The reviver runs once per value, down the whole body, so the body's nesting depth is this stack's
    // depth: 5,000 levels overflow here while plain JSON.parse takes 100,000. Name it, so a caller can
    // report the answer's shape instead of relaying the engine's message.
    if (error instanceof RangeError) throw new BodyTooDeep();
    throw error;
  }
}

/** Encode a value as a JSON leaf, keeping its native type. bigint is written as raw digits. */
function toJson(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError(`cannot encode ${v} as JSON`);
  const out = JSON.stringify(v);
  if (out === undefined) throw new TypeError(`cannot encode ${typeof v} as JSON`);
  return out;
}

/** Text for a non-JSON layer (path, query, header, form, body). */
export function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/* ------------------------------------------------------ percent-encoding */

function decode(raw: string, plusIsSpace: boolean): string {
  try {
    return decodeURIComponent(plusIsSpace ? raw.replace(/\+/g, " ") : raw);
  } catch {
    return raw;
  }
}

/** Percent-encode like the original raw text did: chars it left literal stay literal, and vice versa. */
function encodeLike(value: string, original: string, plusIsSpace: boolean): string {
  const out = encodeURIComponent(value)
    .replace(/%([0-7][0-9A-F])/g, (m, hex: string) => {
      const ch = String.fromCharCode(parseInt(hex, 16));
      return !"%&=#+ ".includes(ch) && original.includes(ch) ? ch : m;
    })
    .replace(/[!'()*~]/g, (ch) => {
      const pct = `%${ch.charCodeAt(0).toString(16).toUpperCase()}`;
      return original.toUpperCase().includes(pct) ? pct : ch;
    });
  return plusIsSpace && original.includes("+") ? out.replace(/%20/g, "+") : out;
}

/* ------------------------------------------------------------ root layers */

function splitUrl(url: string) {
  const hashAt = url.indexOf("#");
  const hash = hashAt < 0 ? "" : url.slice(hashAt);
  const noHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const qAt = noHash.indexOf("?");
  const base = qAt < 0 ? noHash : noHash.slice(0, qAt);
  const query = qAt < 0 ? undefined : noHash.slice(qAt + 1);
  const schemeEnd = base.indexOf("//");
  const pathAt = base.indexOf("/", schemeEnd < 0 ? 0 : schemeEnd + 2);
  const origin = pathAt < 0 ? base : base.slice(0, pathAt);
  const segments = pathAt < 0 ? [] : base.slice(pathAt + 1).split("/");
  return { origin, segments, query, hash };
}

function joinUrl(u: ReturnType<typeof splitUrl>): string {
  const path = u.segments.length ? `/${u.segments.join("/")}` : "";
  return `${u.origin}${path}${u.query === undefined ? "" : `?${u.query}`}${u.hash}`;
}

interface Pair {
  rawKey: string;
  rawValue: string;
  key: string;
}

function parsePairs(raw: string): Pair[] {
  if (!raw) return [];
  return raw.split("&").map((p) => {
    const eq = p.indexOf("=");
    const rawKey = eq < 0 ? p : p.slice(0, eq);
    return { rawKey, rawValue: eq < 0 ? "" : p.slice(eq + 1), key: decode(rawKey, true) };
  });
}

/** The n-th pair with that key. */
function nthPair(pairs: Pair[], key: string, n: number): number {
  for (let i = 0; i < pairs.length; i++) if (pairs[i]!.key === key && n-- === 0) return i;
  return -1;
}

/** Rewrite one pair (the n-th with that key) in a raw a=b&c=d string; untouched pairs keep their bytes. */
function setPair(raw: string, key: string, value: string, n = 0): string {
  const parts = raw ? raw.split("&") : [];
  const pairs = parsePairs(raw);
  const idx = nthPair(pairs, key, n);
  if (idx < 0) {
    parts.push(`${encodeURIComponent(key)}=${encodeLike(value, raw, true)}`);
  } else {
    const p = pairs[idx]!;
    parts[idx] = `${p.rawKey}=${encodeLike(value, p.rawValue || raw, true)}`;
  }
  return parts.join("&");
}

export function isFormBody(req: Request): boolean {
  const ct = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  return /application\/x-www-form-urlencoded/i.test(ct);
}

function parseStep(step: Step): [string, string, number] {
  const i = step.indexOf(":");
  const [kind, arg] = i < 0 ? [step, ""] : [step.slice(0, i), step.slice(i + 1)];
  const m = /^(query|form)\[(\d+)\]$/.exec(kind);
  return m ? [m[1]!, arg, Number(m[2])] : [kind, arg, 0];
}

/** The text at a root step and how to write it back. */
function rootLayer(req: Request, step: Step): { value: string | undefined; put: (v: string) => Request } {
  const [kind, arg, n] = parseStep(step);
  switch (kind) {
    case "path": {
      const u = splitUrl(req.url);
      const i = Number(arg);
      const raw = u.segments[i];
      return {
        value: raw === undefined ? undefined : decode(raw, false),
        put: (v) => {
          if (raw === undefined) throw new Error(`no path segment ${i} in ${req.url}`);
          u.segments[i] = encodeLike(v, raw, false);
          return { ...req, url: joinUrl(u) };
        },
      };
    }
    case "query": {
      const u = splitUrl(req.url);
      const pairs = parsePairs(u.query ?? "");
      const p = pairs[nthPair(pairs, arg, n)];
      return {
        value: p ? decode(p.rawValue, true) : undefined,
        put: (v) => ({ ...req, url: joinUrl({ ...u, query: setPair(u.query ?? "", arg, v, n) }) }),
      };
    }
    case "header": {
      const name = arg.toLowerCase();
      return {
        value: req.headers[name],
        put: (v) => ({ ...req, headers: { ...req.headers, [name]: v } }),
      };
    }
    case "form": {
      const pairs = parsePairs(req.body ?? "");
      const p = pairs[nthPair(pairs, arg, n)];
      return {
        value: p ? decode(p.rawValue, true) : undefined,
        put: (v) => ({ ...req, body: setPair(req.body ?? "", arg, v, n) }),
      };
    }
    case "body":
      return { value: req.body, put: (v) => ({ ...req, body: v }) };
    default:
      throw new Error(`step "${step}" is not a request layer (path, query, header, form, body)`);
  }
}

function jsonPointer(step: Step): string {
  const [kind, arg] = parseStep(step);
  if (kind !== "json") throw new Error(`step "${step}" must be json:<pointer> below the request layer`);
  return arg;
}

/* ----------------------------------------------------------------- public */

export function getAt(req: Request, steps: Step[]): unknown {
  const [first, ...rest] = steps;
  if (first === undefined) throw new Error("empty step path");
  let text = rootLayer(req, first).value;
  if (text === undefined) return undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "b64") {
      text = fromB64(text);
      continue;
    }
    const [a, b] = locate(text, jsonPointer(rest[i]!));
    const v = parseJson(text.slice(a, b));
    if (i === rest.length - 1) return v;
    if (typeof v !== "string") throw new Error(`${rest[i]} is not a JSON string, cannot descend`);
    text = v;
  }
  return text;
}

const B64 = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const fromB64 = (s: string) => Buffer.from(s, "base64").toString("utf8");
/** Encode like the original: base64url when it used - or _, padding only when it had some. */
function toB64Like(text: string, original: string): string {
  const url = /[-_]/.test(original);
  const out = Buffer.from(text, "utf8").toString(url ? "base64url" : "base64");
  return original.endsWith("=") ? out.padEnd(Math.ceil(out.length / 4) * 4, "=") : out.replace(/=+$/, "");
}

function setNested(text: string, steps: Step[], value: unknown): string {
  const [step, ...rest] = steps;
  if (step === "b64") return toB64Like(rest.length ? setNested(fromB64(text), rest, value) : asText(value), text);
  const [a, b] = locate(text, jsonPointer(step!));
  let replacement: string;
  if (rest.length) {
    const inner = JSON.parse(text.slice(a, b)) as unknown;
    if (typeof inner !== "string") throw new Error(`${step} is not a JSON string, cannot descend`);
    replacement = JSON.stringify(setNested(inner, rest, value));
  } else {
    replacement = toJson(value);
  }
  return text.slice(0, a) + replacement + text.slice(b);
}

/** Return a copy of req with value written at steps. A whole JSON leaf keeps the value's native type. */
export function setAt(req: Request, steps: Step[], value: unknown): Request {
  const [first, ...rest] = steps;
  if (first === undefined) throw new Error("empty step path");
  const layer = rootLayer(req, first);
  if (!rest.length) return layer.put(asText(value));
  if (layer.value === undefined) throw new Error(`nothing at ${first}`);
  return layer.put(setNested(layer.value, rest, value));
}

/**
 * Replace `{name}` for names present in vars; anything else (e.g. minified GraphQL `{id}`) stays.
 * `{{` and `}}` are literal braces, so a learned template can hold text like `{name}` verbatim.
 */
export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{|\}\}|\{([^{}]+)\}/g, (m, k: string | undefined) =>
    k === undefined ? m[0]! : vars[k] === undefined ? m : asText(vars[k]),
  );
}

/** The `{cookie:x}`/`{session:x}` holes of a template: a param's leaf can carry a credential too. */
export const templateRefs = (template: string): string[] =>
  [...template.matchAll(/\{\{|\}\}|\{((?:cookie|session):[^{}]+)\}/g)].flatMap((m) => (m[1] ? [m[1]] : []));

/** Literal text as a template: every brace doubled. */
export const escapeTemplate = (text: string) => text.replace(/[{}]/g, (c) => c + c);

/**
 * How a value is written inside a templated leaf: "url" percent-encodes it (the leaf is a URL, so
 * the arg sits one encoding layer deeper: a referer, a next= path), "json" escapes it for a JSON
 * string literal (an inline GraphQL `search(q: "{q}")`).
 */
export type Escape = "url" | "json";

export function escapeValue(v: unknown, escape: Escape | undefined): string {
  const s = asText(v);
  if (escape === "url") return encodeURIComponent(s);
  if (escape === "json") return JSON.stringify(s).slice(1, -1);
  return s;
}

/** fillTemplate with every var escaped for the leaf's encoding layer. */
export function fillSlotTemplate(template: string, vars: Record<string, unknown>, escape?: Escape): string {
  if (!escape) return fillTemplate(template, vars);
  return fillTemplate(
    template,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v === undefined ? v : escapeValue(v, escape)])),
  );
}

/** Walk the leaves of s, the JSON text `holder` holds at `at`, into out. False when s is not JSON. */
function walkJsonString(s: string, at: Step[], out: Leaf[], holder: Leaf): boolean {
  const start = skipWs(s, 0);
  if (s[start] !== "{" && s[start] !== "[") return false;
  try {
    JSON.parse(s);
  } catch {
    return false;
  }
  const visit = (i: number, ptr: string) => {
    const c = s[i];
    if (c === "{" || c === "[") {
      const seen = new Set<string>();
      return eachChild(s, i, (key, child) => {
        const p = `${ptr}/${escapeToken(key)}`;
        // noted where the object is walked: a repeated key may hold no leaf at all ({} twice)
        if (c === "{" && seen.has(key)) holder.repeated = [...(holder.repeated ?? []), [...at, `json:${p}`]];
        seen.add(key);
        visit(child, p);
      });
    }
    const span = s.slice(i, jsonValueEnd(s, i));
    const steps = [...at, `json:${ptr}`];
    if (c === '"') {
      const leaf: Leaf = { at: steps, value: JSON.parse(span) as string, type: "string" };
      out.push(leaf);
      walkInner(leaf, out);
    } else {
      out.push({ at: steps, value: span, type: c === "t" || c === "f" ? "boolean" : c === "n" ? "null" : "number" });
    }
  };
  visit(start, "");
  return true;
}

/** A string leaf that holds JSON, directly or base64-encoded, is a container: its leaves follow it in out. */
function walkInner(leaf: Leaf, out: Leaf[]): void {
  const s = leaf.value;
  if (walkJsonString(s, leaf.at, out, leaf)) leaf.container = true;
  else if (B64.test(s)) {
    const text = fromB64(s);
    // only a clean round trip counts: a hash or token decodes to bytes that are not JSON text
    const clean =
      /^\s*[[{]/.test(text) &&
      Buffer.from(text, "utf8").toString("base64").replace(/=+$/, "") ===
        s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (clean && walkJsonString(text, [...leaf.at, "b64"], out, leaf)) leaf.container = true;
  }
}

/** Every decoded leaf of the request with its step path, including JSON inside strings, recursively. */
export function walk(req: Request): Leaf[] {
  const out: Leaf[] = [];
  const add = (at: Step[], value: string) => {
    const leaf: Leaf = { at, value, type: "string" };
    out.push(leaf);
    walkInner(leaf, out);
  };
  const u = splitUrl(req.url);
  u.segments.forEach((seg, i) => {
    if (seg) add([`path:${i}`], decode(seg, false));
  });
  // A repeated key (tag=a&tag=b) is walked at every occurrence: query:tag, query[1]:tag, ...
  const pairs = (kind: string, raw: string) => {
    const seen = new Map<string, number>();
    for (const p of parsePairs(raw)) {
      const n = seen.get(p.key) ?? 0;
      seen.set(p.key, n + 1);
      add([n ? `${kind}[${n}]:${p.key}` : `${kind}:${p.key}`], decode(p.rawValue, true));
    }
  };
  pairs("query", u.query ?? "");
  for (const [name, value] of Object.entries(req.headers)) add([`header:${name.toLowerCase()}`], value);
  if (req.body !== undefined && req.body !== "") {
    // Some clients (Algolia's) send a JSON body labeled form-urlencoded to skip the CORS preflight.
    if (isFormBody(req) && !/^\s*[[{]/.test(req.body)) {
      pairs("form", req.body);
    } else {
      add(["body"], req.body);
    }
  }
  return out;
}
