/**
 * JSON Schemas of api-anything's answers: MCP's `outputSchema`s, and any other interface that
 * describes them. A client that validates rejects an answer its schema does not match, so every
 * schema here is permissive: no object sets `additionalProperties` (JSON Schema's default allows
 * fields it does not name), a field is required only when every answer carries it (success,
 * failure, a pending job and a cut answer alike), and a type is given only where the code that
 * builds the value fixes it. A tool list is sent with every request, so they name fields and types
 * and leave the prose to the tools' descriptions. Plain draft-07 with no `type` lists or `const`, so
 * an OpenAPI 3.0 document can embed them too.
 *
 * A validated schema (an MCP outputSchema) never constrains `data`: it is fixed when the server
 * starts, while each call runs the spec as it is then, so a schema that typed the spec's output
 * could reject a good answer after a re-add or a heal. Only the envelope, which the code's own
 * types fix, is typed. `opDataSchema` describes `data` for documentation only.
 */
import type { Class } from "./classify.js";
import { outputOf } from "./describe.js";
import type { NextAction, Retry, Tier } from "./execute.js";
import { hasWildcard, pickEntry, returnedFields } from "./extract.js";
import type { Operation } from "./spec.js";
import type { WriteStatus } from "./store.js";

export type JsonSchema = Record<string, unknown>;

/** `list` as an enum's values; tsc fails when T gains a member the list lacks. */
const every =
  <T extends string | number>() =>
  <const L extends readonly T[]>(
    list: L & ([Exclude<T, L[number]>] extends [never] ? unknown : { missing: Exclude<T, L[number]> }),
  ): T[] => [...list];

const str: JsonSchema = { type: "string" };
const bool: JsonSchema = { type: "boolean" };
const num: JsonSchema = { type: "number" };
const strings: JsonSchema = { type: "array", items: str };
const anyObject: JsonSchema = { type: "object" };
const objects: JsonSchema = { type: "array", items: anyObject };
const oneOf = (values: (string | number)[]): JsonSchema => ({
  type: typeof values[0] === "number" ? "integer" : "string",
  enum: values,
});
const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
/** `base` with more properties: they win over the base's of the same name. */
const extend = (base: JsonSchema, properties: Record<string, JsonSchema>): JsonSchema => ({
  ...base,
  properties: { ...(base.properties as Record<string, JsonSchema>), ...properties },
});

/** Every class an answer can carry: call()'s, a write's refusals, and a job still running. */
const CLASS = oneOf(
  every<Class | "refused" | "duplicate" | "pending">()([
    "ok",
    "drift",
    "auth",
    "rate",
    "blocked",
    "input",
    "error",
    "refused",
    "duplicate",
    "pending",
  ]),
);
const WRITE = oneOf(every<WriteStatus>()(["not_sent", "not_applied", "accepted", "applied", "may_have_applied"]));
const RETRY = oneOf(every<Retry>()(["no", "safe", "after_wait", "after_fix"]));
const TIER = oneOf(every<Tier>()([1, 2, 3]));

/** `nextCall`: `next` as data. Over MCP it also names the tool and args that take the step; some name only those. */
export const NEXT_CALL_SCHEMA: JsonSchema = object({
  // call()'s steps, and MCP's get_job for a job still running
  action: oneOf(
    every<NextAction | "get_job">()([
      "retry",
      "login",
      "sign_in_browser",
      "heal",
      "relearn",
      "fix_args",
      "list_sites",
      "check_site",
      "allow_writes",
      "raise_tier",
      "install_browser",
      "report",
      "get_job",
    ]),
  ),
  site: str,
  op: str,
  mode: oneOf(["window"]),
  tier: TIER,
  profile: str,
  tool: str,
  args: anyObject,
});

/** A cut answer's rest, kept locally: get_result takes it as it is. */
const MORE = object(
  {
    resultId: str,
    offset: { type: "integer", minimum: 0 },
    format: oneOf(["json"]),
    fields: strings,
    maxChars: { type: "integer" },
  },
  ["resultId", "offset"],
);

/**
 * A call's result (`call()`'s CallResult; over MCP also a pending job's answer and a tool's own
 * failure, `{ok: false, error, next}`), with `data` unconstrained. Only `ok` is required. One
 * object, shared by every tool that answers with it.
 */
export const CALL_RESULT_SCHEMA: JsonSchema = object(
  {
    ok: bool,
    class: CLASS,
    data: {},
    tier: TIER,
    ms: num,
    reason: str,
    next: str,
    nextCall: NEXT_CALL_SCHEMA,
    retry: RETRY,
    retryAfterMs: num,
    write: WRITE,
    nextPage: { anyOf: [str, num] },
    hasMore: bool,
    truncated: str,
    resultId: str,
    more: MORE,
    healed: bool,
    heal: object({ strategy: oneOf(["rescan", "recapture", "registry"]), changes: strings }, ["strategy", "changes"]),
    server: bool,
    cooling: bool,
    job: str,
    error: str,
  },
  ["ok"],
);

/**
 * `CALL_RESULT_SCHEMA`, with `data` described by `dataSchema` (as `opDataSchema` builds it) when one
 * is given. For documentation: never pass it to a client that validates (see the header).
 */
export function callResultSchema(dataSchema?: JsonSchema): JsonSchema {
  return dataSchema ? extend(CALL_RESULT_SCHEMA, { data: dataSchema }) : CALL_RESULT_SCHEMA;
}

/**
 * A description of a read's `data` on success, from its response recipe alone: never a sample and
 * never the learned shape, which one capture inferred. Descriptive, not a contract: no answer is
 * validated against it, and it describes the stored recipe's whole answer, not a `view.fields`
 * projection. A list when the recipe always makes one (an HTML recipe's items, an extract path
 * through a `[*]` step); the fields its pick or HTML recipe names, typed where the recipe fixes the
 * type (a regex's string, an HTML field's text or `all:` list, a path through `[*]`'s list). A field
 * the site leaves out is absent, so none is required, and a field two picks write is left untyped.
 * `{}` when the recipe names no fields and makes no list, and for a write, whose answer is the
 * site's acknowledgement (a 204 has none).
 */
export function opDataSchema(op: Pick<Operation, "response" | "readOnly">): JsonSchema {
  if (!op.readOnly) return {};
  const r = op.response;
  const htmlItems = r.format === "html" && !!r.html && !r.extract;
  const list = htmlItems || (!!r.extract && hasWildcard(r.extract));
  const names = returnedFields(r);
  if (!names && !list) return {};
  const { fields } = outputOf(r);
  const writes = new Map<string, number>();
  for (const p of r.pick ?? []) {
    const { name } = pickEntry(p);
    writes.set(name, (writes.get(name) ?? 0) + 1);
  }
  const properties = names
    ? Object.fromEntries(
        [...new Set(names)].map((n) => {
          const hint = Object.hasOwn(fields, n) ? fields[n] : undefined;
          const typed = hint?.source === "declared" && hint.type && (writes.get(n) ?? 1) === 1;
          return [n, typed ? { type: hint.type } : {}];
        }),
      )
    : undefined;
  // a pick keeps a non-object item as it is; only an HTML recipe's items are always objects
  const item: JsonSchema = properties ? { ...(htmlItems ? { type: "object" } : {}), properties } : {};
  if (list) return { type: "array", items: item };
  // a pick applies to each item of a list, and to an object as a whole: no type, both described
  return { properties, items: item };
}

/** call_batch: `{ok, results}`, each result a call's with the item's id, site and op; a pending job's answer; or the tool's own failure. */
export function callBatchSchema(): JsonSchema {
  const item = extend(CALL_RESULT_SCHEMA, { id: { anyOf: [str, num] }, site: str, op: str });
  return object(
    {
      ok: bool,
      class: CLASS,
      results: { type: "array", items: { ...item, required: ["ok", "id", "site", "op"] } },
      job: str,
      reason: str,
      next: str,
      retry: RETRY,
      nextCall: NEXT_CALL_SCHEMA,
      error: str,
    },
    ["ok"],
  );
}

/** get_result: a slice of a kept answer, or why there is none; with encoding json, data is a fragment of its JSON text. */
export function getResultSchema(): JsonSchema {
  return object(
    {
      ok: bool,
      class: CLASS,
      data: {},
      reason: str,
      truncated: str,
      resultId: str,
      more: MORE,
      encoding: oneOf(["json"]),
    },
    ["ok"],
  );
}

/** get_job: the answer of the tool the job ran (a call, a batch, a login, a learn), or pending again. */
export function jobResultSchema(): JsonSchema {
  return extend(CALL_RESULT_SCHEMA, { results: objects });
}

/** list_operations: a site's ops; with prepare, a nextCall only. No field is in every answer. */
export function listOperationsSchema(): JsonSchema {
  const op = object(
    {
      name: str,
      description: str,
      write: bool,
      status: str,
      returns: strings,
      pages: str,
      readback: str,
      inputSchema: anyObject,
      output: anyObject,
      links: objects,
    },
    ["name", "inputSchema", "output"],
  );
  return object({
    site: str,
    pulled: object({ from: str, warnings: strings }),
    operations: { type: "array", items: op },
    shared: str,
    notes: str,
    nextCall: NEXT_CALL_SCHEMA,
    ok: bool,
    class: CLASS,
    reason: str,
    error: str,
    next: str,
    missing: bool,
  });
}

/** find_sites: matches, best first. */
export function findSitesSchema(): JsonSchema {
  const match = object({
    site: str,
    domain: str,
    displayName: str,
    description: str,
    installed: bool,
    operations: objects,
    interfaces: objects,
    matched: strings,
    unmatched: strings,
  });
  return object({
    matches: { type: "array", items: match },
    registryError: str,
    localOnly: str,
    shared: str,
    next: str,
    nextCall: NEXT_CALL_SCHEMA,
    ok: bool,
    error: str,
  });
}

/** site_status: this machine's record of each site's ops. */
export function siteStatusSchema(): JsonSchema {
  return object(
    {
      ok: bool,
      storage: anyObject,
      sites: { type: "array", items: object({ site: str, cooling: anyObject, ops: objects }) },
      problems: { type: "array", items: object({ site: str, op: str, problem: str, detail: str, next: str }) },
      error: str,
      next: str,
    },
    ["ok"],
  );
}

/** login: how a sign-in went, or a job while its window is open. `renewed` is a list in window mode, a boolean on an import. */
export function loginSchema(): JsonSchema {
  return object({
    ok: bool,
    site: str,
    source: str,
    profile: str,
    profileName: str,
    cookies: strings,
    loggedIn: bool,
    renewed: {},
    warning: str,
    error: str,
    reason: str,
    next: str,
    class: CLASS,
    job: str,
    retry: RETRY,
    nextCall: NEXT_CALL_SCHEMA,
  });
}

/** learn_site: the user's answer in data, the new op's signature, and how it was chosen and proved; or a pending job's answer. */
export function learnSiteSchema(): JsonSchema {
  return object(
    {
      ok: bool,
      class: CLASS,
      site: str,
      op: str,
      signature: str,
      data: {},
      truncated: str,
      chosen: anyObject,
      paging: anyObject,
      nextPage: { anyOf: [str, num] },
      hasMore: bool,
      alternatives: objects,
      proof: anyObject,
      shared: anyObject,
      reused: object({ site: str, op: str, status: str }),
      warnings: strings,
      captures: strings,
      saved: str,
      job: str,
      reason: str,
      retry: RETRY,
      error: str,
      next: str,
      nextCall: NEXT_CALL_SCHEMA,
    },
    ["ok"],
  );
}
