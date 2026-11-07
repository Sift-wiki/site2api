import assert from "node:assert/strict";
import { test } from "node:test";
import {
  borderlineCredentials,
  captureLive,
  liveIn,
  OMITTED,
  REDACTED,
  redact,
  scanSecrets,
  signInFills,
} from "../src/secrets.js";
import type { Session } from "../src/session.js";

const TOKEN = "Tk4Rf9Lp2Wq7Zx3Nm8Vb";
const SPACED = "a b/c+d=e&f Long Enough";
const session = {
  cookies: [
    { name: "sid", value: TOKEN, domain: "x.test", path: "/", expires: -1, httpOnly: true, secure: true },
    {
      name: "last",
      value: "https://www.x.test/",
      domain: "x.test",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
    },
    { name: "short", value: "abc", domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: false },
  ],
  values: { csrf: `"${SPACED}"` },
};

test("redact: every encoding a body can echo a live value in", () => {
  const b64 = Buffer.from(TOKEN).toString("base64");
  const forms = [
    TOKEN,
    encodeURIComponent(SPACED),
    encodeURIComponent(SPACED).replace(/%20/g, "+"),
    JSON.stringify(SPACED).slice(1, -1),
    SPACED.replace(/&/g, "&amp;"),
    b64,
    Buffer.from(`Basic:${TOKEN}`).toString("base64"), // at another byte offset
    Buffer.from(TOKEN).toString("base64url"),
  ];
  for (const f of forms) {
    const out = redact(`HTTP 401: token ${f} refused`, session);
    assert.ok(out.includes(REDACTED), `${f}: ${out}`);
    assert.ok(!out.includes(TOKEN) && !out.includes(SPACED), out);
  }
});

test("redact: a value a JSON body spells in \\u escapes, all of it or some", () => {
  const u = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  for (const f of [[...TOKEN].map(u).join(""), [...TOKEN].map((c, i) => (i % 2 ? u(c) : c)).join("")]) {
    // no replacement reaches it; the fail-closed read of JSON escapes does
    assert.equal(redact(`HTTP 401: {"error":"invalid session ${f}"}`, session), `HTTP 401: ${OMITTED}`);
  }
  // escapes that spell no live value stay as they are: a body inspect shows is still valid JSON
  const body = String.raw`{"title":"say \u0022hi\u0022"}`;
  assert.equal(redact(body, session), body);
});

test("redact: a cut value spelled in JSON escapes leaves none of its first characters at the end", () => {
  const u = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const ends = [
    u(TOKEN[0]!) + TOKEN.slice(1, 10), // the first character escaped
    [...TOKEN.slice(0, 6)].map(u).join(""), // every one
    `${[...TOKEN.slice(0, 6)].map(u).join("")}\\u00`, // cut inside an escape
  ];
  for (const end of ends)
    assert.equal(
      redact(`HTTP 401: {"error":"bad ${end}`, session, { cut: true }),
      `HTTP 401: {"error":"bad ${REDACTED}`,
    );
  assert.equal(
    redact(`HTTP 401: {"error":"bad ${ends[0]}`, session, { cut: true, named: true }),
    `HTTP 401: {"error":"bad [cookie:sid]`,
  );
  // a base64 value holds "/", which PHP and Java write as \/
  const slashed = `${TOKEN.slice(0, 6)}/${TOKEN.slice(6)}`;
  const s = { cookies: [], values: { k: slashed } };
  assert.equal(
    redact(`HTTP 401: {"error":"bad ${slashed.slice(0, 12).replace("/", "\\/")}`, s, { cut: true }),
    `HTTP 401: {"error":"bad ${REDACTED}`,
  );
  // escapes that spell no live value stay as they are, cut or not
  const body = String.raw`{"title":"say \u0022hi\u0022"}`;
  assert.equal(redact(body, session, { cut: true }), body);
});

test("redact: a cut value's escaped start goes even when its raw rest is another value's prefix", () => {
  const u = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: "x.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
  });
  // the text ends in "kettle" escaped, then "sessio": the start of the other value too
  const both = { cookies: [cookie("a", "session"), cookie("b", "kettlesessionMore")], values: {} };
  const text = `HTTP 401: {"e":"${[..."kettle"].map(u).join("")}sessio`;
  assert.equal(redact(text, both, { cut: true }), `HTTP 401: {"e":"${REDACTED}`);
  assert.equal(redact(text, both, { cut: true, named: true }), `HTTP 401: {"e":"[cookie:b]`);
  // a raw tail with no escapes before it is cut where it starts, as before
  assert.equal(redact(`HTTP 401: {"e":"plain sessio`, both, { cut: true }), `HTTP 401: {"e":"plain ${REDACTED}`);
  // the other value whole after it, which a replacement would rewrite before the cut is read
  const whole = `HTTP 401: {"e":"${[..."kettle"].map(u).join("")}session`;
  assert.equal(redact(whole, both, { cut: true }), `HTTP 401: {"e":"${REDACTED}`);
  // a raw tail that does not go on with the escaped value: each start is taken off the end in turn
  const apart = { cookies: [cookie("a", "session"), cookie("b", "mK7pQ2ZZZZZZ")], values: {} };
  const two = `HTTP 401: {"e":"${[..."mK7pQ2"].map(u).join("")}sessio`;
  assert.equal(redact(two, apart, { cut: true }), `HTTP 401: {"e":"${REDACTED}`);
  assert.equal(redact(two, apart, { cut: true, named: true }), `HTTP 401: {"e":"[cookie:b][cookie:a]`);
});

test("redact: the sentence left in a text's place never spells the value it hides", () => {
  const cookie = (name: string, value: string) => ({
    name,
    value,
    domain: "x.test",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
  });
  // "session" is in OMITTED's sentence, "redacted" in REDACTED
  const one = { cookies: [cookie("a", "session")], values: {} };
  const two = { cookies: [cookie("a", "session"), cookie("b", "redacted")], values: {} };
  const text = String.raw`HTTP 401: \u0073ession`;
  assert.equal(redact(text, one), `HTTP 401: ${REDACTED}`);
  assert.equal(redact(text, two), "HTTP 401");
  assert.equal(redact(String.raw`\u0073ession: \u0073ession`, two), "");
});

test("redact: the site's own address, short values and ordinary text are left alone", () => {
  const text = "redirected to https://www.x.test/ with abc; no session here";
  assert.equal(redact(text, session), text);
  assert.equal(redact(text, session, { cut: true }), text);
});

test("redact: a value a cut split leaves none of its first characters at the end", () => {
  for (const n of [4, 9, TOKEN.length - 1]) {
    const out = redact(`HTTP 401: session ${TOKEN.slice(0, n)}`, session, { cut: true });
    assert.equal(out, `HTTP 401: session ${REDACTED}`, String(n));
  }
  // under 4 characters says nothing about the value; without cut nothing is dropped
  assert.equal(redact(`ends in ${TOKEN.slice(0, 3)}`, session, { cut: true }), `ends in ${TOKEN.slice(0, 3)}`);
  assert.equal(redact(`ends in ${TOKEN.slice(0, 9)}`, session), `ends in ${TOKEN.slice(0, 9)}`);
});

// A value with the characters encodings treat apart: base64 of it holds / and +, and p and + have entities.
const ODD = "Wq7?Lp2>Wx9~Zr4+Nd8";
const odd = { cookies: [], values: { k: ODD } };

test("redact: a live value left in an encoding the replacements miss takes the response out, the lead kept", () => {
  const b64 = Buffer.from(ODD).toString("base64");
  const leaks: [Pick<Session, "cookies" | "values">, string, string][] = [
    [session, TOKEN, `%54${TOKEN.slice(1)}`], // only the first byte percent-escaped
    [session, TOKEN, `%2554${TOKEN.slice(1)}`], // that escape escaped again
    [session, TOKEN, Buffer.from(`%54${TOKEN.slice(1)}`).toString("base64")],
    [odd, ODD, encodeURIComponent(b64)],
    [odd, ODD, encodeURIComponent(ODD).replace(/%3F/g, "%3f")],
    [odd, ODD, ODD.replace("p", "&#112;")],
    [odd, ODD, ODD.replace("p", "&#x70;")],
    [odd, ODD, ODD.replace("+", "&#43;")], // Go's html/template
  ];
  for (const [s, value, f] of leaks)
    for (const cut of [false, true]) {
      const out = redact(`HTTP 401: invalid session ${f}; try again`, s, { cut });
      assert.equal(out, `HTTP 401: ${OMITTED}`, f);
      assert.ok(!liveIn(out, s), f);
      assert.ok(!out.includes(value), out);
    }
});

test("redact: a lead that holds the value itself is left out with the rest", () => {
  assert.equal(redact(`session %54${TOKEN.slice(1)}: refused`, session), OMITTED);
});

test("redact: text that only looks like a token, and no live value, is left alone", () => {
  // built here, so the secret scan of this repository finds no token-shaped literal
  const part = (s: string) => Buffer.from(s).toString("base64url");
  const jwt = [part('{"alg":"HS256"}'), part('{"sub":"Q7xK2pL9vR4mT8"}'), part("signature-for-this-jwt")].join(".");
  const text = `HTTP 401: token ${jwt} expired at https://www.x.test/ for abc`;
  // only the heuristics see it: a JWT shape, which no live value is
  assert.ok(scanSecrets(text, session).warnings.length);
  assert.ok(!liveIn(text, session));
  assert.equal(redact(text, session), text);
  assert.equal(redact(text, session, { cut: true }), text);
});

test("liveIn: reads HTML character references, the origin and short values are no live value", () => {
  assert.ok(liveIn(`<p>${[...TOKEN].map((c) => `&#${c.charCodeAt(0)};`).join("")}</p>`, session));
  assert.ok(liveIn(`<p>${ODD.replace("+", "&#x2B;")}</p>`, odd));
  assert.ok(!liveIn("see https://www.x.test/ and abc", session));
  assert.ok(scanSecrets(ODD.replace("+", "&#43;"), odd).secrets.length);
});

test("redact named: each live value becomes the ref that would stand there", () => {
  const url = `https://x.test/api?q=pizza&access_token=${TOKEN}&c=${encodeURIComponent(SPACED)}`;
  assert.equal(
    redact(url, session, { named: true }),
    "https://x.test/api?q=pizza&access_token=[cookie:sid]&c=[session:csrf]",
  );
});

test("captureLive: a capture's cookies and storage, without the user's own example values", () => {
  const cookie = (name: string, value: string) => ({ ...session.cookies[0]!, name, value });
  const live = captureLive(
    {
      cookies: [cookie("sid", TOKEN), cookie("last", "Pizza-Place")],
      storage: { tok: "st0r3dT0kenValue9", q: "pizza-place" },
    },
    ["pizza-place"],
  );
  assert.deepEqual(
    live.cookies.map((c) => c.name),
    ["sid"],
  );
  assert.deepEqual(live.values, { tok: "st0r3dT0kenValue9" });
  assert.equal(
    redact("/api?q=pizza-place&t=st0r3dT0kenValue9", live, { named: true }),
    "/api?q=pizza-place&t=[session:tok]",
  );
});

test("signInFills: a step typing into a password or code field, or a password-like literal, is a sign-in's", () => {
  const fill = (selector: string, value = "{q}") => ({ action: "fill" as const, selector, value });
  for (const selector of [
    "#pw",
    "input[type=password]",
    'input[type="password"]',
    "#login_pwd",
    "input[name=passwd]",
    "#user-password",
    "[autocomplete=current-password]",
    "[autocomplete=one-time-code]",
    "#otp",
    "input[name=totp_code]",
    "#mfa-code",
    "input[name=pass]",
    "#user_pass",
    "input[name='pass']",
  ])
    assert.equal(signInFills([fill(selector, "x")]).length, 1, selector);
  const [why] = signInFills([{ action: "click", selector: "#go" }, fill("#q", "Hunter2-RealPassw0rd!")]);
  assert.match(
    why!,
    /^steps\[1\] types a literal that looks like a password: a sign-in is the user's: ask them to run api-anything login/,
  );
  // a search box, a footprint filter, a passport number field, params the call fills, words
  for (const s of [
    fill("#q"),
    fill("#footprint"),
    fill("input[name=passport]"),
    fill("input[name=passenger]"),
    fill("#compass"),
    fill("#bypass-cache"),
    fill("#search", "{user}-{q}"),
    fill("#q", "new york pizza"),
  ])
    assert.deepEqual(signInFills([s]), [], s.selector);
});

test("the strict pass reports the values the scan deliberately lets through, and never a normal one", () => {
  const req = (headers: Record<string, string>) => ({ method: "GET", url: "https://x.test/a", headers });
  const spec = {
    operations: [
      {
        name: "op",
        request: req({
          "x-session-id": "12345",
          "x-auth-token": "plain",
          "x-api-key": "plainword",
          authorization: `Bearer ${TOKEN}`,
          accept: "application/json",
        }),
        slots: [],
      },
    ],
  };
  const found = borderlineCredentials(spec as never);
  assert.ok(found.some((f) => /a number under x-session-id/.test(f)), found.join("\n"));
  assert.ok(found.some((f) => /5 characters under x-auth-token/.test(f)), found.join("\n"));
  assert.ok(found.some((f) => /plain-looking value under x-api-key/.test(f)), found.join("\n"));
  // a live credential is the ordinary scan's refusal, not a borderline report
  assert.ok(!found.some((f) => /authorization/.test(f)), found.join("\n"));
  assert.ok(!found.some((f) => /accept/.test(f)), found.join("\n"));
});
