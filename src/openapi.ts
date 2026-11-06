/**
 * The OpenAPI 3.1 document `serve` answers at /openapi.json: its generic endpoints, and one
 * concrete path per installed read, `POST /v1/call/<site>/<op>`, whose body's `args` is the op's
 * args schema and whose answer's `data` is what the spec says the op returns. An OpenAPI tool loader
 * (a custom GPT's actions, n8n, Postman) then offers each op as a typed call without a list step.
 */
import { describeOperation, inputSchema } from "./describe.js";
import type { Toolset } from "./mcp.js";
import { UNTRUSTED_NOTE } from "./mcp.js";
import type { Operation, Site } from "./spec.js";
import { listSites, loadSite, siteNotes } from "./store.js";
import { SHARED_NOTE } from "./vet.js";

type JsonSchema = Record<string, unknown>;

/** More concrete paths than this and the document is too big for a tool loader to read. */
export const MAX_OP_PATHS = 300;
/** A custom GPT refuses an operation description longer than 300 characters. */
const DESCRIPTION_MAX = 300;
const SUMMARY_MAX = 80;

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/**
 * The answer of a call as REST and MCP send it. Every field but `ok` is optional: a failure has no
 * data, a pending call has `job`, and a request the server could not run has `error` and `next`.
 */
export function callResultSchema(data: JsonSchema = {}): JsonSchema {
  const str = { type: "string" };
  return {
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean", description: "true: data answers the call" },
      class: {
        type: "string",
        description:
          "ok, drift, auth, rate, blocked, input, error, refused, duplicate or pending (follow job with GET /v1/jobs/{job})",
      },
      data,
      tier: { type: "integer", enum: [1, 2, 3], description: "1 plain HTTP, 2 and 3 the browser" },
      ms: { type: "number" },
      reason: str,
      next: { type: "string", description: "what to do about a failure; follow it at most once" },
      nextCall: { type: "object", description: "next as data" },
      retry: { type: "string", enum: ["no", "safe", "after_wait", "after_fix"] },
      retryAfterMs: { type: "number" },
      write: { type: "string", enum: ["not_sent", "not_applied", "accepted", "applied", "may_have_applied"] },
      nextPage: { type: ["string", "number"], description: "the paging param's value for the next page" },
      hasMore: { type: "boolean" },
      healed: { type: "boolean" },
      heal: { type: "object" },
      truncated: str,
      resultId: { type: "string", description: "read the rest with GET /v1/results/{resultId}" },
      more: { type: "object" },
      job: { type: "string", description: "a pending call's job: GET /v1/jobs/{job}" },
      error: str,
    },
  };
}

/**
 * What the spec says an op's `data` holds. A list of two or more records may come as
 * `{columns, rows}` (one row per item, null for a missing field) when that is shorter, as over MCP.
 */
export function opDataSchema(site: Site, op: Operation): JsonSchema {
  const { output } = describeOperation(site, op.name);
  const properties = Object.fromEntries(
    Object.entries(output.fields).map(([name, hint]) => [
      name,
      hint.type && JSON_TYPES.has(hint.type) ? { type: hint.type } : {},
    ]),
  );
  const named = Object.keys(properties).length > 0;
  const record = { type: "object", ...(named ? { properties } : {}) };
  const list = [
    { type: "array", items: record },
    {
      type: "object",
      required: ["columns", "rows"],
      properties: {
        columns: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: { type: "array" } },
      },
    },
  ];
  if (output.cardinality === "one") return record;
  if (output.cardinality === "list") return { anyOf: list };
  // the fields are known, not whether one item or a list of them comes back
  return named ? { anyOf: [record, ...list] } : {};
}

/**
 * A tool's schema with each tuple (`prefixItems`, `items: false`) as a plain array of any of its
 * item types, held to its length: many OpenAPI loaders read only `items`, and only as an object.
 */
function plainTuples(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(plainTuples);
  if (!s || typeof s !== "object") return s;
  const { prefixItems, ...rest } = s as JsonSchema;
  const out = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, plainTuples(v)]));
  if (!Array.isArray(prefixItems)) return out;
  const kinds = [...new Map(prefixItems.map((x) => [JSON.stringify(x), plainTuples(x)])).values()];
  return { ...out, items: kinds.length === 1 ? kinds[0] : { anyOf: kinds } };
}

/** `<site>__<op>` with anything outside [A-Za-z0-9_] as `_`, made unique with a numbered suffix. */
function operationIds() {
  const used = new Set<string>();
  return (raw: string) => {
    const base = raw.replace(/[^A-Za-z0-9_]/g, "_");
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return id;
  };
}

const json = (schema: JsonSchema, description = "the answer") => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: JsonSchema) => ({ required: true, content: { "application/json": { schema } } });
const errors = {
  "400": json({ $ref: "#/components/schemas/Error" }, "a malformed body or arguments its schema refuses"),
  "401": json({ $ref: "#/components/schemas/Error" }, "no token, or the wrong one"),
};
const pathParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
  description,
});
const queryParam = (name: string, schema: JsonSchema, description: string, required = false) => ({
  name,
  in: "query",
  required,
  schema,
  description,
});

const CALL_EXTRA: JsonSchema = {
  maxTier: { type: "integer", enum: [1, 2, 3], description: "highest tier to use; 1: plain HTTP, no browser" },
  maxAgeMs: { type: "integer", minimum: 0, description: "accepted; not used by this version" },
  changes: { type: "boolean", description: "accepted; not used by this version" },
  changesOnly: { type: "boolean", description: "accepted; not used by this version" },
};

export interface OpenApiOptions {
  /** the server's base URL, as clients reach it */
  url: string;
  version: string;
  allowWrites: boolean;
  learn: boolean;
  /** the sites whose reads get a concrete path; default every installed site */
  sites?: string[];
}

/** The document: generic endpoints from the tools' own schemas, and the installed reads as paths. */
export function openApiDocument(tools: Toolset, o: OpenApiOptions): JsonSchema {
  const view = (tools.schema("call_operation")?.properties as Record<string, JsonSchema> | undefined)?.view ?? {
    type: "object",
  };
  const callBody: JsonSchema = {
    type: "object",
    properties: {
      args: { type: "object", additionalProperties: true, description: "param name -> value" },
      view,
      ...CALL_EXTRA,
    },
    additionalProperties: false,
  };
  const result = { $ref: "#/components/schemas/CallResult" };
  const site = pathParam("site", "a site name from GET /v1/sites");
  const op = pathParam("op", "an operation name from GET /v1/sites/{site}");
  const id = operationIds();

  const paths: Record<string, Record<string, unknown>> = {
    "/v1/health": {
      get: {
        operationId: id("health"),
        summary: "Whether the server is up",
        security: [],
        responses: {
          "200": json({
            type: "object",
            required: ["ok", "version"],
            properties: { ok: { type: "boolean" }, version: { type: "string" } },
          }),
        },
      },
    },
    "/v1/sites": {
      get: {
        operationId: id("listSites"),
        summary: "List the websites api-anything can call",
        responses: { "200": json({ type: "array", items: { type: "object" } }), ...errors },
      },
    },
    "/v1/sites/{site}": {
      get: {
        operationId: id("listOperations"),
        summary: "A site's operations, each with its args' JSON Schema",
        description:
          "Each op with its inputSchema, output hints, links and the site's notes. A shared site not installed is pulled first, reads only.",
        parameters: [site],
        responses: { "200": json({ type: "object" }), ...errors },
      },
    },
    "/v1/find": {
      get: {
        operationId: id("findSites"),
        summary: "Find sites someone already turned into operations",
        description: "Words, a domain or a URL; best match first. Check a match's domain is the site the user means.",
        parameters: [queryParam("q", { type: "string" }, "words, a domain or a URL", true)],
        responses: { "200": json({ type: "object" }), ...errors },
      },
    },
    "/v1/call/{site}/{op}": {
      post: {
        operationId: id("callOperation"),
        summary: "Call a site's read operation",
        description:
          "HTTP 200 whenever the call ran: ok and class carry the outcome. class pending: follow job with GET /v1/jobs/{job}.",
        parameters: [site, op],
        requestBody: body(callBody),
        responses: { "200": json(result), ...errors },
      },
    },
    "/v1/batch": {
      post: {
        operationId: id("callBatch"),
        summary: "Call up to 20 reads of installed sites",
        requestBody: body({
          type: "object",
          required: ["calls"],
          properties: {
            calls: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                required: ["site", "op"],
                properties: {
                  id: { type: ["string", "number"] },
                  site: { type: "string" },
                  op: { type: "string" },
                  args: { type: "object", additionalProperties: true },
                },
              },
            },
            concurrency: { type: "integer", minimum: 1, maximum: 4 },
          },
          additionalProperties: false,
        }),
        responses: {
          "200": json({
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" }, results: { type: "array", items: result } },
          }),
          ...errors,
        },
      },
    },
    "/v1/jobs/{jobId}": {
      get: {
        operationId: id("getJob"),
        summary: "Wait up to about 25 s for a pending call's result",
        parameters: [pathParam("jobId", "the job from a pending answer")],
        responses: { "200": json(result), ...errors },
      },
    },
    "/v1/results/{resultId}": {
      get: {
        operationId: id("getResult"),
        summary: "Read more of a cut answer, locally",
        parameters: [
          pathParam("resultId", "a cut answer's resultId"),
          queryParam("offset", { type: "integer", minimum: 0 }, "items to skip"),
          queryParam("fields", { type: "string" }, "comma-separated paths to pick per item"),
          queryParam("maxChars", { type: "integer" }, "JSON data budget"),
        ],
        responses: { "200": json({ type: "object" }), ...errors },
      },
    },
  };
  if (o.allowWrites)
    paths["/v1/write/{site}/{op}"] = {
      post: {
        operationId: id("callWriteOperation"),
        summary: "Call a site's write operation: it changes the user's account",
        description:
          "Only when the user asked for that exact action. The same write within 10 minutes is refused as duplicate unless again is true.",
        parameters: [site, op],
        requestBody: body({
          ...callBody,
          properties: {
            ...(callBody.properties as JsonSchema),
            again: { type: "boolean" },
            idempotencyKey: { type: "string" },
          },
        }),
        responses: { "200": json(result), ...errors },
      },
    };
  if (o.learn) {
    const learn = tools.schema("learn_site");
    if (learn)
      paths["/v1/learn"] = {
        post: {
          operationId: id("learnSite"),
          summary: "Learn a read operation for a website nobody shared yet",
          description:
            "The page URL with {param} placeholders, the user's values and two other real values. Loads the page in a browser; can take minutes.",
          requestBody: body(plainTuples(learn) as JsonSchema),
          responses: { "200": json({ type: "object" }), ...errors },
        },
      };
  }

  let left = MAX_OP_PATHS;
  for (const name of o.sites?.length ? o.sites : listSites()) {
    let s: Site | undefined;
    try {
      s = loadSite(name)?.site;
    } catch {
      continue;
    }
    if (!s) continue;
    const notes = siteNotes(s.name);
    for (const operation of s.operations) {
      if (!operation.readOnly) continue;
      if (left-- <= 0) break;
      const what = operation.description ?? `${operation.name} on ${s.name}`;
      const description = [
        s.shared ? `(${SHARED_NOTE}.)` : "",
        what,
        notes ? `Notes: ${notes.replace(/\s+/g, " ")}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const hasRequired = operation.params.some((p) => p.required && p.default === undefined);
      paths[`/v1/call/${encodeURIComponent(s.name)}/${encodeURIComponent(operation.name)}`] = {
        post: {
          operationId: id(`${s.name}__${operation.name}`),
          summary: cut(`${s.name}: ${what}`, SUMMARY_MAX),
          description: cut(description, DESCRIPTION_MAX),
          requestBody: body({
            type: "object",
            properties: { args: inputSchema(operation), view, maxTier: CALL_EXTRA.maxTier },
            ...(hasRequired ? { required: ["args"] } : {}),
            additionalProperties: false,
          }),
          responses: { "200": json(callResultSchema(opDataSchema(s, operation))), ...errors },
        },
      };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "api-anything",
      version: o.version,
      description: `Calls websites' own data requests on this machine, with its sessions. ${UNTRUSTED_NOTE}`,
    },
    servers: [{ url: o.url }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: {
        CallResult: callResultSchema(),
        Error: {
          type: "object",
          required: ["ok", "error"],
          properties: { ok: { type: "boolean", const: false }, error: { type: "string" } },
        },
      },
    },
  };
}
