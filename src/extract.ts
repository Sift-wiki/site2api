/** Turn a response body into the compact value an agent sees: parse, extract, pick, cap. */
import { type HTMLElement, parse as parseHtml } from "node-html-parser";
import { jsonValueEnd, parseJson } from "./codec.js";
import type { ResponseSpec } from "./spec.js";

export const XSSI = ")]}'";
// Anti-JSON-hijacking prefixes: Google's, Meta's /ajax/* and older Google/Facebook APIs.
const PREFIXES = [XSSI, "for (;;);", "while(1);"];

/** The XSSI prefix a body starts with, if any. */
export const xssiOf = (body: string) => PREFIXES.find((p) => body.trimStart().startsWith(p));

/**
 * Strip the XSSI prefix and parse JSON losslessly. Google `rt=c` length-prefixed chunks, and
 * Meta-style bodies that repeat the prefix before each JSON value, become an array.
 */
export function parseBody(body: string, xssiPrefix?: string): unknown {
  let text = body.trimStart();
  const prefix = xssiPrefix ?? xssiOf(text) ?? "";
  if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length);
  text = text.trim();
  if (/^\d+[ \t]*\r?\n/.test(text)) return parseChunks(text);
  try {
    return parseJson(text);
  } catch (error) {
    if (!prefix || !text.includes(prefix)) throw error;
    const parts: unknown[] = [];
    let at = 0;
    while (at < text.length) {
      const end = jsonValueEnd(text, at);
      parts.push(parseJson(text.slice(at, end)));
      at = end;
      while (/\s/.test(text[at] ?? "")) at++;
      if (at === text.length) break;
      if (!text.startsWith(prefix, at)) throw error;
      at += prefix.length;
      while (/\s/.test(text[at] ?? "")) at++;
      if (at === text.length) throw error;
    }
    return parts;
  }
}

function parseChunks(text: string): unknown[] {
  const out: unknown[] = [];
  const head = /\s*\d+[ \t]*\r?\n\s*/y;
  let i = 0;
  while (i < text.length) {
    head.lastIndex = i;
    const m = head.exec(text);
    if (!m) break;
    i += m[0].length;
    // Chunk lengths count bytes or UTF-16 units depending on the server; scanning the JSON is exact.
    const end = jsonValueEnd(text, i);
    out.push(parseJson(text.slice(i, end)));
    i = end;
  }
  return out;
}

/** A string holding JSON (Google's batchexecute nests payloads this way), parsed; else undefined. */
export function innerJson(s: string): unknown {
  if (!/^\s*[[{]/.test(s)) return undefined;
  try {
    return parseJson(s);
  } catch {
    return undefined;
  }
}

/**
 * Resolve "a.b[0].c", "[1][0][2]", `a["x.y"]`, stepping into JSON-encoded strings. Undefined if any step is missing.
 * `[*]` maps the rest of the path over an array and flattens one level, skipping items where it is
 * missing (`sections[*].items`: every section's items, whichever section holds them).
 */
export function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return atPath(obj, pathSteps(path));
}

const pathSteps = (path: string) => [...path.matchAll(/\[(\d+)\]|\[(\*)\]|\["((?:[^"\\]|\\.)*)"\]|[^.[\]]+/g)];

/** Whether a path maps over a list: a `[*]` step as getPath reads it, not one inside a quoted key (`["a[*]"]`). */
export const hasWildcard = (path: string) => pathSteps(path).some((m) => m[2] !== undefined);

export type PathStep = { key: string } | { index: number } | { all: true };

/**
 * A path's steps exactly as `getPath` reads them, or undefined when it would skip part of the text
 * (a stray `.`, `]` or quote) or could not read a quoted key (`["\q"]`).
 */
export function parsePath(path: string): PathStep[] | undefined {
  const out: PathStep[] = [];
  let at = 0;
  for (const m of pathSteps(path)) {
    const bare = m[1] === undefined && m[2] === undefined && m[3] === undefined;
    // a name after the first step follows a dot; a bracket follows directly
    if (bare && out.length && path[at] === ".") at++;
    if (m.index !== at) return undefined;
    at += m[0].length;
    if (m[1] !== undefined) out.push({ index: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ all: true });
    else if (m[3] !== undefined) {
      try {
        out.push({ key: JSON.parse(`"${m[3]}"`) as string });
      } catch {
        return undefined;
      }
    } else out.push({ key: m[0] });
  }
  return at === path.length && out.length ? out : undefined;
}

function atPath(obj: unknown, steps: RegExpMatchArray[]): unknown {
  const walk = (cur: unknown, i: number): unknown => {
    for (; i < steps.length; i++) {
      const m = steps[i]!;
      if (typeof cur === "string") cur = innerJson(cur);
      if (cur == null || typeof cur !== "object") return undefined;
      if (m[2]) {
        if (!Array.isArray(cur)) return undefined;
        const found = cur.map((x) => walk(x, i + 1)).filter((v) => v !== undefined);
        // items present but none has the rest of the path: the path moved, not "no results"
        return cur.length && !found.length ? undefined : found.flat();
      }
      const key = m[1] ?? (m[3] !== undefined ? (JSON.parse(`"${m[3]}"`) as string) : m[0]);
      if (!Object.hasOwn(cur, key)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur;
  };
  return walk(obj, 0);
}

/** --pick fields: commas separate them, except inside [], {} or () of a regex, or escaped as \, */
export function splitPick(s: string): string[] {
  const out: string[] = [];
  let cur = "",
    depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === ",") {
      cur += ",";
      i++;
      continue;
    }
    if (c === "\\") {
      cur += c + (s[++i] ?? "");
      continue;
    }
    if ("[{(".includes(c)) depth++;
    if ("]})".includes(c)) depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** `path~regex` as its path and regex; the regex is everything after the first `~`. */
export function splitRegex(p: string): { path: string; regex?: string } {
  const cut = p.indexOf("~");
  return cut < 0 ? { path: p } : { path: p.slice(0, cut), regex: p.slice(cut + 1) };
}

export function pickEntry(p: string): { name: string; path: string; re?: RegExp } {
  const [, name, rest] = /^([\w$-]+)=(.+)$/.exec(p) ?? [p, undefined, p];
  const { path, regex } = splitRegex(rest);
  return { name: name ?? path, path, re: regex === undefined ? undefined : new RegExp(regex) };
}

/** What `re`'s group 1 (or whole match) finds in a string; undefined for a non-string or no match. */
const found = (v: unknown, re: RegExp) => {
  const m = typeof v === "string" ? re.exec(v) : null;
  return m ? (m[1] ?? m[0]) : undefined;
};

/** getPath, and with `path~regex` the part of the string there that the regex finds, as pick reads it. */
export function getPathRegex(obj: unknown, p: string): unknown {
  const { path, regex } = splitRegex(p);
  const v = getPath(obj, path);
  return regex === undefined ? v : found(v, new RegExp(regex));
}

/**
 * The keys an item of the result can carry, when the recipe names them: the pick's, else the fields
 * of an HTML recipe whose items come back as they are (no extract path reshaping them). Discovery
 * sends these, so a description never has to repeat (and misstate) them. A key the site leaves out
 * of an item is absent from it.
 */
export function returnedFields(r: Pick<ResponseSpec, "format" | "pick" | "html" | "extract">): string[] | undefined {
  if (r.pick?.length) return r.pick.map((p) => pickEntry(p).name);
  return r.format === "html" && r.html && !r.extract ? Object.keys(r.html.fields) : undefined;
}

/**
 * Keep only the given paths, per item for arrays. `name=path` renames the output key, and
 * `name=path~regex` keeps the part of a string that the regex's group 1 (or whole match) finds
 * (`publicId=navigationUrl~/in/([^/?]+)`); a non-string or no match drops the field.
 */
export function pick(value: unknown, paths: string[], keepEmpty = false): unknown {
  const named = paths.map((p) => {
    const entry = pickEntry(p);
    return { ...entry, steps: pathSteps(entry.path) };
  });
  const one = (item: unknown) => {
    if (!item || typeof item !== "object") return item;
    const out: Record<string, unknown> = {};
    for (const { name, steps, re } of named) {
      let v = atPath(item, steps);
      if (re) v = found(v, re);
      if (v !== undefined) {
        if (name === "__proto__")
          Object.defineProperty(out, name, { value: v, enumerable: true, configurable: true, writable: true });
        else out[name] = v;
      }
    }
    return out;
  };
  if (!Array.isArray(value)) return one(value);
  // an item with none of the fields (a shelf, an ad, a logo entity) is not a result: drop it, not {}
  const items = value.map(one);
  return keepEmpty ? items : items.filter((x) => !(x && typeof x === "object" && !Object.keys(x).length));
}

/** Attribute values that are addresses: a relative one needs the page's own address to be usable. */
const URL_ATTRS = new Set(["href", "src"]);

/** Relative value resolved against the page's final address; otherwise the value untouched. */
const address = (v: string, attr: string, base: string): string => {
  if (!URL_ATTRS.has(attr.toLowerCase())) return v;
  try {
    return new URL(v, base).href;
  } catch {
    return v; // not a URL on its own: a relative junk value stays readable
  }
};

const UNSHOWN_TAGS = new Set(["script", "style", "noscript", "template"]);
const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\s*(?:!\s*important\s*)?(?:;|$)/i;

/**
 * An element the page does not show: script, style, noscript or template, the `hidden` attribute
 * (but `until-found`, a collapsed section a find reveals), or an inline display:none or
 * visibility:hidden. Text an agent reads and the user never sees is where injected instructions
 * hide. `aria-hidden` is shown: it hides from screen readers only, and is often the visible copy.
 */
function unshown(el: HTMLElement): boolean {
  const hidden = el.getAttribute("hidden");
  return (
    UNSHOWN_TAGS.has(el.rawTagName?.toLowerCase() ?? "") ||
    (hidden !== undefined && hidden.toLowerCase() !== "until-found") ||
    HIDDEN_STYLE.test(el.getAttribute("style") ?? "")
  );
}

/** The page parsed, without the elements it does not show; `<head>`'s `<base>` stays. */
export function parseShown(body: string): HTMLElement {
  const doc = parseHtml(body);
  const stack = [doc];
  for (let el = stack.pop(); el; el = stack.pop())
    for (const c of [...el.childNodes])
      if (c.nodeType === 1) unshown(c as HTMLElement) ? c.remove() : stack.push(c as HTMLElement);
  return doc;
}

/** What a browser resolves the page's links against: its first `<base href>`, else its own address. */
function documentBase(doc: HTMLElement, url: string): string {
  const href = doc.querySelector("base[href]")?.getAttribute("href");
  try {
    return href ? new URL(href, url).href : url;
  } catch {
    return url;
  }
}

/**
 * `fields` values are "<css>" (text) or "<css>@attr"; an empty css means the item itself.
 * An "all:" prefix returns every match as a list (a book's genres, a post's tags), [] when none.
 * `base` (the page's final address, redirects included) makes `@href`/`@src` values usable as-is:
 * a relative link is resolved against it (or the page's `<base href>`), a scheme-carrying value stays.
 */
export function extractHtml(
  body: string,
  recipe: { items: string; fields: Record<string, string> },
  base?: string,
): Record<string, string | string[] | undefined>[] {
  const doc = parseShown(body);
  base &&= documentBase(doc, base);
  return doc.querySelectorAll(recipe.items).map((el) => {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [name, field] of Object.entries(recipe.fields)) {
      const all = field.startsWith("all:");
      const sel = all ? field.slice(4) : field;
      const m = /^(.*?)@([\w:-]+)$/.exec(sel);
      const css = (m ? m[1]! : sel).trim();
      const value = (t: HTMLElement): string | undefined => {
        const raw = m ? t.getAttribute(m[2]!) : t.text.replace(/\s+/g, " ").trim();
        return raw && base && m ? address(raw, m[2]!, base) : raw;
      };
      if (all) out[name] = (css ? el.querySelectorAll(css) : [el]).map(value).filter((v): v is string => !!v);
      else {
        const target = css ? el.querySelector(css) : el;
        out[name] = target ? value(target) : undefined;
      }
    }
    return out;
  });
}

/** JSON embedded in a document; the regex's group 1 marks where the JSON value starts. */
export function extractEmbedded(body: string, regex: string): unknown {
  const m = new RegExp(regex, "d").exec(body);
  if (!m || m[1] === undefined) return undefined;
  const start = m.indices![1]![0];
  try {
    return parseJson(body.slice(start, jsonValueEnd(body, start)));
  } catch {
    try {
      return parseJson(m[1]);
    } catch {
      return undefined;
    }
  }
}

/** Body -> extracted value per the op's response spec. Undefined when the extract path is missing. */
export function extract(res: ResponseSpec, body: string, base?: string): unknown {
  let data: unknown;
  if (res.format === "html") data = res.html ? extractHtml(body, res.html, base) : body;
  else if (res.format === "embedded") data = res.embedded ? extractEmbedded(body, res.embedded.regex) : undefined;
  else data = parseBody(body, res.xssiPrefix);
  if (res.extract && data !== undefined) data = getPath(data, res.extract);
  if (res.pick?.length && data !== undefined) data = pick(data, res.pick);
  return data;
}

const size = (v: unknown) => (JSON.stringify(v) ?? "null").length;
// A member at most this big is kept whole or dropped, never shortened: a number or a short string can't be.
const ATOM = 200;

/**
 * v in at most `budget` JSON chars: strings cut, arrays cut at an item boundary (never below one
 * item while one fits), objects keep their members in order with the biggest ones shortened to a
 * common cap, then drop trailing members. undefined when not even an empty container fits.
 */
function cut(v: unknown, budget: number, total = size(v)): unknown {
  if (total <= budget) return v;
  if (typeof v === "string") {
    let s = v.slice(0, Math.max(0, budget - 2));
    while (s && size(s) > budget) s = s.slice(0, s.length - Math.max(1, size(s) - budget));
    return size(s) <= budget ? s : undefined;
  }
  if (budget < 2) return undefined;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    let used = 2;
    for (const item of v) {
      const n = size(item);
      if (used + n + (out.length ? 1 : 0) > budget) {
        if (!out.length) {
          const one = cut(item, budget - 2, n);
          if (one !== undefined) out.push(one);
        }
        break;
      }
      out.push(item);
      used += n + (out.length > 1 ? 1 : 0);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    // one pass for every member's size: "key":value
    const cost = entries.map(([k, x]) => ({ key: size(k) + 1, value: size(x) }));
    // Water-fill: the largest cap (>= ATOM) at which every member fits, members above it shortened.
    const room = budget - 2 - Math.max(0, entries.length - 1);
    const sorted = cost.map((c) => c.key + c.value).sort((a, b) => a - b);
    let cap = Infinity;
    let below = 0;
    for (let i = 0; i < sorted.length; i++) {
      const left = sorted.length - i;
      if (below + sorted[i]! * left > room) {
        cap = Math.max(Math.min(ATOM, budget - 2), Math.floor((room - below) / left));
        break;
      }
      below += sorted[i]!;
    }
    const out: Record<string, unknown> = {};
    let used = 2;
    for (let i = 0; i < entries.length; i++) {
      const [k, x] = entries[i]!;
      const c = cost[i]!;
      const value = c.key + c.value <= cap ? x : cut(x, cap - c.key, c.value);
      if (value === undefined) continue;
      const n = c.key + (value === x ? c.value : size(value)) + (used > 2 ? 1 : 0);
      // ponytail: once the members stop fitting the rest are dropped; the note counts them
      if (used + n > budget) break;
      out[k] = value;
      used += n;
    }
    return out;
  }
  return undefined;
}

/**
 * Hard cap on what goes back to the agent: the result is never over maxChars. Arrays are cut at an
 * item boundary, and an item too big on its own is cut rather than dropped, so the output never
 * reads as "no results". Strings are cut as strings; objects stay objects (their biggest members
 * shortened, then trailing members dropped), never cut JSON text. The note says what was cut.
 */
export function capOutput(
  value: unknown,
  maxChars = 20_000,
  hint = "narrow with pick or extract",
): { data: unknown; truncated?: string } {
  const total = size(value);
  if (total <= maxChars) return { data: value };
  const data = cut(value, maxChars, total) ?? null;
  if (Array.isArray(value)) {
    const n = (data as unknown[]).length;
    const whole = n > 0 && (data as unknown[])[n - 1] === value[n - 1];
    return {
      data,
      truncated: `showing ${n} of ${value.length} items${n && !whole ? " (the last one cut to fit)" : ""} (cap ${maxChars} chars); ${hint}`,
    };
  }
  if (value && typeof value === "object" && data && typeof data === "object") {
    const all = Object.keys(value);
    const kept = Object.keys(data);
    const shortened = kept.filter(
      (k) => (data as Record<string, unknown>)[k] !== (value as Record<string, unknown>)[k],
    ).length;
    return {
      data,
      truncated: `cut to ${size(data)} of ${total} chars (cap ${maxChars}): showing ${kept.length} of ${all.length} keys${shortened ? `, ${shortened} of them shortened` : ""}; ${hint}`,
    };
  }
  return { data, truncated: `cut to ${size(data)} of ${total} chars (cap ${maxChars}); ${hint}` };
}

// numeric ids, short upper-case codes (SFO, US), and ids with digits (item-85809106, u_123)
const ID_KEY = /^(\d+|[A-Z0-9]{2,5}|[\w:.-]*\d[\w:.-]*)$/;

/**
 * Key paths -> types (first array item only; an id-keyed map as "*"), for drift detection.
 * `optional` (a learned answer's): a path of a first item that another item of its list lacks is
 * typed "null", as a value learned null is, so its absence later is no drift.
 */
export function inferShape(value: unknown, maxPaths = 200, optional = false): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  const visit = (v: unknown, path: string, depth: number) => {
    if (n >= maxPaths) return;
    const type = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    if (path) {
      out[path] = type;
      n++;
    }
    if (depth >= 6) return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      const at = `${path}[]`;
      const before = new Set(Object.keys(out));
      visit(v[0], at, depth + 1);
      if (!optional || v[0] === null || typeof v[0] !== "object") return;
      const own = Object.keys(out).filter((k) => !before.has(k) && k !== at);
      for (const item of v.slice(1)) {
        if (item === null || typeof item !== "object") continue;
        const has = inferShape(item, maxPaths);
        for (const k of own) {
          const rel = k.slice(at.length).replace(/^\./, "");
          if (!(rel in has)) out[k] = "null";
        }
      }
    } else if (type === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      // An id-keyed map (airports: {SFO: {...}}) has different keys for other args: its keys are "*".
      if (entries.length && entries.every(([k, c]) => ID_KEY.test(k) && c !== null && typeof c === "object")) {
        visit(entries[0]![1], path ? `${path}.*` : "*", depth + 1);
      } else {
        for (const [k, c] of entries) visit(c, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  visit(value, "", 0);
  return out;
}
