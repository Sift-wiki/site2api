/**
 * The OpenAPI 3.1 document `serve` answers at /openapi.json: its generic endpoints, and one
 * concrete path per installed read, `POST /v1/call/<site>/<op>`, whose body's `args` is the op's
 * args schema and whose answer's `data` is what the spec says the op returns. An OpenAPI tool loader
 * (a custom GPT's actions, n8n, Postman) then offers each op as a typed call without a list step.
 */
import { inputSchema } from "./describe.js";
import type { Toolset } from "./mcp.js";
import { UNTRUSTED_NOTE } from "./mcp.js";
import {
  callBatchSchema,
  callResultSchema,
  findSitesSchema,
  getResultSchema,
  type JsonSchema,
  jobResultSchema,
  learnSiteSchema,
  listOperationsSchema,
  opDataSchema,
} from "./schema.js";
import type { Operation, Site } from "./spec.js";
import { listSites, loadSite, siteNotes } from "./store.js";
import { SHARED_NOTE } from "./vet.js";

/** More concrete paths than this and the document is too big for a tool loader to read. */
export const MAX_OP_PATHS = 300;
/** A custom GPT refuses an operation description longer than 300 characters. */
const DESCRIPTION_MAX = 300;
const SUMMARY_MAX = 80;

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** A REST answer's `nextRequest` (serve.ts `withNextRequest`): the endpoint that takes the next step. */
const NEXT_REQUEST: JsonSchema = {
  type: "object",
  required: ["method", "path"],
  properties: {
    method: { type: "string", enum: ["GET", "POST"] },
    path: { type: "string", description: "this server's path, query included" },
    body: { type: "object", description: "the JSON body to POST" },
  },
  description: "the REST request that takes the next step (nextCall's, a pending job's, a cut answer's rest)",
};

/** An answer schema of schema.ts, as REST sends it: with nextRequest, and each batch result's. */
function rest(schema: JsonSchema): JsonSchema {
  const properties = { ...(schema.properties as Record<string, JsonSchema>) };
  const results = properties.results;
  if (results?.items) properties.results = { ...results, items: rest(results.items as JsonSchema) };
  return { ...schema, properties: { ...properties, nextRequest: NEXT_REQUEST } };
}

/**
 * A read's 200 answer over REST: the shared call result, with `data` as opDataSchema describes it.
 * That schema is conservative (no field required, an item untyped unless the recipe makes it an
 * object), and REST's data is call()'s records, never MCP's table, so a real answer fits it.
 */
export function opResponseSchema(op: Operation): JsonSchema {
  return rest(callResultSchema(opDataSchema(op)));
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
/** For an endpoint that starts a call: past the server's --max-concurrent it is refused, unsent. */
const calling = {
  ...errors,
  "429": json(
    { $ref: "#/components/schemas/CallResult" },
    "the server is running as many calls as it allows: class rate, reason server busy; wait retryAfterMs and send it again",
  ),
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

const MAX_TIER: JsonSchema = {
  type: "integer",
  enum: [1, 2, 3],
  description: "highest tier to use; 1: plain HTTP, no browser",
};
/** A read's cache and comparison options, which REST passes to call_operation and call_batch as they are. */
const WATCH_KEYS = ["maxAgeMs", "changes", "changesOnly", "watch"];

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
  const callProps = (tools.schema("call_operation")?.properties ?? {}) as Record<string, JsonSchema>;
  const view = callProps.view ?? { type: "object" };
  const watch = Object.fromEntries(WATCH_KEYS.flatMap((k) => (callProps[k] ? [[k, callProps[k]]] : [])));
  const writeBody: JsonSchema = {
    type: "object",
    properties: {
      args: { type: "object", additionalProperties: true, description: "param name -> value" },
      view,
      maxTier: MAX_TIER,
    },
    additionalProperties: false,
  };
  const callBody: JsonSchema = {
    ...writeBody,
    properties: { ...(writeBody.properties as JsonSchema), ...watch },
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
        responses: { "200": json(rest(listOperationsSchema())), ...errors },
      },
    },
    "/v1/find": {
      get: {
        operationId: id("findSites"),
        summary: "Find sites someone already turned into operations",
        description: "Words, a domain or a URL; best match first. Check a match's domain is the site the user means.",
        parameters: [queryParam("q", { type: "string" }, "words, a domain or a URL", true)],
        responses: { "200": json(rest(findSitesSchema())), ...errors },
      },
    },
    "/v1/call/{site}/{op}": {
      post: {
        operationId: id("callOperation"),
        summary: "Call a site's read operation",
        description:
          "HTTP 200 whenever the call ran: ok and class carry the outcome; data is a list of records. class pending: send nextRequest (GET /v1/jobs/{job}).",
        parameters: [site, op],
        requestBody: body(callBody),
        responses: { "200": json(result), ...calling },
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
            ...watch,
          },
          additionalProperties: false,
        }),
        responses: { "200": json(rest(callBatchSchema())), ...calling },
      },
    },
    "/v1/jobs/{jobId}": {
      get: {
        operationId: id("getJob"),
        summary: "Wait up to about 25 s for a pending call's result",
        parameters: [pathParam("jobId", "the job from a pending answer")],
        responses: { "200": json(rest(jobResultSchema())), ...errors },
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
        responses: { "200": json(rest(getResultSchema())), ...errors },
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
          ...writeBody,
          properties: {
            ...(writeBody.properties as JsonSchema),
            again: { type: "boolean" },
            idempotencyKey: { type: "string" },
          },
        }),
        responses: { "200": json(result), ...calling },
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
          responses: { "200": json(rest(learnSiteSchema())), ...calling },
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
            properties: { args: inputSchema(operation), view, maxTier: MAX_TIER, ...watch },
            ...(hasRequired ? { required: ["args"] } : {}),
            additionalProperties: false,
          }),
          responses: { "200": json(opResponseSchema(operation)), ...calling },
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
        CallResult: rest(callResultSchema()),
        Error: {
          type: "object",
          required: ["ok", "error"],
          properties: { ok: { type: "boolean", const: false }, error: { type: "string" } },
        },
      },
    },
  };
}
