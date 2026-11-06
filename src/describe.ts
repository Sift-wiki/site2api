/**
 * An operation's portable description: its args as JSON Schema, and what its result holds as far
 * as the spec says: the recipe's declared fields, else the stored learned shape. Never a call.
 */
import { shapeKey, underTarget } from "./classify.js";
import { pickEntry, returnedFields } from "./extract.js";
import type { Operation, OperationLink, Param, ResponseSpec, Site } from "./spec.js";

type JsonSchema = Record<string, unknown>;
export interface FieldHint {
  type?: string;
  source: "declared" | "observed" | "unknown";
}
export interface OutputHints {
  cardinality: "list" | "one" | "unknown";
  fields: Record<string, FieldHint>;
}
export interface OperationDescription {
  site: string;
  op: string;
  description?: string;
  readOnly: boolean;
  params: JsonSchema;
  output: OutputHints;
  links?: OperationLink[];
}

/** One param as JSON Schema: what call() accepts, so a client that validates refuses nothing call() would take. */
function paramSchema(p: Param): JsonSchema {
  const typed = (v: string) => {
    if (p.type === "number" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (p.type === "boolean" && (v === "true" || v === "false")) return v === "true";
    return v;
  };
  return {
    type: p.type,
    ...(p.description || p.hint ? { description: [p.description, p.hint].filter(Boolean).join("; format: ") } : {}),
    ...(p.enum ? { enum: p.enum.map(typed) } : {}),
    // a spec's pattern must match the whole value; a JSON Schema pattern matches anywhere in it
    ...(p.pattern !== undefined ? { pattern: `^(?:${p.pattern})$` } : {}),
    ...(p.min !== undefined ? { minimum: p.min } : {}),
    ...(p.max !== undefined ? { maximum: p.max } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.example !== undefined ? { examples: [p.example] } : {}),
  };
}

/** An op's args as a JSON Schema object: the description's `params`, MCP's `inputSchema`. */
export function inputSchema(op: Pick<Operation, "params">): JsonSchema {
  const required = op.params.filter((p) => p.required && p.default === undefined).map((p) => p.name);
  return {
    type: "object",
    properties: Object.fromEntries(op.params.map((p) => [p.name, paramSchema(p)])),
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * The learned shape keyed relative to the extracted value (`""` is the value itself), before the pick.
 * A `[*]` inside the extract path flattens one level, so its result is a list of what the path reaches.
 */
function extractedShape(r: ResponseSpec): Record<string, string> {
  const shape = r.shape ?? {};
  const ex = r.extract;
  const rel: Record<string, string> = {};
  for (const [k, t] of Object.entries(shape)) {
    const at = underTarget(ex, k);
    if (at !== undefined) rel[at] = t;
  }
  if (!ex) return rel;
  const own = shape[shapeKey(ex)];
  if (ex.endsWith("[*]") || !ex.includes("[*]")) return own ? { ...rel, "": ex.endsWith("[*]") ? "array" : own } : rel;
  if (own === "array") return { ...rel, "": "array" };
  // each reached value is one item of the flattened list
  if (own === "object")
    return Object.fromEntries([["", "array"], ...Object.entries(rel).map(([k, t]) => [`[].${k}`, t])]);
  return { "": "array" };
}

export function outputOf(r: ResponseSpec): OutputHints {
  const htmlItems = r.format === "html" && !!r.html && !r.extract;
  const rel = extractedShape(r);
  const keys = Object.keys(rel).filter((k) => k);
  const root = rel[""];
  const list = htmlItems || !!r.extract?.includes("[*]") || root === "array" || keys.some((k) => k.startsWith("[]"));
  const known = list || (root !== undefined && root !== "null") || keys.length > 0;
  const observed = (key: string): FieldHint => {
    const t = rel[key];
    // a learned null is also how the shape marks a field some items lack: no type to tell
    return t && t !== "null" ? { type: t, source: "observed" } : { source: "unknown" };
  };
  const fields: Record<string, FieldHint> = {};
  // a field named __proto__ must be an own key, not the prototype
  const set = (name: string, hint: FieldHint) =>
    Object.defineProperty(fields, name, { value: hint, enumerable: true, configurable: true, writable: true });
  for (const name of returnedFields(r) ?? []) set(name, { source: "unknown" });
  if (r.pick?.length) {
    for (const p of r.pick) {
      const { name, path, re } = pickEntry(p);
      const selector = htmlItems ? r.html!.fields[path] : undefined;
      const declared = re
        ? "string"
        : path.includes("[*]")
          ? "array"
          : selector !== undefined
            ? selector.startsWith("all:")
              ? "array"
              : "string"
            : undefined;
      set(name, declared ? { type: declared, source: "declared" } : observed(`${list ? "[]." : ""}${shapeKey(path)}`));
    }
  } else if (htmlItems) {
    for (const [name, selector] of Object.entries(r.html!.fields))
      set(name, { type: selector.startsWith("all:") ? "array" : "string", source: "declared" });
  } else {
    const item = list ? /^\[\]\.([^.[\]*]+)$/ : /^([^.[\]*]+)$/;
    for (const k of keys) {
      const m = item.exec(k);
      if (m) set(m[1]!, observed(k));
    }
  }
  return { cardinality: list ? "list" : known ? "one" : "unknown", fields };
}

/** What the spec says of one op: its args, its result's hints and its links. No request is sent. */
export function describeOperation(site: Site, name: string): OperationDescription {
  const op = site.operations.find((o) => o.name === name);
  if (!op) throw new Error(`no operation "${name}" on ${site.name}`);
  return {
    site: site.name,
    op: op.name,
    ...(op.description ? { description: op.description } : {}),
    readOnly: op.readOnly,
    params: inputSchema(op),
    output: outputOf(op.response),
    ...(op.links?.length ? { links: op.links } : {}),
  };
}
