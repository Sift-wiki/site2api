/**
 * What counts as a credential, and the scan that finds one in a spec. Learning uses these to turn
 * credentials into references and to check none is left; the store uses them before a save or an export.
 * `redact` takes live values out of the messages a call returns and keeps.
 */
import { type Leaf, type Step, walk } from "./codec.js";
import type { Session } from "./session.js";
import type { Request, Site } from "./spec.js";
import type { CaptureResult, TriggerStep } from "./types.js";

export const SESSION_HEADER =
  /^(authorization|x-[a-z0-9-]*token|x-csrf[a-z0-9-]*|x-xsrf[a-z0-9-]*|x-goog-batchexecute-bgr|x-client-transaction-id|x-fb-lsd|x-ig-www-claim)$/i;
// Per-session credentials sent in forms, queries or JSON bodies: Google's `at`, Meta's fb_dtsg/lsd,
// Rails', ASP.NET's anti-CSRF fields, and OAuth-style access tokens.
export const SESSION_FIELD =
  /^(at|fb_dtsg|lsd|authenticity_token|__RequestVerificationToken|_?csrf(_?token)?|_?xsrf(_?token)?|csrfmiddlewaretoken|(access_?)?token|session_?id)$/i;

export const headerName = (at: Step[]) => (at[0]!.startsWith("header:") ? at[0]!.slice(7) : undefined);
export const lastToken = (at: Step[]) => {
  const s = at[at.length - 1]!;
  return s.startsWith("json:") ? s.slice(s.lastIndexOf("/") + 1) : s.slice(s.indexOf(":") + 1);
};
/** The name a leaf goes by: its header, field, query key or JSON key. */
export const leafName = (at: Step[]) => headerName(at) ?? lastToken(at);

// Words that name a credential in a key or header: api_key, authToken, x-session-id, sid, X-Amz-Signature.
const CREDENTIAL_WORD =
  /^(?:auth(?!or)[a-z0-9]*|[a-z0-9]*(?:token|secret|key|signature|password|passwd|pwd|credential|bearer)s?|sess(?:ion)?[a-z0-9]*|sid)$/;

/** A key or header named like a credential, judged by its words (authToken -> auth, token; "author" is not). */
export function credentialName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => CREDENTIAL_WORD.test(w));
}

/**
 * The leaves of a request holding a literal the learner would have made a ref: a hand-written or
 * older spec's credential. `pub`: the lower-cased names the op lists as public. A header is judged
 * whole, JSON or not, as learning judges it: a JSON authorization header is one credential.
 */
export function literalCredentials(req: Request, pub: Set<string>): Leaf[] {
  return walk(req).filter(
    (l) =>
      l.type === "string" &&
      (!l.container || (l.at.length === 1 && headerName(l.at) !== undefined)) &&
      !pub.has(leafName(l.at).toLowerCase()) &&
      isCredential(leafName(l.at), l.value),
  );
}

/**
 * The borderline placements the scan knowingly lets through (docs/DESIGN.md "What the scan does not
 * cover"): a per-session name holding a number or a value under six characters, and a plain value
 * under a credential-like name. Report-only, for `--strict-scan`; none of these refuses a save.
 */
export function borderlineCredentials(spec: Pick<Site, "operations">): string[] {
  const out: string[] = [];
  const check = (req: Request, where: string) => {
    for (const l of walk(req)) {
      if (l.container) continue;
      const name = leafName(l.at);
      const value = l.value;
      // a slot template is not a value the spec carries
      if (!value || value.length > 200 || /[{}<>]/.test(value)) continue;
      if (isCredential(name, value)) continue; // already an error, not a borderline case
      if (!(SESSION_HEADER.test(name) || SESSION_FIELD.test(name) || credentialName(name))) continue;
      const at = `${where} ${l.at.join(" > ")}`;
      if (l.type === "number" || /^\d+$/.test(value))
        out.push(`${at} holds a number under ${name}: a credential that is a number is not scanned`);
      else if (value.length < 6)
        out.push(`${at} holds ${value.length} characters under ${name}: shorter than the scan's 6-character floor`);
      else if (credentialName(name) && value.length < 16 && !highEntropy(value) && !URLISH.test(value))
        out.push(`${at} holds a plain-looking value under ${name}: the scan skips it, so check it is not a credential`);
    }
  };
  for (const op of spec.operations) {
    check(op.request, `op ${op.name} request`);
    for (const slot of op.slots) if (slot.from) check(slot.from.request, `op ${op.name} lookup`);
  }
  return [...new Set(out)];
}

export const URLISH = /^[a-z][a-z0-9+.-]*:\/\//i;

/** JSON text: an object or an array, whose leaves are judged one by one and whose siblings are not copies. */
export const jsonContainer = (v: string) => /^\s*[[{]/.test(v);

/** Random-looking: 16+ chars, no spaces, not a URL, two character classes, 3+ bits of entropy per char. */
export function highEntropy(v: string): boolean {
  if (v.length < 16 || /\s/.test(v) || URLISH.test(v)) return false;
  if ([/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(v)).length < 2) return false;
  const n = new Map<string, number>();
  for (const c of v) n.set(c, (n.get(c) ?? 0) + 1);
  let bits = 0;
  for (const k of n.values()) bits -= (k / v.length) * Math.log2(k / v.length);
  return bits >= 3;
}

/** A literal a spec must not hold: a per-session field or header, or a random value under a credential's name. */
export function isCredential(name: string, value: string): boolean {
  return (
    ((SESSION_FIELD.test(name) || SESSION_HEADER.test(name)) && value.length >= 8) ||
    (credentialName(name) && highEntropy(value))
  );
}

/**
 * A token and nothing else, under any name: one unbroken run of 16+ characters of the hex or
 * URL-safe base64 alphabet that is random-looking. Words and numbers joined by - or _ are not one,
 * however long (a slug, page-1-sort-relevance), and any other character breaks the run: `:`, `/`,
 * `.`, `=` and `+` separate the parts of structured text.
 */
export function opaqueToken(text: string): boolean {
  const worded = text.split(/[-_]/).every((part) => /^[A-Za-z]*\d*$/.test(part));
  return /^[A-Za-z0-9_-]{16,}$/.test(text) && highEntropy(text) && !worded;
}

/* ---------------------------------------------------------------- sign-in */

/** The tokens of an input's autocomplete that name a sign-in's secret: what the user types, never a spec. */
export const SIGN_IN_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"];
// A selector naming a password or one-time-code field: by its type, its autocomplete, or a word in its name or id.
const SIGN_IN_SELECTOR =
  /type\s*=\s*["']?password|current-password|new-password|one-time-code|pass(?:word|wd|code)|(?<![a-z])(?:pass|pw|pwd|otp|totp|mfa|2fa)(?![a-z])/i;

export const SIGN_IN_REFUSAL =
  "a sign-in is the user's: ask them to run api-anything login <site> (it imports the cookies of the browser they are signed in with, no password)";

/**
 * Fill steps that type a sign-in's secret: into a field the selector names as a password or a
 * one-time code, or a literal that is random-looking (a `{param}` the call fills is no literal).
 * The run refuses such a field by what the page says it is; this catches a hand-written step.
 */
export function signInFills(steps: readonly TriggerStep[] = []): string[] {
  return steps.flatMap((s, i) => {
    if (s.action !== "fill") return [];
    const why = SIGN_IN_SELECTOR.test(s.selector ?? "")
      ? `fills a password or one-time-code field (${s.selector})`
      : highEntropy((s.value ?? "").replace(/\{[^}]*\}/g, ""))
        ? "types a literal that looks like a password"
        : undefined;
    return why ? [`steps[${i}] ${why}: ${SIGN_IN_REFUSAL}`] : [];
  });
}

/* ------------------------------------------------------------------- scan */

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
const HEX_BLOB = /\b[0-9a-fA-F]{32,}\b/;
// "/" left out: every long URL path would match
const BASE64_BLOB = /[A-Za-z0-9+_-]{40,}={0,2}/;
const BEARER = /^Bearer\s+\S{20,}/i;
// identifiers like __relay_internal__pv__appviewerisloggedinprovider are long too; tokens mix case and digits
const RANDOM = (s: string) => /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

/** Decode every %XX run on its own, so one stray "%" doesn't hide the rest. */
function pctDecode(s: string, plus: boolean): string {
  return (plus ? s.replace(/\+/g, " ") : s).replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

const ESC: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const jsonUnescape = (s: string) =>
  s.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, c: string) =>
    c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (ESC[c] ?? c),
  );
// Go's html/template writes + as &#43;
const htmlCharRefs = (s: string) =>
  s.replace(/&#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}));/g, (m, hex: string | undefined, dec: string | undefined) => {
    const n = hex ? Number.parseInt(hex, 16) : Number(dec);
    return n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });

/**
 * Keys a provider issues to one account, by their own prefix: no site ships one for every visitor.
 * Where a word can follow the prefix (sk-hynix-ddr5-...), the key must hold a random run: 16+
 * letters and digits mixing cases with a digit. A site's own Google web key is `public`: it ships
 * in the site's pages for anyone to read (Maps, Firebase, YouTube's).
 */
const PROVIDER_KEYS: { what: string; re: RegExp; random?: true; public?: true }[] = [
  { what: "a GitHub token", re: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { what: "an OpenAI or Anthropic key", re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, random: true },
  { what: "an AWS access key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { what: "a Slack token", re: /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { what: "a private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { what: "a Google API key", re: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, public: true },
];

/** Provider keys in `text` or its percent-decoding, each with a sample that names it without repeating it. */
export function providerKeys(text: string): { what: string; sample: string; public: boolean }[] {
  const out = new Map<string, { what: string; sample: string; public: boolean }>();
  for (const t of new Set([text, pctDecode(text, false)]))
    for (const k of PROVIDER_KEYS)
      for (const [m] of t.matchAll(k.re))
        if (!k.random || (m.match(/[A-Za-z0-9]{16,}/g) ?? []).some(RANDOM))
          out.set(m, { what: k.what, sample: `${m.slice(0, 8)}...`, public: !!k.public });
  return [...out.values()];
}

/** Base64 (or base64url) runs that decode to text. */
function base64Texts(s: string): string[] {
  return [...s.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)]
    .map((m) => Buffer.from(m[0], "base64").toString("utf8"))
    .filter((t) => t && !/[\uFFFD\x00-\x08\x0e-\x1f]/.test(t));
}

/**
 * A test for text that holds `value` base64-encoded, whatever stands before or after it. Decoding
 * the text whole does not find that: text in front shifts every byte, and a short value's run is
 * too short to tell from a word. So the value's own encoding is looked for, at each of the three
 * byte offsets and in the standard and the URL-safe alphabet, without the characters that also
 * carry a neighbouring byte. Those characters carry bits of the value too, so another value can
 * share what is left ("xqbcdef" with "abcdef"): a find only says where to look, and the bytes
 * decoded there, at that offset, must be the value's.
 */
function base64Places(value: string) {
  const bytes = Buffer.from(value, "utf8");
  return [0, 1, 2].flatMap((lead) => {
    const whole = Buffer.concat([Buffer.alloc(lead), bytes])
      .toString("base64")
      .replace(/=+$/, "");
    // the first characters hold the bytes in front, and the last one bits of the byte that follows
    const skip = [0, 2, 3][lead]!;
    const core = whole.slice(skip, (lead + bytes.length) % 3 ? -1 : undefined);
    const cores = new Set([core, core.replace(/\+/g, "-").replace(/\//g, "_")]);
    return [...cores].map((c) => ({ core: c, lead, skip, length: whole.length }));
  });
}

function inBase64(value: string): (text: string) => boolean {
  const bytes = Buffer.from(value, "utf8");
  const places = base64Places(value);
  return (text) =>
    places.some(({ core, lead, skip, length }) => {
      for (let i = text.indexOf(core); i >= 0; i = text.indexOf(core, i + 1)) {
        if (i < skip) continue;
        const there = Buffer.from(text.slice(i - skip, i - skip + length), "base64");
        if (there.subarray(lead, lead + bytes.length).equals(bytes)) return true;
      }
      return false;
    });
}

/**
 * Every text a spec string may hide a value in: percent-decoded (+ as a space or not),
 * JSON-unescaped (`\/`, `\u002b`), HTML character references read (`&#43;`, `&#x2b;`) and base64
 * runs decoded, in any order, up to 3 layers deep.
 */
function decodings(v: string): Set<string> {
  const out = new Set([v]);
  let frontier = [v];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const d of [pctDecode(f, false), pctDecode(f, true), jsonUnescape(f), htmlCharRefs(f), ...base64Texts(f)]) {
        if (out.has(d)) continue;
        out.add(d);
        next.push(d);
      }
    }
    frontier = next;
  }
  return out;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;
/** A literal IP address (a client's remoteHost the page reported): the user's, not the site's. */
const ipAddress = (v: string) =>
  (IPV4.test(v) && !/^(127\.|0\.)|\.0$/.test(v)) ||
  (IPV6.test(v) && (v.includes("::") || v.split(":").length >= 5) && v !== "::1");
/**
 * An IP address anywhere in a leaf: the whole value, "ip:port", an x-forwarded-for list, "ip=.."
 * text. A version string is not one: "Chrome/120.0.0.0" follows a letter or "/", and ends in .0;
 * "1.3.6.68.gbe30f56" runs on into a word.
 */
export function ipIn(v: string): string | undefined {
  for (const m of v.matchAll(/[0-9A-Fa-f:.]+/g)) {
    const before = v[m.index - 1] ?? "";
    let t = m[0].replace(/^[.:]+|[.:]+$/g, "");
    if (t.includes(".")) t = t.replace(/:\d{1,5}$/, ""); // ip:port
    const after = v[m.index + m[0].length] ?? "";
    // a version: v1.2.3.4, Chrome/1.2.3.4, 1.3.6.68.gbe30f56 (a build hash after it)
    if (t.includes(".") && (/[\w/]/.test(before) || /\w/.test(after))) continue;
    if (ipAddress(t)) return t;
  }
  return undefined;
}

/** The addresses an operation sends to or opens. */
export const opUrls = (op: { request: { url: string }; trigger: { url: string; softFrom?: string } }) => [
  op.request.url,
  op.trigger.url,
  op.trigger.softFrom,
];

/** The origins of `urls` (`https://www.x.test`), the http(s) ones whose host is no template. */
export function originsOf(urls: readonly (string | undefined)[]): Set<string> {
  const origins = new Set<string>();
  for (const u of urls) {
    try {
      if (u && /^https?:/i.test(u)) origins.add(new URL(u).origin);
    } catch {
      /* a template the host is filled into: no origin to spell */
    }
  }
  return origins;
}

/** A browser's User-Agent kept in page storage: a learned request sends the same header anyway. */
const BROWSER_UA = /^Mozilla\/5\.0 \([^)]+\) \S/;

/**
 * The session without the values that are one of the origins of `urls` (`https://www.x.test/`, the
 * last page an analytics cookie kept), one of their hosts or parent domains (`www.x.test`,
 * `.x.test`), or a browser's User-Agent, raw, unquoted or URL-decoded. A spec spells the host it
 * sends to and opens, and sends the browser's headers, so such a value carries nothing the spec does
 * not hold already, wherever a copy of it is: it is no credential to look for, and nothing to make a
 * ref of. A URL with a path, query or fragment is still looked for: a reset link carries a token.
 */
export function besideOrigins<S extends Pick<Session, "cookies" | "values">>(
  session: S,
  urls: readonly (string | undefined)[],
): S {
  const origins = originsOf(urls);
  // a host the spec spells, or a parent domain of one (a cookie's `.x.test` copied into its value)
  const hosts = new Set<string>();
  for (const o of origins) {
    const host = new URL(o).hostname;
    const labels = host.split(".");
    if (ipAddress(host.replace(/^\[|\]$/g, ""))) hosts.add(host);
    else for (let i = 0; i < labels.length - 1; i++) hosts.add(labels.slice(i).join("."));
  }
  const own = (v: string) =>
    [v, v.replace(/^"|"$/g, ""), pctDecode(v, false)].some(
      (f) => origins.has(f.replace(/\/$/, "")) || hosts.has(f.replace(/^\./, "").toLowerCase()) || BROWSER_UA.test(f),
    );
  return {
    ...session,
    cookies: session.cookies.filter((c) => !own(c.value)),
    values: Object.fromEntries(Object.entries(session.values).filter(([, v]) => !own(v))),
  };
}

/** A live value as it is stored, unquoted and URL-decoded: the forms the scan and redaction look for, 6+ chars. */
const storedForms = (v: string) =>
  [...new Set([v, v.replace(/^"|"$/g, ""), pctDecode(v, false)])].filter((f) => f.length >= 6);

export const REDACTED = "[redacted]";
// A cut can leave this much of a value at the end of a text; less says nothing about it.
const PARTIAL = 4;
const ORIGIN = /^https?:\/\/[^/?#]+\/?$/i;
const htmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Live = { label: string; form: string; encoded: (text: string) => boolean };

/** The exact live values a text is searched for: each stored form, with its base64 test. */
function liveValues(session: Pick<Session, "cookies" | "values">, skip?: RegExp): Live[] {
  const live: Live[] = [];
  const add = (label: string, v: string) => {
    for (const form of storedForms(v)) if (!skip?.test(form)) live.push({ label, form, encoded: inBase64(form) });
  };
  for (const c of session.cookies) add(`cookie ${c.name}`, c.value);
  for (const [k, v] of Object.entries(session.values)) add(`session value ${k}`, v);
  return live;
}

const holds = (decoded: string[], l: Live) => decoded.some((d) => d.includes(l.form) || l.encoded(d));

/** `liveIn` for one session, set up once to ask of several texts. */
function liveTest(session: Pick<Session, "cookies" | "values">): (text: string) => boolean {
  const live = liveValues(session, ORIGIN);
  return (text) => {
    if (!live.length || !text) return false;
    const decoded = [...decodings(text)];
    return live.some((l) => holds(decoded, l));
  };
}

/**
 * Whether `text` holds a live cookie or session value, exactly: in any layer `decodings` reads, or
 * base64-encoded at any byte offset. The values are the ones `redact` replaces (6+ chars, origins
 * left out); the shape heuristics of `scanSecrets` play no part, since they misfire.
 */
export const liveIn = (text: string, session: Pick<Session, "cookies" | "values">) => liveTest(session)(text);

/** What a redacted text says instead when a live value is left in it after the replacements. */
export const OMITTED = "[left out: it holds a session value]";

/**
 * `text` with every live cookie and session value in it replaced by `[redacted]`: each stored form
 * (as stored, unquoted, URL-decoded) as it is and percent-encoded, form-encoded, JSON-escaped,
 * HTML-escaped and base64-encoded at any byte offset. The text is otherwise left as it is: it can be
 * a body `inspect` shows. `cut`: the text was cut short (a body's snippet), so a value the cut split leaves its first
 * characters at the end: those go too. A value that is an origin (`https://www.x.test/`, an analytics
 * cookie's last page) is the site's address, not a credential, and is left (see `besideOrigins`).
 * `named`: each value is replaced by the ref that would stand there, `[cookie:x]` or `[session:x]`.
 *
 * It fails closed: a replacement cannot reach every encoding, so the result is then read the way
 * `scanSecrets` reads a spec (`liveIn`), and a text still holding a live value is replaced by
 * `OMITTED`, after its lead ("HTTP 401") when the lead holds none, `named` or not. Which value it was
 * is not said.
 */
export function redact(
  text: string,
  session: Pick<Session, "cookies" | "values">,
  o: { cut?: boolean; named?: boolean } = {},
): string {
  const forms = new Map<string, string>();
  /** each stored form with its replacement: what a JSON-escaped cut tail is read against */
  const stored: [string, string][] = [];
  const live: [string, string][] = [
    ...session.cookies.map((c): [string, string] => [c.value, `cookie:${c.name}`]),
    ...Object.entries(session.values).map(([k, v]): [string, string] => [v, `session:${k}`]),
  ];
  for (const [v, ref] of live) {
    const as = o.named ? `[${ref}]` : REDACTED;
    for (const f of storedForms(v)) {
      if (ORIGIN.test(f)) continue;
      stored.push([f, as]);
      const pct = encodeURIComponent(f);
      for (const g of [f, pct, pct.replace(/%20/g, "+"), JSON.stringify(f).slice(1, -1), htmlEscape(f)])
        if (!forms.has(g)) forms.set(g, as);
      for (const { core } of base64Places(f)) if (core.length >= 8 && !forms.has(core)) forms.set(core, as);
    }
  }
  if (!forms.size || !text) return text;
  const closed = (out: string) => failClosed(out, session);
  const longest = [...forms.keys()].sort((a, b) => b.length - a.length);
  const whole = (t: string) => {
    for (const f of longest) if (t.includes(f)) t = t.split(f).join(forms.get(f));
    return t;
  };
  if (!o.cut) return closed(whole(text));
  // A cut text can end in the first characters of a value, raw or spelled in escapes no form holds
  // (\u0053, \/), and one value can end it right after another's start. Read the text as it came, before
  // any value is replaced, and take such tails off its end one at a time; then replace whole values in
  // what is left. The escapes are decoded for this test alone: the text keeps the ones it has.
  const max = Math.max(...stored.map(([f]) => f.length));
  /** where a value's start that ends `t` begins, and what stands in for it */
  const tail = (t: string): [number, string] | undefined => {
    let best: [number, string] | undefined;
    for (const f of longest)
      for (let n = Math.min(f.length, t.length); n >= PARTIAL; n--)
        if (t.endsWith(f.slice(0, n))) {
          if (!best || t.length - n < best[0]) best = [t.length - n, forms.get(f)!];
          break;
        }
    for (let k = Math.max(0, t.length - 6 * max); k <= t.length - PARTIAL && k < (best?.[0] ?? t.length); k++) {
      if (!t.includes("\\", k)) break;
      // a cut inside an escape leaves its start, which reads as nothing yet
      const d = jsonUnescape(t.slice(k).replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, ""));
      const hit = d.length >= PARTIAL && stored.find(([f]) => f.startsWith(d));
      if (hit) return [k, hit[1]];
    }
    return best;
  };
  let head = text;
  const instead: string[] = [];
  for (let t = tail(head); t; t = tail(head)) {
    head = head.slice(0, t[0]);
    if (instead[0] !== t[1]) instead.unshift(t[1]);
  }
  return closed(whole(head) + instead.join(""));
}

/** `redact`'s last step: a text that still holds a live value is left out, by a note that spells none. */
function failClosed(out: string, session: Pick<Session, "cookies" | "values">): string {
  const leaks = liveTest(session);
  if (!leaks(out)) return out;
  const i = out.indexOf(": ");
  const lead = i > 0 ? out.slice(0, i) : "";
  // the sentence that stands in must not spell the value itself ("session", "redacted")
  const instead = lead && !leaks(lead) ? [`${lead}: ${OMITTED}`, `${lead}: ${REDACTED}`, lead] : [OMITTED, REDACTED];
  return instead.find((t) => !leaks(t)) ?? "";
}

/**
 * What a capture holds live, for `redact` to take out of the URLs shown of it: the run's cookies and
 * web storage. `keep`: the user's own example values, which a URL shows as they are.
 */
export function captureLive(
  c: Pick<CaptureResult, "cookies" | "storage">,
  keep: readonly string[] = [],
): Pick<Session, "cookies" | "values"> {
  const own = new Set(keep.map((v) => v.toLowerCase()));
  return {
    cookies: c.cookies.filter((k) => !own.has(k.value.toLowerCase())),
    values: Object.fromEntries(Object.entries(c.storage ?? {}).filter(([, v]) => !own.has(v.toLowerCase()))),
  };
}

/**
 * `secrets`: exact hits of live jar/session values (6+ chars, raw, unquoted or URL-decoded). Each
 * is looked for in the text and in what the text decodes to (three layers of percent-encoding,
 * JSON escapes and whole base64 runs), and by its own base64 encoding at any byte offset, confirmed
 * by decoding there. A hit is the value itself, so callers fail closed. `warnings`: regex heuristics, which do misfire.
 * `allowed`: JSON paths a human marked public (an op's `public` headers); skipped.
 */
export function scanSecrets(
  value: unknown,
  session: Session,
  allowed: Set<string> = new Set(),
): { secrets: string[]; warnings: string[] } {
  const live = liveValues(session);
  const secrets: string[] = [];
  const warnings: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (allowed.has(path)) return;
    if (typeof v === "string") {
      const decoded = live.length ? [...decodings(v)] : [];
      for (const l of live) if (holds(decoded, l)) secrets.push(`${path} holds the live ${l.label}`);
      const text = pctDecode(v, false); // percent-encoded bodies hide the blob's shape
      const hit = (
        [
          ["a JWT", JWT],
          ["a bearer token", BEARER],
          ["a long hex blob", HEX_BLOB],
          ["a long base64 blob", BASE64_BLOB],
        ] as const
      )
        .map(
          ([why, re]) =>
            [
              why,
              [...text.matchAll(new RegExp(re, "g"))]
                .map((m) => m[0])
                .find((m) => why !== "a long base64 blob" || RANDOM(m)),
            ] as const,
        )
        .find(([, m]) => m);
      if (hit) warnings.push(`${path} looks like ${hit[0]} (${hit[1]!.slice(0, 24)}...); check it is public`);
    } else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) visit(x, `${path}[${i}]`);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, `${path}.${k}`);
  };
  visit(value, "$");
  return { secrets: [...new Set(secrets)], warnings: [...new Set(warnings)] };
}

/**
 * The session a save-time scan looks for. Learning records which of a site's session values are
 * settings (a theme, a locale: a ref keeps one fresh, it does not make it secret), and a recorded
 * setting is left out of the scan only when all four hold: it is no JSON container (one carries
 * credentials whose own refs were dropped, and a refresh can put a new one in); its own text is no
 * credential; no protected text holds it, in any encoding the scan reads (a setting also sent as a
 * bearer is a copy of that bearer); and it holds no protected value. Protected is every cookie and
 * every session value that is not itself a candidate: a credential classification of the same bytes
 * wins, and no later learn undoes one. A setting that loses its exemption is protected in turn, and
 * the last two tests are asked again against it until nothing more is protected: the scan reads a few
 * decoding layers, so a chain of settings would otherwise carry a credential further than any one of
 * them can. A name no learn classified, an older file's included, is scanned like a credential. This runs twice over:
 * once where a learn classifies what it stored, over everything it saw live, since a credential it did not store is
 * gone by the time a save-time scan asks, and a setting it did not store is entered there as a link in that chain
 * (`sessionRefs`); and at every session write, which records what it keeps
 * (`recordProtection`), so a rotation cannot take a protection apart.
 */
export function credentialsOf(session: Session): Session {
  const kinds = session.kinds ?? {};
  const entries = Object.entries(session.values);
  if (!entries.some(([k]) => kinds[k] === "setting")) return session;
  const shaped = (v: string) => highEntropy(v) || scanSecrets(v, { cookies: [], values: {} }).warnings.length > 0;
  // What may be left out at all: a recorded setting that is no container and no credential itself.
  const candidate = (k: string, v: string) => kinds[k] === "setting" && !jsonContainer(v) && !shaped(v);
  // Everything a credential classification protects, grown to a fixpoint. A candidate is never
  // scanned against itself: only what is already protected is on either side of the two tests.
  const kept = new Set(entries.filter(([k, v]) => !candidate(k, v)).map(([k]) => k));
  for (let grew = true; grew; ) {
    grew = false;
    const values = Object.fromEntries(entries.filter(([k]) => kept.has(k)));
    const protect: Session = { cookies: session.cookies, values };
    const texts = [...session.cookies.map((c) => c.value), ...Object.values(values)];
    const open = entries.filter(([k]) => !kept.has(k));
    // Both tests as one scan each: a scan's cost is its setup (a live list, each text's decodings), so
    // asking per value costs as many scans as there are values. The index each side reports names the
    // value: the label in what a protected text holds, the path in what a value holds.
    const hit = new Set<number>();
    const live = Object.fromEntries(open.map(([, v], i) => [String(i), v]));
    for (const s of scanSecrets(texts, { cookies: [], values: live }).secrets) hit.add(Number(s.split(" ").pop()));
    for (const s of scanSecrets(
      open.map(([, v]) => v),
      protect,
    ).secrets)
      hit.add(Number(/^\$\[(\d+)\]/.exec(s)![1]));
    for (const i of hit) {
      kept.add(open[i]![0]);
      grew = true;
    }
  }
  return { ...session, values: Object.fromEntries(entries.filter(([k]) => kept.has(k))) };
}
