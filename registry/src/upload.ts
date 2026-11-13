/** What an uploaded or seeded version must pass, and what makes one `review`. docs/REGISTRY.md "Trust". */
import { z } from "zod";
import { templateRefs, walk } from "../../src/codec.js";
import { siteOf } from "../../src/domain.js";
import { type Evidence, requestSig, type SiteContext, triggerSig, versionHashText } from "../../src/registry-api.js";
import { type Operation, OperationSchema, SiteSchema } from "../../src/spec.js";
import { DOCUMENT_AT, uploadProblems, vetShared, WHOLE_BODY, writesGraphql } from "../../src/vet.js";
import { sha256Hex } from "./auth.js";

export const HASH = z.string().regex(/^[0-9a-f]{64}$/);
// as the index's site names (src/search.ts IndexEntrySchema)
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const SiteContextSchema = z.object({
  name: z.string().regex(NAME, "site name must be lower-case letters, digits, . _ -, at most 64"),
  domain: z.string(),
  baseUrl: z.string(),
  displayName: z.string().max(100).optional(),
  description: z.string().optional(),
  loginCookies: z.array(z.string().max(200)).max(50).optional(),
  pace: z.object({ minIntervalMs: z.number().optional(), perHour: z.number().optional() }).strict().optional(),
  notes: z.string().optional(),
});

const Tier = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const UploadSchema = z.object({
  site: SiteContextSchema,
  operation: z.unknown(),
  parent: HASH.optional(),
  evidence: z.object({
    clientVersion: z.string().max(100),
    learnedLoggedIn: z.boolean(),
    cleanReplay: z.enum(["ok", "blocked", "failed", "skipped"]),
    holdout: z.object({ args: z.record(z.string(), z.unknown()), ok: z.boolean(), tier: Tier.optional() }).optional(),
    tier: Tier.optional(),
    healedFrom: HASH.optional(),
  }),
  claim: HASH.optional(),
});

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);

/** The operation as the registry keys it: parsed, and without the client's own record of where it came from. */
export function parseOperation(input: unknown): { op: Operation } | { errors: string[] } {
  const r = OperationSchema.safeParse(input);
  if (!r.success) return { errors: issues(r.error).map((m) => `operation.${m}`) };
  const { version: _, ...op } = r.data as Operation & { version?: unknown };
  return { op };
}

export const versionHash = (site: string, op: Operation) => sha256Hex(versionHashText(site, op));

/**
 * The request an op says it matches: method, host, path, GraphQL operationName; stored with each version for
 * maintainers. Its author's word: what it sends is `requestSig`.
 */
export const matchSig = (op: Operation) =>
  JSON.stringify([
    op.request.method.toUpperCase(),
    op.match.host ?? "",
    op.match.path ?? "",
    op.match.operationName ?? "",
  ]);

/** Why a site context and its ops cannot be shared at all: the domain, the shared rules, the credential checks. */
export function refusals(site: SiteContext, ops: Operation[]): string[] {
  let host: string;
  try {
    host = new URL(site.baseUrl).hostname;
  } catch {
    return [`baseUrl ${site.baseUrl} is not an absolute URL`];
  }
  if (site.domain !== siteOf(host)) return [`domain ${site.domain} is not baseUrl's site ${siteOf(host)}`];
  const spec = SiteSchema.safeParse({
    name: site.name,
    baseUrl: site.baseUrl,
    displayName: site.displayName,
    description: site.description,
    loginCookies: site.loginCookies,
    pace: site.pace,
    operations: ops,
  });
  if (!spec.success) return issues(spec.error);
  return vetShared(spec.data, site.notes).errors;
}

/** Hosts an op sends to or opens off its site, a write's readback included: its proof is sent too. */
function offSite(op: Operation, domain: string): string[] {
  const rb = op.readback && "read" in op.readback ? op.readback.read : undefined;
  const urls = [op, ...(rb ? [rb] : [])].flatMap((o) => [
    o.request.url,
    o.trigger.url,
    o.trigger.softFrom,
    ...(o.trigger.steps ?? []).map((s) => (s.action === "goto" ? (s.value ?? s.selector) : undefined)),
  ]);
  const hosts = urls.flatMap((u) => {
    try {
      return u ? [new URL(u).hostname.toLowerCase()] : [];
    } catch {
      return [];
    }
  });
  return [...new Set(hosts.filter((h) => siteOf(h) !== domain))];
}

/** The only name a new site may take: its registrable domain with dots as dashes (crates.io: crates-io). */
export const nameOf = (domain: string) => domain.replace(/\./g, "-");

/** Why a new site may not take this name. Unique by construction: no site can take another's brand. */
export function nameRefusal(name: string, domain: string): string | undefined {
  const want = nameOf(domain);
  if (name === want) return undefined;
  return `a new site's name is its domain ${domain} with dots as dashes: ${want}, not ${name}`;
}

const GRAPHQL_FIELDS = new Set(["query", "variables", "operationName"]);
// a slot's first step that picks the body's parser, or writes the body as a form's pairs
const REPARSES = /^(header:content-type$|form(\[\d+\])?:)/i;
// one media type with plain parameters: of two in a list, the server's parser picks
const MEDIA_TYPE = /^\s*([a-z0-9.+/-]+)\s*(;\s*[\w-]+=("[\w.-]*"|[\w.-]*)\s*)*$/i;
const JSON_TYPES = new Set(["application/json", "application/graphql+json"]);

/** The documents of a body that is GraphQL and nothing else; undefined when it carries anything more. */
function documents(op: Operation): string[] | undefined {
  const body = op.request.body ?? "";
  const type = MEDIA_TYPE.exec(op.request.headers["content-type"] ?? "")?.[1]?.toLowerCase();
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    // not JSON: a raw document, and only under the media type that says the body is one
    return type === "application/graphql" ? [body] : undefined;
  }
  // JSON under another type is another parser's to read: a form parser finds its own `query=` inside a string
  if (!type || !JSON_TYPES.has(type)) return undefined;
  // parsers disagree on which value of a repeated key counts
  if (walk(op.request).some((l) => l.at[0] === "body" && l.repeated?.length)) return undefined;
  const docs: string[] = [];
  for (const item of Array.isArray(j) ? j : [j]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const q = (item as { query?: unknown }).query;
    // a field the rule does not know (an id, extensions, the endpoint's own fields) could be the real request
    if (typeof q !== "string" || !q.trim() || Object.keys(item).some((k) => !GRAPHQL_FIELDS.has(k))) return undefined;
    docs.push(q);
  }
  return docs;
}

/**
 * A POST that carries GraphQL query documents and nothing else. Stricter than vetShared: a persisted query
 * (a hash, no document) could name a mutation, so it goes to review, and so does a document a slot fills,
 * which is whatever an arg or a param's default makes it (a search API's `{"query":"{q}"}` included). The
 * body is read as its content type says a server reads it, so a slot may not fill that header, nor write
 * form pairs into a body that is no form.
 */
function graphqlQuery(op: Operation): boolean {
  const rewrites = (at: string[]) =>
    WHOLE_BODY.test(at.at(-1) ?? "") || at.some((st) => DOCUMENT_AT.test(st)) || REPARSES.test(at[0] ?? "");
  if (op.slots.some((s) => rewrites(s.at))) return false;
  const docs = documents(op);
  const reads = (d: string) => /^\s*(query|fragment)\b|^\s*\{/.test(d.replace(/#[^\n\r]*/g, ""));
  return !!docs?.length && docs.every((d) => reads(d) && !writesGraphql(d));
}

/** What the registry already holds of the upload's site. */
export interface SiteHeld {
  /** op names the site has a live or degraded version of */
  opNames: string[];
  /** the site lists login cookies or has an op learned while signed in */
  login: boolean;
  /** some site on its domain has a seeded op or a version that was ever live */
  established: boolean;
  /**
   * the op's incumbent, its live or degraded version live the longest: what it says it matches (`matchSig`),
   * what it sends (`requestSig`) and what its browser runs open (`triggerSig`)
   */
  incumbent?: { match: string; request: string; trigger: string };
}

/** Why a version is outside the automatic rules: served to its uploader only until a maintainer decides. */
export function reviewReasons(
  site: SiteContext,
  op: Operation,
  evidence: Evidence,
  held: SiteHeld = { opNames: [], login: false, established: false },
): string[] {
  const reasons: string[] = [];
  const off = offSite(op, site.domain);
  if (off.length) reasons.push(`sends to or opens ${off.join(", ")}, off its site ${site.domain}`);
  if (op.learnedLoggedIn || evidence.learnedLoggedIn) reasons.push("learned while signed in");
  if (!op.readOnly) reasons.push("a write");
  // a "read" that changes something, run by every caller's client with their cookies, is a write by proxy
  const method = op.request.method.toUpperCase();
  if (op.readOnly && method !== "GET" && method !== "HEAD" && !(method === "POST" && graphqlQuery(op)))
    reasons.push(`a read sent as ${method}${method === "POST" ? ", not a GraphQL query" : ""}`);
  const lookupSlots = op.slots.flatMap((s) => s.from?.slots ?? []);
  // a ref is one whether it fills the whole leaf or a hole of the slot's template (http.ts holdsRef)
  const refs = [
    ...new Set(
      [...op.slots, ...lookupSlots].flatMap((s) => [...(s.ref ? [s.ref] : []), ...templateRefs(s.template ?? "")]),
    ),
  ];
  if (refs.length) reasons.push(`sends the caller's own ${refs.join(", ")}`);
  // a lookup runs with the caller's cookies, and what it answers (a CSRF token under any name) goes into the read
  const derived = op.slots.filter((s) => s.from).map((s) => s.at.join(" > "));
  if (derived.length) reasons.push(`fills ${derived.join(", ")} from a lookup sent with the caller's cookies`);
  const newOp = !held.opNames.includes(op.name);
  if (newOp && (held.login || site.loginCookies?.length)) reasons.push(`a new op on a site with a login: ${op.name}`);
  // callers trust an established site: a maintainer approves what it newly does (x.com "follow")
  else if (newOp && held.established) reasons.push(`a new op on an established site: ${op.name}`);
  // a heal keeps its match, built from stable identity only; a new endpoint under an old name (linkedin
  // search turned into /psettings/close-account) is a new op wearing a trusted name
  const sig = matchSig(op);
  const sent = requestSig(op);
  const incumbent = held.incumbent;
  if (!newOp && held.established) {
    // no incumbent to compare with: a maintainer looks, rather than any match passing
    if (!incumbent) reasons.push(`no live version of ${op.name} to compare its match with`);
    else if (sig !== incumbent.match)
      reasons.push(`its match ${sig} differs from the live version's ${incumbent.match}`);
    // the match is the uploader's word; the request is what every caller sends
    else if (sent !== incumbent.request)
      reasons.push(`its request ${sent} differs from the live version's ${incumbent.request}, under the same match`);
    // tier 3 and every heal open the trigger, whatever the request is; a heal keeps its op's own
    else if (triggerSig(op) !== incumbent.trigger)
      reasons.push("its trigger differs from the live version's, under the same request");
  }
  if (op.public?.length) reasons.push(`lists public values: ${op.public.join(", ")}`);
  // blocked: a bot wall answered the cookie-free replay, so the data is public behind it
  if (evidence.cleanReplay !== "ok" && evidence.cleanReplay !== "blocked")
    reasons.push(`its clean replay was ${evidence.cleanReplay}, not ok`);
  // the export scan's heuristics: a JWT, a bearer, a long blob; they misfire, so a maintainer looks
  const spec = SiteSchema.parse({ name: site.name, baseUrl: site.baseUrl, operations: [op] });
  for (const w of vetShared(spec).warnings) if (w.startsWith("$")) reasons.push(w);
  return reasons;
}

export interface Upload {
  site: SiteContext;
  operation: Operation;
  parent?: string;
  evidence: Evidence;
  hash: string;
  claim?: string;
}

/** An upload's body, parsed and held to the shared rules, or why it is refused. */
export async function readUpload(body: unknown): Promise<Upload | { errors: string[] }> {
  const r = UploadSchema.safeParse(body);
  if (!r.success) return { errors: issues(r.error) };
  const parsed = parseOperation(r.data.operation);
  if ("errors" in parsed) return parsed;
  const site = r.data.site as SiteContext;
  const errors = [...uploadProblems(parsed.op), ...refusals(site, [parsed.op])];
  if (errors.length) return { errors };
  // the holdout's args are examples, but the registry keeps no args at all
  const { holdout, ...rest } = r.data.evidence;
  const evidence: Evidence = {
    ...rest,
    ...(holdout ? { holdout: { args: {}, ok: holdout.ok, tier: holdout.tier } } : {}),
  };
  return {
    site,
    operation: parsed.op,
    ...(r.data.parent ? { parent: r.data.parent } : {}),
    evidence,
    hash: await versionHash(site.name, parsed.op),
    ...(r.data.claim ? { claim: r.data.claim } : {}),
  };
}
