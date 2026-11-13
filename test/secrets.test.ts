import assert from "node:assert/strict";
import { test } from "node:test";
import { captureLive, liveIn, OMITTED, REDACTED, redact, scanSecrets, signInFills } from "../src/secrets.js";
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

const TICKET = "vRf7Qm2ZkL9xT4cN8bW1yH6pD3sJ5gUa";
const jarOf = (value: string, name = "userinfo"): Session => ({
  cookies: [{ name, value, domain: "x.test", path: "/", expires: -1, httpOnly: false, secure: false }],
  values: {},
});
const enc = encodeURIComponent;
const b64 = (text: string) => Buffer.from(text).toString("base64");

test("scanSecrets finds a token a cookie holds as one part of it, however the cookie is put together", () => {
  // [what, the cookie, what the page sends of it]
  const caught: [string, string, string][] = [
    ["URL-encoded JSON", enc(JSON.stringify({ id: 42, name: "Jane Dummy", ticket: TICKET })), TICKET],
    ["k=v text", enc(`uid=42&name=Jane Dummy&ticket=${TICKET}`), TICKET],
    ["encoded twice", enc(enc(`uid=42&ticket=${TICKET}`)), TICKET],
    ["a|b", `42|${TICKET}`, TICKET],
    ["base64 of JSON", b64(JSON.stringify({ id: 42, ticket: TICKET })), TICKET],
    ["base64 of base64", b64(b64(JSON.stringify({ t: TICKET }))), TICKET],
    ["a signed value, token.signature", `${TICKET}.Zx81kkQpLm20asDFgh77qwErTy`, TICKET],
    ["s:token.signature, encoded", enc(`s:${TICKET}.Zx81kkQpLm20asDFgh77qwErTy`), TICKET],
    ["id-token", `42-${TICKET}`, TICKET],
    ["v1_token", `v1_${TICKET}`, TICKET],
    ["id!token", `42!${TICKET}`, TICKET],
    ["id~token", `42~${TICKET}`, TICKET],
    ["a JSON string with a \\u escape in it", `{"t":"vRf\\u0037${TICKET.slice(4)}"}`, TICKET],
    ["a token cut short", `42|${TICKET}`, TICKET.slice(0, 24)],
    ["24 digits", enc(JSON.stringify({ id: 42, ticket: "839201746501928374650192" })), "839201746501928374650192"],
    ["15 characters", enc(JSON.stringify({ id: 42, ticket: "aB3dE5fG7hJ9kL2" })), "aB3dE5fG7hJ9kL2"],
    [
      "base64 whose pieces between / are short",
      enc(JSON.stringify({ id: 42, ticket: "aB3d/E5fG7hJ9+k/L2mN4pQ6rS8tU0" })),
      "aB3d/E5fG7hJ9+k/L2mN4pQ6rS8tU0",
    ],
    [
      "a UUID",
      enc(JSON.stringify({ device: "3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b" })),
      "3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b",
    ],
  ];
  for (const [what, value, sent] of caught) {
    assert.deepEqual(
      scanSecrets({ request: { headers: { "x-member-ticket": sent } } }, jarOf(value)).secrets,
      ["$.request.headers.x-member-ticket holds the live cookie userinfo"],
      what,
    );
    // inside longer text, and in the layers the scan reads for a whole value
    assert.equal(scanSecrets({ h: `Bearer ${sent}` }, jarOf(value)).secrets.length, 1, `${what}, beside other text`);
    assert.equal(scanSecrets({ body: b64(`ticket:${sent}`) }, jarOf(value)).secrets.length, 1, `${what}, in base64`);
    // a text holding the whole cookie holds its parts too: one finding, not two
    assert.equal(scanSecrets({ cookie: value }, jarOf(value)).secrets.length, 1, `${what}, whole`);
  }
  // letters of one case are words more often than a token: a part only where they are all a value holds
  const letters = "qwertyuiopasdfghjklzxcvbnm";
  const held = jarOf(enc(JSON.stringify({ id: 42, t: letters })));
  assert.equal(scanSecrets({ request: { headers: { "x-t": letters } } }, held).secrets.length, 1);
  assert.deepEqual(scanSecrets({ request: { body: `{"${letters}":1}`, note: `see ${letters}` } }, held).secrets, []);
});

test("scanSecrets takes no ordinary text for a part of a cookie: an address, the caller's own values, words", () => {
  // OneTrust's consent cookie keeps the address of the first page of the visit
  const consent = (landing: string) =>
    `isGpcEnabled=0&datestamp=Thu+Nov+12+2026+10%3A00%3A00+GMT-0800&version=202403.1.0&interactionCount=1&landingPath=${enc(landing)}&groups=C0001%3A1%2CC0002%3A1&AwaitingReconsent=false`;
  const op = (host: string, q: string, page = `https://${host}/search?q={q}`, path = "/api/search") => ({
    name: "search",
    request: { method: "GET", url: `https://${host}${path}?q=${enc(q)}`, headers: { origin: `https://${host}` } },
    slots: [{ param: "q", at: ["query:q"] }],
    params: [{ name: "q", example: q }],
    trigger: { url: page },
  });
  const uuid = "3f2b8c1e-9d4a-4e7b-8a6f-1c2d3e4f5a6b";
  const id = "4Z8W4fKeB5YxbusRsdQVPb";
  const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const jwt = `${header}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
  // [what, the cookie, the spec]: each was saved before a cookie's parts were looked for
  const free: [string, string, unknown][] = [
    [
      "the site's own host, with a digit in it",
      consent("https://www.forever21.com/us/shop"),
      op("www.forever21.com", "lanterns"),
    ],
    [
      "a host with a long label",
      consent("https://www.internationalshipping.example/us/shop"),
      op("www.internationalshipping.example", "lanterns"),
    ],
    [
      "the caller's example, which the landing page's address holds",
      consent("https://www.shop.test/search?q=garden-lanterns-2026"),
      op("www.shop.test", "garden-lanterns-2026"),
    ],
    [
      "an id the caller asked for, kept as the last one viewed",
      enc(JSON.stringify({ last: uuid })),
      op("www.shop.test", uuid),
    ],
    [
      "a list of the ids viewed",
      enc(`B0CHX1W1XYZ42,${uuid},839201746501928374650192`),
      op("www.shop.test", "839201746501928374650192"),
    ],
    [
      "an id in the page address the caller gave, and in the request it loads",
      consent(`https://www.shop.test/artist/${id}/albums?q=lanterns`),
      op("www.shop.test", "lanterns", `https://www.shop.test/artist/${id}/albums?q={q}`, `/api/artist/${id}/albums`),
    ],
    [
      "a check's args, which a later visit put in the cookie",
      enc(JSON.stringify({ last: uuid })),
      { ...op("www.shop.test", "lanterns"), checks: [{ args: { q: uuid }, expect: "result" }] },
    ],
    [
      "the names a consent cookie gives its fields",
      consent("NotLandingPage"),
      { request: { body: '{"interactionCount":1,"AwaitingReconsent":false}' }, pick: ["interactionCount"] },
    ],
    [
      "an address and a sentence, percent-encoded in both",
      consent("https://www.shop.test/app/504230/?q=Flights from SFO to NYC on 2027-04-15"),
      {
        url: "https://www.shop.test/api?origin=https%3A%2F%2Fwww.shop.test&q=Flights%20from%20SFO%20to%20NYC%20on%202027-04-15",
      },
    ],
    ["a word", enc(JSON.stringify({ theme: "solarized-dark", plan: "free", id: 42 })), { v: "solarized-dark" }],
    ["a long word", enc(JSON.stringify({ topic: "internationalization" })), { v: "internationalization" }],
    ["a path", enc("https://www.x.test/products/garden-lanterns?page=2"), { v: "/products/garden-lanterns" }],
    [
      "a screen size and a date",
      "vp=1920x1080&since=2026-11-12T10:00:00Z",
      { vp: "1920x1080", at: "2026-11-12T10:00:00Z" },
    ],
    ["zeros", `fb.1.${"0".repeat(18)}`, { trace: `00-${"0".repeat(32)}-${"0".repeat(16)}-00` }],
    // a JWT's first segment says how it is signed: every token of its kind starts with it
    ["another JWT", jwt, { key: `${header}.eyJzdWIiOiI5OTk5In0.another-visitors-signature-0000000000000000` }],
  ];
  for (const [what, value, spec] of free) assert.deepEqual(scanSecrets(spec, jarOf(value, "c")).secrets, [], what);

  // none of that frees a credential: the same token outside the caller's values, and the cookie whole
  const kept = { ...op("www.shop.test", "lanterns"), request: { url: `https://www.shop.test/api?q=x&t=${TICKET}` } };
  assert.equal(scanSecrets(kept, jarOf(enc(JSON.stringify({ t: TICKET })))).secrets.length, 1);
  assert.equal(scanSecrets(op("www.shop.test", uuid), jarOf(uuid)).secrets.length > 0, true, "a whole cookie");
});
