/**
 * What changed between two answers of one read: items added, removed and changed in a list, told apart
 * by a key; or the leaf paths of an object. Pure: the answers come from `snapshots.ts`.
 */
import { createHash } from "node:crypto";
import { getPath } from "./extract.js";

/** One item of a list whose key is in both answers, with another value now. */
export interface ChangedItem {
  key: string;
  item: unknown;
  /** the paths in the item whose value differs, a path new in the item included */
  fields: string[];
  /** the earlier value at each of `fields` that the earlier item had */
  was: Record<string, unknown>;
}

export interface LeafChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

export type Changes =
  | { first: true }
  | {
      /** when the answer compared with was taken */
      since: string;
      /** a list: the items; one object: `{path, to}` */
      added: unknown[];
      /** a list: the earlier items; one object: `{path, from}` */
      removed: unknown[];
      changed: ChangedItem[] | LeafChange[];
      /** items (or an object's leaf paths) that are the same */
      unchanged: number;
      /** a list: the field items are told apart by; `hash` when none identifies them */
      key?: string;
      truncated?: string;
    };

/** Fields that name an item on most sites, tried in this order when the op declares no key. */
export const ID_FIELDS = ["id", "_id", "uuid", "guid", "objectID", "key", "slug", "url", "link", "href", "permalink"];

/** JSON with sorted keys: two answers that differ only in key order are the same. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x as object)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

const hashOf = (v: unknown) =>
  createHash("sha256")
    .update(canonical(v) ?? "undefined")
    .digest("hex")
    .slice(0, 12);

const id = (v: unknown): string | undefined =>
  (typeof v === "string" && v !== "") || (typeof v === "number" && Number.isFinite(v)) ? String(v) : undefined;

/** The field that tells the items apart: the declared one, else the first id-like one every item has, each value distinct. */
export function keyField(lists: unknown[][], declared?: string): string | undefined {
  if (declared) return declared;
  const all = lists.flat();
  if (!all.length) return undefined;
  return ID_FIELDS.find((f) =>
    lists.every((items) => {
      const seen = new Set<string>();
      for (const it of items) {
        const v = id(getPath(it, f));
        if (v === undefined || seen.has(v)) return false;
        seen.add(v);
      }
      return true;
    }),
  );
}

/** Each item's key: its field's value, else a hash of the item; a repeat gets `~2`, `~3`. */
function keysOf(items: unknown[], field?: string): string[] {
  const count = new Map<string, number>();
  return items.map((it) => {
    const base = (field !== undefined ? id(getPath(it, field)) : undefined) ?? `#${hashOf(it)}`;
    const n = (count.get(base) ?? 0) + 1;
    count.set(base, n);
    return n > 1 ? `${base}~${n}` : base;
  });
}

const step = (path: string, k: string) =>
  /^[A-Za-z_$][\w$-]*$/.test(k) ? (path ? `${path}.${k}` : k) : `${path}[${JSON.stringify(k)}]`;

/** An object's leaves by path; a list, a scalar or an empty object is one leaf. */
function leaves(v: unknown, path = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
    for (const [k, x] of Object.entries(v)) leaves(x, step(path, k), out);
  } else out.set(path || "$", v);
  return out;
}

function leafDiff(before: unknown, after: unknown) {
  const b = leaves(before);
  const a = leaves(after);
  const added: LeafChange[] = [];
  const removed: LeafChange[] = [];
  const changed: LeafChange[] = [];
  let unchanged = 0;
  for (const [path, to] of a) {
    if (!b.has(path)) added.push({ path, to });
    else if (canonical(b.get(path)) !== canonical(to)) changed.push({ path, from: b.get(path), to });
    else unchanged++;
  }
  for (const [path, from] of b) if (!a.has(path)) removed.push({ path, from });
  return { added, removed, changed, unchanged };
}

export interface Answer {
  /** the extracted answer, as kept */
  full: unknown;
  /** what the caller sees of it (its view's fields); for a list, one entry per item of `full` */
  shown: unknown;
}

/**
 * `after` against `before`. A list is compared item by item, each identified by a key read from the
 * full item (so a view without the key field still matches items), its shown part compared. Anything
 * else is compared by leaf path.
 */
export function changesOf(before: Answer, after: Answer, since: number, declared?: string): Changes {
  const at = new Date(since).toISOString();
  if (!Array.isArray(after.full) || !Array.isArray(before.full)) {
    return { since: at, ...leafDiff(before.shown, after.shown) };
  }
  const bFull = before.full;
  const aFull = after.full;
  const bShown = Array.isArray(before.shown) ? before.shown : bFull;
  const aShown = Array.isArray(after.shown) ? after.shown : aFull;
  const field = keyField([bFull, aFull], declared);
  const bKeys = keysOf(bFull, field);
  const aKeys = keysOf(aFull, field);
  const earlier = new Map(bKeys.map((k, i) => [k, bShown[i]]));
  const now = new Set(aKeys);
  const added: unknown[] = [];
  const changed: ChangedItem[] = [];
  let unchanged = 0;
  for (const [i, k] of aKeys.entries()) {
    const item = aShown[i];
    const was = earlier.get(k);
    if (!earlier.has(k)) added.push(item);
    else if (canonical(was) === canonical(item)) unchanged++;
    else {
      const d = leafDiff(was, item);
      const fields = [...d.changed, ...d.added, ...d.removed].map((c) => c.path);
      const old = Object.fromEntries([...d.changed, ...d.removed].map((c) => [c.path, c.from]));
      changed.push({ key: k, item, fields, was: old });
    }
  }
  const removed = bKeys.flatMap((k, i) => (now.has(k) ? [] : [bShown[i]]));
  return { since: at, added, removed, changed, unchanged, key: field ?? "hash" };
}

/**
 * Changes that fit `maxChars` of JSON: the longest of added, removed and changed loses its last
 * entries until they fit, and `truncated` counts what went. What is cut is not reported again: the
 * next call compares with this answer.
 */
export function capChanges(c: Changes, maxChars = 20_000): Changes {
  if ("first" in c || JSON.stringify(c).length <= maxChars) return c;
  const lists = { added: [...c.added], removed: [...c.removed], changed: [...c.changed] as unknown[] };
  const sizes = {
    added: lists.added.map((x) => JSON.stringify(x).length + 1),
    removed: lists.removed.map((x) => JSON.stringify(x).length + 1),
    changed: lists.changed.map((x) => JSON.stringify(x).length + 1),
  };
  const cut = { added: 0, removed: 0, changed: 0 };
  const names = ["added", "removed", "changed"] as const;
  const sums = {
    added: sizes.added.reduce((s, x) => s + x, 0),
    removed: sizes.removed.reduce((s, x) => s + x, 0),
    changed: sizes.changed.reduce((s, x) => s + x, 0),
  };
  // room for the note beside the lists
  let total = JSON.stringify({ ...c, added: [], removed: [], changed: [] }).length + 200;
  total += sums.added + sums.removed + sums.changed;
  while (total > maxChars) {
    const n = names.reduce((m, x) => (sums[x] > sums[m] ? x : m));
    if (!sizes[n].length) break;
    const size = sizes[n].pop()!;
    sums[n] -= size;
    total -= size;
    lists[n].pop();
    cut[n]++;
  }
  const said = names.filter((n) => cut[n]).map((n) => `${cut[n]} ${n}`);
  return {
    ...c,
    added: lists.added,
    removed: lists.removed,
    changed: lists.changed as ChangedItem[],
    truncated: `cut ${said.join(", ")} to fit maxChars; they are not reported again (the next call compares with this answer): narrow with view.fields or raise view.maxChars`,
  };
}
