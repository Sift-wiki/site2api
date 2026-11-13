/**
 * What sharing an op sends, and what is checked first: each op's upload (the export's stripping, its
 * param examples kept), a live-secret scan no `public` name waives, the shared rules, and what may be
 * the publisher's own, for them to look at. `api-anything publish` previews it; share.ts sends it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Gate, gate, proofOf } from "./checks.js";
import { slugOf } from "./domain.js";
import { sharedName } from "./registry.js";
import type { Evidence, SiteContext, VersionUpload } from "./registry-api.js";
import { hostsOf, summarize } from "./search.js";
import { besideOrigins, credentialsOf, ipIn, liveIn, opUrls, ownTexts, pctDecode, scanSecrets } from "./secrets.js";
import { accountCookies, loadSession, type Session, safeName, siteOf } from "./session.js";
import type { Operation, Site } from "./spec.js";
import { bundledDir, exportSite, loadSite, siteNotes } from "./store.js";
import type { StoredCookie } from "./types.js";
import { LIMITS, readbackProblems, uploadProblems, vetShared } from "./vet.js";

export const CLIENT_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * An email address, a UUID or an IP address in any string or key of `value`: what may be someone's
 * own, which no scan tells from a constant. Publish shows them to the publisher; the recorded site
 * fixtures (test/fixture/sites) must have none.
 */
export function personalIn(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  const check = (text: string, where: string) => {
    if (EMAIL.test(text)) found.push(`${where} holds an email address (${EMAIL.exec(text)![0]})`);
    if (UUID.test(text)) found.push(`${where} holds an id (${UUID.exec(text)![0]}): is it your account's?`);
    const ip = ipIn(text);
    if (ip) found.push(`${where} holds the IP address ${ip}`);
  };
  const visit = (v: unknown, at: string) => {
    if (typeof v === "string") check(v, at);
    else if (Array.isArray(v)) for (const [i, x] of v.entries()) visit(x, `${at}[${i}]`);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        check(k, `a key in ${at}`);
        visit(x, `${at}.${k}`);
      }
  };
  visit(value, path);
  return found;
}

/**
 * What in an upload may be the publisher's own, for them to look at: no scan tells an account id from
 * a constant. Every string and key of the op and the site's fields is read, and the notes.
 */
export function personal(u: VersionUpload): string[] {
  const { notes, ...site } = u.site;
  const found = [...personalIn(site, "$.site"), ...personalIn(u.operation, "$.operation")];
  const op = u.operation;
  const at = `$.operation`;
  for (const seg of new URL(op.request.url).pathname.split("/"))
    if (/^\d{5,}$/.test(seg))
      found.push(`${at}.request.url has ${seg} in its path, which no param fills: is it your account's?`);
  for (const [j, s] of (op.trigger.steps ?? []).entries())
    if (s.action === "fill" && s.value && !s.value.includes("{"))
      found.push(`${at}.trigger.steps[${j}] types the literal "${s.value}" into the page`);
  for (const p of op.params) {
    if (p.default !== undefined) found.push(`${at} param ${p.name} defaults to ${JSON.stringify(p.default)}`);
    for (const v of p.enum ?? [])
      if (/\d{5,}/.test(v))
        found.push(`${at} param ${p.name} allows "${v}": is it your account's, or one of the site's own options?`);
  }
  // a check's args are typed by the publisher, as a fill step's value is
  for (const [j, c] of (op.checks ?? []).entries())
    found.push(
      `${at}.checks[${j}] sends ${Object.entries(c.args)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}: is every value public, none of them yours?`,
    );
  if (notes) found.push(...personalIn(notes, "the notes"));
  return found;
}

/**
 * The op as an upload carries it: a readback that names a read of the export carries that read
 * instead, since an upload holds one op. From the export, so the read's request holds `{param}`, not
 * the learner's example values; its params go without examples, descriptions and hints. A name that
 * is no read of it is left as it is: `readbackProblems` says why.
 */
export function embedReadback(spec: Site, op: Operation): Operation {
  const rb = op.readback;
  if (!rb || !("op" in rb)) return op;
  const read = spec.operations.find((o) => o.name === rb.op);
  if (!read?.readOnly) return op;
  const { name, request, slots, volatile, trigger, match, response, params, minTier, learnedLoggedIn, paging } = read;
  return {
    ...op,
    readback: {
      read: {
        name,
        request,
        slots,
        volatile,
        trigger,
        match,
        response,
        params: params.map(({ example: _e, description: _d, hint: _h, ...p }) => p),
        ...(read.public ? { public: read.public } : {}),
        minTier,
        learnedLoggedIn,
        // an omitted cursor is cleared for page one only when the read knows it pages
        ...(paging ? { paging } : {}),
      },
      args: rb.args,
      ...(rb.find ? { find: rb.find } : {}),
    },
  };
}

/** Every host an op sends to or opens, `goto` steps included: the run opens a goto's `value`, else its `selector`. */
export const hostsOfOp = (op: Operation) => [
  ...hostsOf(op),
  ...(op.trigger.steps ?? []).flatMap((s) => {
    const url = s.action === "goto" ? (s.value ?? s.selector) : undefined;
    try {
      return url ? [new URL(url).hostname] : [];
    } catch {
      return [];
    }
  }),
];

/**
 * The live cookies of the site's own domain that may carry the user's account, by their names: every one
 * but a pinned login cookie's is cleared by positive evidence that a visitor holds it too
 * (`accountCookies`: an analytics, consent, bot-management or CSRF name, or a name a signed-out visit was
 * given). `guest`: the names a visit with no cookies is given now, beside the ones a login recorded. A
 * cookie of another site (an ad network's, in the same jar) is no sign-in to this one.
 */
export function accountMaybe(
  site: Site,
  session: Pick<Session, "cookies" | "guestCookies">,
  guest: readonly string[] = [],
): StoredCookie[] {
  const own = siteOf(new URL(site.baseUrl).hostname);
  const mine = session.cookies.filter((c) => siteOf(c.domain.replace(/^\./, "").toLowerCase()) === own);
  return accountCookies(mine, site.loginCookies, [...(session.guestCookies ?? []), ...guest]);
}

/**
 * Public: called with no cookies and no session values it answered, it was learned signed out, it reads,
 * it sends nowhere off its site, and it holds no `public` name (a shared bearer). Only such an op is
 * shared without the user's yes, and only such an op do reports promote.
 *
 * Signed out needs positive evidence: `learnedLoggedIn` knows a short list of login names (PHPSESSID,
 * JSESSIONID and connect.sid are not on it). So a `session` with a login on record (`source`) is never
 * a visitor's, whatever its cookies are called: a framework's session cookie has one name for a visitor
 * and a member. With none on record, no live cookie of the site may be one whose name could carry an
 * account (`accountMaybe`, with `guest`).
 */
export function isPublic(
  site: Site,
  op: Operation,
  evidence: Partial<Evidence>,
  session: Pick<Session, "cookies" | "source" | "guestCookies">,
  guest: readonly string[] = [],
): boolean {
  const own = siteOf(new URL(site.baseUrl).hostname);
  return (
    (evidence.cleanReplay === "ok" || evidence.cleanReplay === "blocked") &&
    !op.learnedLoggedIn &&
    !evidence.learnedLoggedIn &&
    !session.source &&
    !accountMaybe(site, session, guest).length &&
    op.readOnly &&
    hostsOfOp(op).every((h) => siteOf(h) === own) &&
    !op.public?.length
  );
}

/**
 * The params of `args` with a value (3+ characters) that `value` still spells: as it is, percent- or
 * form-encoded, in a layer or base64 the secret scan reads (`liveIn`, 6+ characters), or as its words
 * joined another way (a slug: "Jane Doe" as jane-doe, jane_doe or JaneDoe). A heal learns from one run
 * made with its call's own args, with no second example to tell a copy of one from a constant, so
 * this reads wider than learn_site's check of its own upload. A number counts as a whole word only: its
 * digits inside a longer one (a timestamp, limit=1000) are not the arg. A hit may be chance ("api" in
 * /api/search): the op then stays here, which costs one upload.
 */
export function spelled(value: unknown, args: Record<string, unknown>): string[] {
  const text = JSON.stringify(value);
  const lower = text.toLowerCase();
  const words = (t: string) => `-${t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-")}-`;
  const worded = words(pctDecode(text, false));
  const run = worded.replaceAll("-", "");
  // a flag is no one's own, and every JSON body spells true and false
  const leaves = (v: unknown): string[] =>
    v === null || typeof v === "boolean" ? [] : typeof v === "object" ? Object.values(v).flatMap(leaves) : [String(v)];
  const found = (raw: string) => {
    const s = raw.toLowerCase();
    if (s.length < 3 || /^(true|false|null)$/.test(s)) return false;
    const w = words(raw);
    const asWords = w.length >= 5 && worded.includes(w);
    if (/^\d+$/.test(s)) return asWords;
    const enc = encodeURIComponent(s).toLowerCase();
    const joined = w.replaceAll("-", "");
    return (
      [s, enc, enc.replace(/%20/g, "+")].some((f) => lower.includes(f)) ||
      asWords ||
      // several words run together, letters among them
      (w.split("-").length > 3 && joined.length >= 6 && /\p{L}/u.test(joined) && run.includes(joined)) ||
      liveIn(text, { cookies: [], values: { arg: raw } })
    );
  };
  return Object.entries(args)
    .filter(([, v]) => leaves(v).some(found))
    .map(([k]) => k);
}

/**
 * The name a site goes up under. A name the registry already holds stays: a pulled site's, and a bundled
 * one's, which the registry was seeded with. Any other site is new there, and the registry names a new
 * site after its domain (`slugOf`), so it goes up under that whatever it is called here; the local name
 * is the user's.
 */
export function registryName(site: Site, dir = bundledDir()): string {
  if (site.shared || existsSync(join(dir, `${site.name}.json`))) return site.name;
  return slugOf(new URL(site.baseUrl).hostname);
}

/**
 * `registryName`, asking the registry when the site is held under neither its own name nor the slug: a site
 * learned here under the name the registry serves for its domain (learn_site reuses it) goes up under it.
 */
export async function uploadName(name: string, o: { signal?: AbortSignal } = {}): Promise<string> {
  const r = loadSite(name);
  if (!r) return name;
  const fallback = registryName(r.site);
  if (fallback === r.site.name) return fallback;
  const domain = siteOf(new URL(r.site.baseUrl).hostname);
  return (await sharedName(domain, o)) === r.site.name ? r.site.name : fallback;
}

export interface OpPlan {
  op: string;
  upload: VersionUpload;
  public: boolean;
  /** each one refuses the upload */
  errors: string[];
  personal: string[];
}

export interface Plan {
  site: string;
  /** the site's name in the registry, when it is not `site` (`registryName`) */
  as?: string;
  ops: OpPlan[];
  operations: ReturnType<typeof summarize>[];
  stripped: string[];
  /** every op's, and publish's own gate: verify's record */
  errors: string[];
  warnings: string[];
  /** to the publisher only: may be their own */
  personal: string[];
  /** each op's last verify on its current version */
  checks: Gate["rows"];
}

/**
 * The uploads of `ops` (all of the site's when empty), with the export's stripping and scans, the shared
 * rules, a live-secret scan no `public` name waives over the exact bytes sent, and the privacy checks.
 * `guest`: the cookie names a signed-out visit of the site is given now (`isPublic`).
 */
export function plan(
  name: string,
  o: {
    ops?: string[];
    evidence?: Partial<Evidence>;
    parent?: string;
    consent?: boolean;
    as?: string;
    guest?: readonly string[];
  } = {},
): Plan {
  name = safeName(name);
  const r = loadSite(name);
  if (!r) throw new Error(`no site "${name}"`);
  const wanted = o.ops?.length ? o.ops : r.site.operations.map((op) => op.name);
  for (const n of wanted)
    if (!r.site.operations.some((op) => op.name === n)) throw new Error(`no operation "${n}" on ${name}`);
  // the learner arranges the param examples to be ones the user chose to share (learnsite.ts)
  const ex = exportSite(name, { keepExamples: true });
  // The user's own notes go only with their yes; without it, only notes that came from the registry
  const notes = o.consent ? siteNotes(name) : siteNotes(name, { from: "registry" });
  const session = loadSession(name);
  const live = credentialsOf(besideOrigins(session, [ex.spec.baseUrl, ...ex.spec.operations.flatMap(opUrls)]));
  const as = o.as ?? registryName(r.site);
  const context: SiteContext = {
    name: as,
    domain: siteOf(new URL(ex.spec.baseUrl).hostname),
    baseUrl: ex.spec.baseUrl,
    ...(ex.spec.displayName ? { displayName: ex.spec.displayName } : {}),
    ...(ex.spec.description ? { description: ex.spec.description } : {}),
    ...(ex.spec.loginCookies ? { loginCookies: ex.spec.loginCookies } : {}),
    ...(ex.spec.pace && Object.keys(ex.spec.pace).length ? { pace: ex.spec.pace } : {}),
    ...(notes ? { notes } : {}),
  };
  const warnings = new Set(ex.warnings);
  const checked = gate({ ...r.site, operations: r.site.operations.filter((op) => wanted.includes(op.name)) });
  const ops = wanted.map((n): OpPlan => {
    const i = ex.spec.operations.findIndex((op) => op.name === n);
    const operation = embedReadback(ex.spec, ex.spec.operations[i]!);
    // An upload carries one operation, not the target operations its local links require.
    delete operation.links;
    const mine = r.site.operations.find((op) => op.name === n)!;
    // where the export's scan found something in the read the upload carries
    const rb = mine.readback && "op" in mine.readback ? mine.readback.op : undefined;
    const j = rb === undefined ? -1 : ex.spec.operations.findIndex((op) => op.name === rb);
    const evidence: Evidence = {
      clientVersion: CLIENT_VERSION,
      learnedLoggedIn: mine.learnedLoggedIn,
      cleanReplay: "skipped",
      // what learn_site proved of this version, when the user shares it later
      ...proofOf(name, mine),
      ...o.evidence,
    };
    const upload: VersionUpload = { site: context, operation, ...(o.parent ? { parent: o.parent } : {}), evidence };
    const vet = vetShared({ ...ex.spec, operations: [operation] }, notes);
    for (const w of vet.warnings) warnings.add(w);
    const fit = readbackProblems(r.site, mine).map((m) => `${n}: ${m}`);
    const bytes = JSON.stringify(upload);
    // `public` keeps a shared bearer out of the shape heuristics, never out of this: a value this
    // machine holds is refused wherever it sits in what is sent, keys included. The bytes are no op for
    // the scan to read what it spells of its own accord, so that is read here: the op's and the site's
    // addresses and the caller's values (the holdout's args are a check's, or were).
    const carried = operation.readback && "read" in operation.readback ? operation.readback.read : undefined;
    const own = [context, operation, carried, { checks: [evidence.holdout ?? {}] }].flatMap(ownTexts);
    const strict = scanSecrets([bytes], live, undefined, own).secrets.map((m) =>
      m.replace(/^\$\[0\]/, `the upload of ${n}`),
    );
    const theirs = ex.secrets.filter(
      (m) =>
        !/^\$\.operations\[\d+\]/.test(m) || m.startsWith(`$.operations[${i}]`) || m.startsWith(`$.operations[${j}]`),
    );
    return {
      op: n,
      upload,
      // the jar is the capture's: a learn and a heal save their run's cookies to it before they share
      public: isPublic(r.site, mine, evidence, session, o.guest),
      errors: [
        ...new Set([...theirs, ...strict]),
        // the read a readback names fits it where the author wrote it: the upload carries a copy
        ...new Set([...vet.errors, ...fit]),
        ...(fit.length ? [] : uploadProblems(operation)),
        ...(checked.failed.get(n) ?? []),
        ...(Buffer.byteLength(bytes) > LIMITS.file
          ? [`the upload of ${n} is ${Buffer.byteLength(bytes)} bytes; at most ${LIMITS.file}`]
          : []),
      ],
      personal: personal(upload),
    };
  });
  return {
    site: name,
    ...(as !== name ? { as } : {}),
    ops,
    operations: ops.map((p) => summarize(p.upload.operation)),
    stripped: [
      "the example values in each request (the param examples stay)",
      "response shapes (the picked fields' types stay)",
      "when each op was learned",
      ...(ops.some((p) => r.site.operations.find((op) => op.name === p.op)?.links?.length)
        ? ["operation links (an upload carries one operation, without its link targets)"]
        : []),
      ...(r.site.shared ? ["where it was pulled from"] : []),
    ],
    errors: [...new Set([...ops.flatMap((p) => p.errors), ...checked.errors])],
    warnings: [...warnings],
    personal: [...new Set(ops.flatMap((p) => p.personal))],
    checks: checked.rows,
  };
}
