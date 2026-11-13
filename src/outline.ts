/**
 * The explorer's scout: a compact summary of what one captured response holds, so an agent can
 * choose a request and a response recipe without reading the body. Deterministic, no LLM, no
 * site-specific rules: JSON outlines, JSON embedded in a page (JSON-LD, __NEXT_DATA__, state
 * assignments), and repeated HTML items that carry an example value.
 */
import type { HTMLElement } from "node-html-parser";
import { extractEmbedded, getPath, innerJson, parseBody, parseShown, tagsOf } from "./extract.js";
import { suggestExtract } from "./learn.js";

export type JsonOutline = {
  /** paths where an example value appears */
  at?: string[];
  /** suggested --extract */
  extract?: string;
  /** field path (under extract, per item) -> sample value, for --pick */
  fields: Record<string, string>;
  /** object keys on the way to an example that look like ids: a path through them won't generalize */
  varyingKeys?: string[];
};
export type HtmlList = { items: string; count: number; fields: Record<string, string>; sample: Record<string, string> };
export type Outline = {
  json?: JsonOutline;
  embedded?: (JsonOutline & { regex: string })[];
  list?: HtmlList;
  /** a page with no repeated list: short labelled texts (css -> sample) for --html '{"items":"body",...}' */
  labels?: Record<string, string>;
};

const MAX_FIELDS = 30;
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function sample(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(clip(v.replace(/\s+/g, " ")));
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    return `{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}}`;
  }
  return String(v);
}

/** `path` one key deeper, in getPath syntax */
export const step = (path: string, k: string) =>
  /^[A-Za-z_$][\w$-]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`;
// an id-like key: digits, or a URN/URL-ish value (Apollo's "Book:kca://book/...", "User:123")
const idLike = (k: string) => /\d{3,}|[:/]/.test(k);

/** Paths (getPath syntax) to string leaves containing an example value, stepping into JSON strings. */
function findPaths(root: unknown, values: string[], max = 5): string[] {
  const out: string[] = [];
  const queue: { v: unknown; path: string; depth: number }[] = [{ v: root, path: "", depth: 0 }];
  for (let head = 0; head < queue.length && out.length < max; head++) {
    const { v, path, depth } = queue[head]!;
    if (typeof v === "string") {
      const inner = innerJson(v);
      if (inner && typeof inner === "object") queue.push({ v: inner, path, depth });
      else if (values.some((x) => v.toLowerCase().includes(x))) out.push(path);
      continue;
    }
    if (depth > 12 || !v || typeof v !== "object") continue;
    const entries: [string, unknown][] = Array.isArray(v)
      ? v.slice(0, 100).map((c, i) => [`${path}[${i}]`, c])
      : Object.entries(v).map(([k, c]) => [step(path, k), c]);
    for (const [p, c] of entries) queue.push({ v: c, path: p, depth: depth + 1 });
  }
  return out;
}

/** Leaf paths of one item (arrays as [*]) with samples. */
function fieldsOf(item: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (v: unknown, path: string, depth: number) => {
    if (Object.keys(out).length >= MAX_FIELDS) return;
    if (typeof v === "string") {
      const inner = innerJson(v);
      if (inner && typeof inner === "object" && depth < 4) return visit(inner, path, depth);
    }
    if (v && typeof v === "object" && depth < 4) {
      if (Array.isArray(v)) {
        if (path) out[path] = sample(v);
        if (v.length && v[0] && typeof v[0] === "object") visit(v[0], `${path}[*]`, depth + 1);
        return;
      }
      for (const [k, c] of Object.entries(v)) visit(c, step(path, k), depth + 1);
      return;
    }
    if (path) out[path] = sample(v);
  };
  visit(item, "", 0);
  return out;
}

export function outlineJson(root: unknown, values: string[]): JsonOutline {
  const at = findPaths(root, values);
  // suggestExtract falls back to the biggest array; for an outline, only a path holding the example counts
  const suggested = suggestExtract(root, values);
  const carries = (v: unknown) => values.some((x) => (JSON.stringify(v) ?? "").toLowerCase().includes(x));
  const extract = suggested && carries(getPath(root, suggested)) ? suggested : undefined;
  const target = getPath(root, extract);
  const fields = fieldsOf(Array.isArray(target) ? target[0] : target);
  const varyingKeys = [
    ...new Set(
      at.flatMap((p) =>
        [...p.matchAll(/\["((?:[^"\\]|\\.)*)"\]/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).filter(idLike),
      ),
    ),
  ];
  return {
    ...(at.length ? { at } : {}),
    ...(extract ? { extract } : {}),
    fields,
    ...(varyingKeys.length ? { varyingKeys: varyingKeys.slice(0, 3) } : {}),
  };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regexes (for --embedded, group 1 at the JSON's start) for JSON blocks a page embeds. */
export function embeddedBlocks(body: string): string[] {
  const out: string[] = [];
  // one script tag at a time (`tagsOf`): its attributes, then what follows its `>`
  for (const { at, text } of tagsOf(body, "script")) {
    const attrs = text.slice("<script".length);
    let after = at + text.length;
    if (!text.startsWith("<script") || /^\w/.test(attrs) || body[after] !== ">") continue;
    do after++;
    while (/\s/.test(body[after] ?? ""));
    if (body[after] !== "[" && body[after] !== "{") continue;
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (/application\/ld\+json/i.test(attrs)) {
      const type = /"@type"\s*:\s*"([^"]+)"/.exec(body.slice(at, at + 400))?.[1];
      out.push(`application/ld\\+json[^>]*>\\s*(\\{)${type ? `(?=[^<]*?"@type"\\s*:\\s*"${escapeRe(type)}")` : ""}`);
    } else if (id && /application\/json/i.test(attrs)) out.push(`id="${escapeRe(id)}"[^>]*>\\s*([[{])`);
  }
  for (const m of body.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=\s*([[{])/g))
    out.push(`window\\.${escapeRe(m[1]!)}\\s*=\\s*([[{])`);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- HTML lists

const SKIP = new Set(["script", "style", "noscript", "head", "title", "meta", "svg", "template"]);
const tag = (el: HTMLElement) => el.rawTagName?.toLowerCase() ?? "";
// class names a build tool generated (css-1x2y3z, sc-abc, Foo__bar_3kd9f) change between deploys
const stableClass = (c: string) =>
  /^[A-Za-z][\w-]*$/.test(c) &&
  !/^(css|sc|jsx|svelte|tw)-/.test(c) &&
  !/\d{3,}|[_-](?=(?:[a-z]*\d){2})[a-z0-9]{5,}$/i.test(c);

// a data-testid that embeds a record id ("book-item-kca://book/...") differs per record
const stableTestid = (t: string | undefined): t is string => !!t && !/\d{3,}|[:/]/.test(t);

/** A short selector for an element: its data-testid, else tag.firstStableClass, else tag. */
export function sig(el: HTMLElement): string {
  const tid = el.getAttribute("data-testid");
  if (stableTestid(tid)) return `[data-testid="${tid}"]`;
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).find(stableClass);
  return cls ? `${tag(el)}.${cls}` : tag(el);
}

const elementChildren = (el: HTMLElement) => el.childNodes.filter((c): c is HTMLElement => c.nodeType === 1);
const textOf = (el: HTMLElement) => el.text.replace(/\s+/g, " ").trim();

const labelled = (el: HTMLElement) =>
  stableTestid(el.getAttribute("data-testid")) || (el.getAttribute("class") ?? "").split(/\s+/).some(stableClass);

function nameFor(el: HTMLElement, used: Set<string>, attr?: string): string {
  const raw =
    (stableTestid(el.getAttribute("data-testid")) ? el.getAttribute("data-testid") : undefined) ??
    (el.getAttribute("class") ?? "").split(/\s+/).filter(stableClass).at(-1) ??
    tag(el);
  // the last two words name it: "book-item-ratings-count" -> ratingsCount, "BookStats__rating" -> bookStatsRating;
  // a microformat's prefix is no word ("u-url", "p-name", "dt-published")
  const words = raw
    .replace(/^(?:h|p|u|dt|e)-/, "")
    .split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .slice(-2);
  let base = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase())).join("") || tag(el);
  // a link classed as the link: its text is the title and its href the url ("u-url", "story-link")
  const linkish = tag(el) === "a" && /(?:^|[a-z])(?:url|link|href)$/i.test(base);
  if (linkish) base = attr === "href" ? "url" : "title";
  else if (attr === "href") base = /url$/i.test(base) ? base : `${base}Url`;
  if (attr === "src") base = `${base}Image`;
  if (attr === "aria-label") base = `${base}Label`;
  let name = base,
    n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

/** A selector that finds `el` first inside `item`: its own label, else its nearest labelled ancestor's plus its tag. */
function selectorIn(item: HTMLElement, el: HTMLElement): { css: string; named: HTMLElement } | undefined {
  const own = sig(el);
  if (labelled(el) && item.querySelector(own) === el) return { css: own, named: el };
  for (let a = el.parentNode as HTMLElement | null; a && a !== item; a = a.parentNode as HTMLElement | null) {
    if (!labelled(a)) continue;
    const css = `${sig(a)} ${own}`;
    if (item.querySelector(css) === el) return { css, named: a };
  }
  return undefined;
}

/** Fields inside one item: short texts and links, each with a selector that finds that element first. */
function itemFields(item: HTMLElement, items: HTMLElement[]): Pick<HtmlList, "fields" | "sample"> {
  const fields: Record<string, string> = {},
    sampleOut: Record<string, string> = {},
    used = new Set<string>(),
    seen = new Set<string>();
  const add = (el: HTMLElement, attr?: "href" | "src" | "aria-label") => {
    if (Object.keys(fields).length >= 14) return;
    const at = selectorIn(item, el);
    if (!at) return;
    const sel = attr ? `${at.css}@${attr}` : at.css;
    const value = attr ? el.getAttribute(attr) : textOf(el);
    if (seen.has(sel) || !value || value.length > 160) return;
    // a field most items lack is a badge or an ad, not data
    if (items.filter((it) => it.querySelector(at.css)).length < items.length / 2) return;
    seen.add(sel);
    const name = nameFor(at.named, used, attr);
    fields[name] = sel;
    sampleOut[name] = clip(value, 80);
  };
  for (const el of item.querySelectorAll("*")) {
    if (SKIP.has(tag(el)) || tag(el) === "button") continue;
    if (tag(el) === "a" && el.getAttribute("href")) add(el, "href");
    if (tag(el) === "img" && el.getAttribute("src")) add(el, "src");
    // icons carry values only in their label: "Rating 4 out of 5"
    const label = el.getAttribute("aria-label");
    if (label && label.length <= 80 && /\d/.test(label) && label !== textOf(el)) add(el, "aria-label");
    if (el.childNodes.some((c) => c.nodeType === 3 && c.text.trim())) add(el);
  }
  return { fields, sample: sampleOut };
}

/** The repeated item (3+ siblings alike) that holds an example value, as an --html recipe. */
export function outlineHtmlList(root: HTMLElement, values: string[]): HtmlList | undefined {
  const hits = root.querySelectorAll("*").filter((el) => {
    if (SKIP.has(tag(el))) return false;
    const t = textOf(el).toLowerCase();
    return (
      values.some((v) => t.includes(v)) &&
      !elementChildren(el).some((c) => values.some((v) => textOf(c).toLowerCase().includes(v)))
    );
  });
  for (const hit of hits.slice(0, 20)) {
    for (
      let a: HTMLElement | null = hit, depth = 0;
      a?.parentNode && depth < 14;
      a = a.parentNode as HTMLElement, depth++
    ) {
      const p = a.parentNode as HTMLElement;
      if (!p || !tag(p)) break;
      const s = sig(a);
      const siblings = elementChildren(p).filter((c) => sig(c) === s);
      if (siblings.length < 3) continue;
      const gp = p.parentNode as HTMLElement | null;
      const options = [s, `${sig(p)} > ${s}`, ...(gp && tag(gp) ? [`${sig(gp)} > ${sig(p)} > ${s}`] : [])];
      const items = options.find((o) => root.querySelectorAll(o).length === siblings.length);
      if (!items) continue;
      return { items, count: siblings.length, ...itemFields(a, siblings) };
    }
  }
  return undefined;
}

/**
 * Labelled short texts on a page with no list (a detail page): css -> sample. A labelled element
 * holding 3+ alike children (a book's genres) also gets an "all:" field listing every child.
 */
function outlineLabels(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of root.querySelectorAll("[data-testid]")) {
    if (Object.keys(out).length >= 30) break;
    const css = sig(el);
    if (!stableTestid(el.getAttribute("data-testid")) || css in out || root.querySelector(css) !== el) continue;
    const t = textOf(el);
    if (t && t.length <= 160) out[css] = JSON.stringify(clip(t, 80));
    const counts = new Map<string, string[]>();
    for (const d of el.querySelectorAll("*")) {
      const s = sig(d),
        txt = textOf(d);
      if (s !== tag(d) && txt && txt.length <= 60) counts.set(s, [...(counts.get(s) ?? []), txt]);
    }
    const [child, texts] =
      [...counts].filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (child) out[`all:${css} ${child}`] = JSON.stringify(texts!.slice(0, 4).map((x) => clip(x, 30)));
  }
  return out;
}

/** Outline a response body. `values` are the example values (matched case-insensitively). */
export function outline(contentType: string, body: string, examples: string[]): Outline | undefined {
  const values = examples.map((v) => v.toLowerCase()).filter((v) => v.length >= 3);
  if (!/html/i.test(contentType)) {
    try {
      const data = parseBody(body);
      return data && typeof data === "object" ? { json: outlineJson(data, values) } : undefined;
    } catch {
      return undefined;
    }
  }
  const embedded = embeddedBlocks(body).flatMap((regex) => {
    const data = extractEmbedded(body, regex);
    if (!data || typeof data !== "object") return [];
    const o = outlineJson(data, values);
    // JSON-LD is small and schema.org-stable, so it is always worth showing; other blocks only when they carry an example
    return o.at || regex.startsWith("application/ld") ? [{ regex, ...o }] : [];
  });
  const root = parseShown(body);
  const list = values.length ? outlineHtmlList(root, values) : undefined;
  const labels = list ? undefined : outlineLabels(root);
  return {
    ...(embedded.length ? { embedded: embedded.slice(0, 4) } : {}),
    ...(list ? { list } : {}),
    ...(labels && Object.keys(labels).length ? { labels } : {}),
  };
}
