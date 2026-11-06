// Draw the README's illustrations, each in a light and a dark variant.
// Usage: node docs/media/draw.mjs [name ...]  -> docs/media/{hero,flywheel,how-it-works,benchmark,surfaces,feature-*}-{light,dark}.svg, logo.svg
// System fonts only: GitHub's image proxy blocks web fonts. Animation is CSS and SMIL, which GitHub
// plays in an <img>.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const out = import.meta.dirname;
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// Same browser/API hues as bench/charts.mjs, so every chart and drawing reads as one set.
const THEMES = {
  light: {
    card: "#fbfbfa",
    panel: "#ffffff",
    border: "#e6e5df",
    text: "#0b0b0b",
    text2: "#4f4e4a",
    muted: "#85847e",
    wall: "#d6d5ce",
    dots: "#dcdbd5",
    code: "#f1f0ec",
    api: "#2a78d6",
    apiText: "#1f63b8",
    apiSoft: "#e6f0fb",
    browser: "#eb6834",
    browserText: "#b94a1b",
    browserSoft: "#fcece4",
    ok: "#1a7f37",
    okSoft: "#e3f3e7",
  },
  dark: {
    card: "#161615",
    panel: "#1c1c1b",
    border: "#2a2a28",
    text: "#ecebe6",
    text2: "#b9b8b0",
    muted: "#85847e",
    wall: "#383835",
    dots: "#2b2b29",
    code: "#1f1f1d",
    api: "#3987e5",
    apiText: "#6aa7f0",
    apiSoft: "#15253a",
    browser: "#d95926",
    browserText: "#ec7f4f",
    browserSoft: "#2c1a11",
    ok: "#3fb950",
    okSoft: "#14291a",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (n) => Math.round(n * 10) / 10;

/** <text>: `o` takes size, weight, fill, mono, anchor, ls (letter-spacing), opacity, cls */
function text(x, y, s, o = {}) {
  const a = [
    `x="${r1(x)}"`,
    `y="${r1(y)}"`,
    `font-size="${o.size ?? 15}"`,
    o.weight ? `font-weight="${o.weight}"` : "",
    `fill="${o.fill}"`,
    o.mono ? `font-family="${MONO}"` : "",
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    o.ls !== undefined ? `letter-spacing="${o.ls}"` : "",
    o.opacity !== undefined ? `opacity="${o.opacity}"` : "",
    o.cls ? `class="${o.cls}"` : "",
  ].filter(Boolean);
  // spans: [[string, fill?, weight?]...] for mixed colour runs
  const body = Array.isArray(s)
    ? s
        .map(
          ([t, fill, weight]) =>
            `<tspan${fill ? ` fill="${fill}"` : ""}${weight ? ` font-weight="${weight}"` : ""}>${esc(t)}</tspan>`,
        )
        .join("")
    : esc(s);
  return `<text ${a.join(" ")}>${body}</text>`;
}

function doc(w, h, label, t, body, css = "") {
  const style = `<style>${css}@media (prefers-reduced-motion: reduce){*{animation:none!important}}</style>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" font-family="${SANS}">` +
    `<title>${esc(label)}</title>${style}` +
    `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" fill="${t.card}" stroke="${t.border}"/>` +
    body +
    "</svg>"
  );
}

// Deterministic maze: depth-first carve from a seeded generator.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function maze(cols, rows, seed) {
  const rand = mulberry32(seed);
  // walls: right[c][r], down[c][r] true when standing
  const right = Array.from({ length: cols }, () => Array(rows).fill(true));
  const down = Array.from({ length: cols }, () => Array(rows).fill(true));
  const seen = Array.from({ length: cols }, () => Array(rows).fill(false));
  const stack = [[0, 0]];
  seen[0][0] = true;
  while (stack.length) {
    const [c, r] = stack.at(-1);
    const next = [
      [c + 1, r],
      [c - 1, r],
      [c, r + 1],
      [c, r - 1],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < cols && y < rows && !seen[x][y]);
    if (!next.length) {
      stack.pop();
      continue;
    }
    const [x, y] = next[Math.floor(rand() * next.length)];
    if (x > c) right[c][r] = false;
    if (x < c) right[x][y] = false;
    if (y > r) down[c][r] = false;
    if (y < r) down[x][y] = false;
    seen[x][y] = true;
    stack.push([x, y]);
  }
  const open = (c, r, x, y) => (x > c ? !right[c][r] : x < c ? !right[x][y] : y > r ? !down[c][r] : !down[x][y]);
  const solve = (from, to) => {
    const prev = new Map([[from.join(), null]]);
    const q = [from];
    while (q.length) {
      const [c, r] = q.shift();
      if (c === to[0] && r === to[1]) break;
      for (const [x, y] of [
        [c + 1, r],
        [c - 1, r],
        [c, r + 1],
        [c, r - 1],
      ])
        if (x >= 0 && y >= 0 && x < cols && y < rows && !prev.has(`${x},${y}`) && open(c, r, x, y)) {
          prev.set(`${x},${y}`, [c, r]);
          q.push([x, y]);
        }
    }
    const path = [];
    for (let k = to; k; k = prev.get(k.join())) path.unshift(k);
    return path;
  };
  return { right, down, solve };
}

function hero(t) {
  const W = 1280,
    H = 400,
    cy = 200;
  const cols = 11,
    rows = 8,
    cell = 32;
  const mx = 768,
    my = cy - (rows / 2) * cell;
  const agent = { x: 650, w: 64 },
    site = { x: 1150, w: 64 };
  // seed picked for a route that winds through the top and bottom of the maze
  const m = maze(cols, rows, 2426);
  const inRow = 2,
    outRow = 1;
  const route = m.solve([0, inRow], [cols - 1, outRow]);
  const px = (c) => mx + (c + 0.5) * cell,
    py = (r) => my + (r + 0.5) * cell;

  let walls = `M${mx},${my}H${mx + cols * cell}M${mx},${my + rows * cell}H${mx + cols * cell}`;
  // outer verticals with gaps where the route enters and leaves
  for (let r = 0; r < rows; r++) {
    if (r !== inRow) walls += `M${mx},${my + r * cell}v${cell}`;
    if (r !== outRow) walls += `M${mx + cols * cell},${my + r * cell}v${cell}`;
  }
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      const x = mx + c * cell,
        y = my + r * cell;
      if (c < cols - 1 && m.right[c][r]) walls += `M${x + cell},${y}v${cell}`;
      if (r < rows - 1 && m.down[c][r]) walls += `M${x},${y + cell}h${cell}`;
    }

  const ac = agent.x + agent.w / 2,
    sc = site.x + site.w / 2;
  const top = cy - 32;
  const yIn = py(inRow),
    yOut = py(outRow);
  // the browser's route: up out of the agent, the long way through the maze, down into the site
  const pts = [
    [ac, top],
    [ac, yIn],
    [mx, yIn],
    ...route.map(([c, r]) => [px(c), py(r)]),
    [mx + cols * cell, yOut],
    [sc, yOut],
    [sc, top],
  ];
  const routeD = `M${pts.map(([x, y]) => `${r1(x)},${r1(y)}`).join("L")}`;
  const lineD = `M${agent.x + agent.w},${cy}H${site.x}`;

  const pill = "GET /search?q={query}";
  const pillW = pill.length * 9.1 + 32,
    pillX = mx + (cols * cell) / 2 - pillW / 2;

  const node = (x, glyph, label, accent) =>
    `<rect x="${x}" y="${cy - 32}" width="64" height="64" rx="14" fill="${t.card}" stroke="${accent}" stroke-width="2"/>` +
    text(x + 32, cy + 7, glyph, { size: 20, weight: 600, fill: accent, mono: true, anchor: "middle" }) +
    text(x + 32, cy + 60, label, { size: 15, fill: t.muted, anchor: "middle" });

  const css =
    `.march{stroke-dasharray:1.5 7;animation:march 1.1s linear infinite}@keyframes march{to{stroke-dashoffset:-8.5}}` +
    `.arrive{opacity:0;animation:arrive 2.6s cubic-bezier(.23,1,.32,1) infinite}` +
    `@keyframes arrive{0%,21%{opacity:0}27%{opacity:.55}70%,100%{opacity:0}}`;

  const body =
    `<defs><pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${t.dots}"/></pattern>` +
    `<linearGradient id="fade" x1="0" x2="1"><stop offset="0.38" stop-color="#fff" stop-opacity="0"/><stop offset="0.62" stop-color="#fff" stop-opacity="1"/></linearGradient>` +
    `<mask id="fadeMask"><rect width="${W}" height="${H}" fill="url(#fade)"/></mask>` +
    `<radialGradient id="glow"><stop offset="0" stop-color="${t.api}" stop-opacity=".9"/><stop offset="1" stop-color="${t.api}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="15" fill="url(#dots)" mask="url(#fadeMask)"/>` +
    // left: the mark, then type
    asterisk(90, 50, 16, 7.5, t.text) +
    text(72, 106, "the agent internet · built by the agents that use it", {
      size: 14,
      fill: t.muted,
      mono: true,
      ls: 0.3,
    }) +
    text(68, 182, "API Anything", { size: 74, weight: 700, fill: t.text, ls: -2.6 }) +
    text(72, 234, "The web, as an API for agents.", { size: 28, weight: 600, fill: t.text, ls: -0.4 }) +
    text(72, 272, "One agent learns a site's API.", { size: 21, fill: t.text2 }) +
    text(72, 300, "Every other agent gets it for free.", { size: 21, fill: t.text2 }) +
    `<rect x="72" y="330" width="306" height="32" rx="8" fill="${t.code}"/>` +
    text(
      86,
      351,
      [
        ['{"ok": ', t.muted],
        ["true", t.ok],
        [', "tier": ', t.muted],
        ["1", t.apiText],
        [', "ms": ', t.muted],
        ["111", t.apiText],
        ["}", t.muted],
      ],
      { size: 14, mono: true, fill: t.muted },
    ) +
    // right: the maze and the straight line through it
    `<path d="${walls}" fill="none" stroke="${t.wall}" stroke-width="2" stroke-linecap="round"/>` +
    `<path d="${routeD}" fill="none" stroke="${t.browser}" stroke-opacity=".14" stroke-width="9" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path class="march" d="${routeD}" fill="none" stroke="${t.browser}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle r="5" fill="${t.browser}"><animateMotion dur="11s" repeatCount="indefinite" path="${routeD}"/></circle>` +
    `<path d="${lineD}" stroke="${t.card}" stroke-width="16"/>` +
    `<path d="${lineD}" stroke="${t.api}" stroke-width="3" stroke-linecap="round"/>` +
    `<circle r="14" fill="url(#glow)" opacity="0"><animateMotion dur="2.6s" repeatCount="indefinite" path="${lineD}" keyPoints="0;1;1" keyTimes="0;0.24;1" calcMode="spline" keySplines="0.55 0 0.25 1;0 0 1 1"/><animate attributeName="opacity" dur="2.6s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.04;0.2;0.25;1"/></circle>` +
    `<rect x="${r1(pillX)}" y="${cy - 17}" width="${r1(pillW)}" height="34" rx="17" fill="${t.card}" stroke="${t.api}" stroke-width="1.5"/>` +
    text(
      pillX + pillW / 2,
      cy + 5,
      [
        ["GET ", t.apiText, 600],
        ["/search?q=", t.text2],
        ["{query}", t.apiText, 600],
      ],
      { size: 15, mono: true, fill: t.text2, anchor: "middle" },
    ) +
    `<rect class="arrive" x="${site.x - 6}" y="${cy - 38}" width="76" height="76" rx="19" fill="${t.api}" opacity="0"/>` +
    node(agent.x, ">_", "agent", t.text2) +
    node(site.x, "{ }", "site", t.api) +
    // legend
    `<path d="M650,362h20" stroke="${t.browser}" stroke-width="2.5" stroke-dasharray="1.5 6" stroke-linecap="round"/>` +
    text(680, 367, "a browser: click, wait, read, repeat", { size: 15, fill: t.text2 }) +
    `<path d="M958,362h20" stroke="${t.api}" stroke-width="3" stroke-linecap="round"/>` +
    text(988, 367, "one HTTP call, no browser", { size: 15, fill: t.text2 });

  return doc(
    W,
    H,
    "API Anything. The web, as an API for agents. One agent learns a site's API; every other agent gets it for free.",
    t,
    body,
    css,
  );
}

/** The loop the shared catalog grows by, beside the reCAPTCHA idea it borrows. */
function flywheel(t) {
  const W = 1280,
    H = 560,
    cx = 640,
    cy = 290,
    rx = 262,
    ry = 186,
    bw = 248,
    bh = 76;
  const steps = [
    ["Ask", "an agent needs a website", t.text2],
    ["Find", "search the shared catalog", t.api],
    ["Learn", "from the site's own requests", t.browser],
    ["Share", "cookies and tokens stripped", t.ok],
    ["Verify", "other installs' calls vote", t.api],
    ["Repair", "one fix reaches everyone", t.browser],
  ];
  const at = (deg) => [cx + rx * Math.cos((deg * Math.PI) / 180), cy + ry * Math.sin((deg * Math.PI) / 180)];
  const angles = steps.map((_, i) => -90 + i * 60);
  const inBox = ([x, y], [bx, by]) => Math.abs(x - bx) < bw / 2 + 10 && Math.abs(y - by) < bh / 2 + 10;

  let arcs = "";
  for (let i = 0; i < steps.length; i++) {
    const a = at(angles[i]),
      b = at(angles[i] + 60);
    let from = angles[i],
      to = angles[i] + 60;
    while (inBox(at(from), a)) from += 0.5;
    while (inBox(at(to), b)) to -= 0.5;
    const [x1, y1] = at(from),
      [x2, y2] = at(to);
    arcs += `<path d="M${r1(x1)},${r1(y1)}A${rx},${ry} 0 0 1 ${r1(x2)},${r1(y2)}" fill="none" stroke="${t.api}" stroke-width="2" stroke-linecap="round" class="march" marker-end="url(#arrowApi)"/>`;
  }
  const loop = `M${cx},${cy - ry}A${rx},${ry} 0 0 1 ${cx},${cy + ry}A${rx},${ry} 0 0 1 ${cx},${cy - ry}`;

  let nodes = "";
  steps.forEach(([title, sub, accent], i) => {
    const [x, y] = at(angles[i]);
    const bx = x - bw / 2,
      by = y - bh / 2;
    nodes +=
      `<rect x="${r1(bx)}" y="${r1(by)}" width="${bw}" height="${bh}" rx="14" fill="${t.panel}" stroke="${accent}" stroke-width="1.75"/>` +
      `<circle cx="${r1(bx + 28)}" cy="${r1(y)}" r="13" fill="${accent}"/>` +
      text(bx + 28, y + 5, String(i + 1), { size: 14, weight: 700, fill: t.panel, anchor: "middle" }) +
      text(bx + 52, y - 4, title, { size: 19, weight: 700, fill: t.text, ls: -0.2 }) +
      text(bx + 52, y + 19, sub, { size: 13.5, fill: t.text2 });
  });

  const side = (x, kicker, title, lines, accent) =>
    text(x, 150, kicker, { size: 13, fill: t.muted, mono: true, ls: 0.3 }) +
    text(x, 184, title, { size: 22, weight: 700, fill: accent, ls: -0.3 }) +
    lines.map((l, k) => text(x, 220 + k * 25, l, { size: 16, fill: t.text2 })).join("");

  const css = `.march{stroke-dasharray:2 7;animation:march 1.4s linear infinite}@keyframes march{to{stroke-dashoffset:-9}}`;
  const body =
    `<defs>${markers(t)}<radialGradient id="dot"><stop offset="0" stop-color="${t.api}"/><stop offset=".5" stop-color="${t.api}" stop-opacity=".5"/><stop offset="1" stop-color="${t.api}" stop-opacity="0"/></radialGradient>` +
    `<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="${t.dots}"/></pattern></defs>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="15" fill="url(#dots)" opacity=".7"/>` +
    side(
      48,
      "2007",
      "reCAPTCHA",
      [
        "People typed two words to",
        "prove they were human.",
        "One word came from a",
        "scanned book. Millions of",
        "books got digitized.",
      ],
      t.text,
    ) +
    side(
      1012,
      "now",
      "API Anything",
      [
        "Agents call websites to get",
        "their work done. Each call",
        "learns, checks or repairs",
        "an API that every other",
        "agent can use.",
      ],
      t.apiText,
    ) +
    arcs +
    `<circle r="16" fill="url(#dot)"><animateMotion dur="9s" repeatCount="indefinite" path="${loop}"/></circle>` +
    `<circle cx="${cx}" cy="${cy}" r="86" fill="${t.apiSoft}" stroke="${t.api}" stroke-width="1.5"/>` +
    text(cx, cy - 22, "{ }", { size: 22, weight: 600, fill: t.api, mono: true, anchor: "middle" }) +
    text(cx, cy + 8, "shared catalog", { size: 17, weight: 700, fill: t.text, anchor: "middle" }) +
    text(cx, cy + 30, "stores specs and", { size: 12.5, fill: t.text2, anchor: "middle" }) +
    text(cx, cy + 46, "counts reports", { size: 12.5, fill: t.text2, anchor: "middle" }) +
    nodes +
    text(
      cx,
      H - 22,
      "Every call runs on the user's own machine, browser and network. Only specs and outcomes reach the catalog.",
      { size: 13.5, fill: t.muted, anchor: "middle" },
    );
  return doc(
    W,
    H,
    "The agent internet loop. 1 Ask: an agent needs a website. 2 Find: search the shared catalog. 3 Learn: from the site's own requests, if nobody shared it. 4 Share: cookies and tokens stripped. 5 Verify: other installs' calls vote. 6 Repair: one fix reaches everyone. Like reCAPTCHA, which digitized books from words people typed anyway, API Anything turns the web into APIs from calls agents make anyway.",
    t,
    body,
    css,
  );
}

/** width of monospace text: every face in MONO is close to 0.6em per character */
const monoW = (s, size) => s.length * size * 0.6;

function markers(t) {
  const m = (id, fill) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1L9,5L1,9z" fill="${fill}"/></marker>`;
  return m("arrowMuted", t.muted) + m("arrowApi", t.api);
}

const arrow = (d, color, id, extra = "") =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${id})" ${extra}/>`;

function panel(x, y, w, h, t) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.panel}" stroke="${t.border}"/>`;
}

/** a numbered section heading; `subX` places the subtitle after the title */
function heading(x, y, n, title, sub, subX, t) {
  const badge =
    n === undefined
      ? ""
      : `<circle cx="${x + 13}" cy="${y - 7}" r="13" fill="${t.text}"/>` +
        text(x + 13, y - 2, String(n), { size: 14, weight: 700, fill: t.panel, anchor: "middle" });
  const tx = n === undefined ? x : x + 36;
  return (
    badge +
    text(tx, y, title, { size: 22, weight: 700, fill: t.text, ls: -0.3 }) +
    text(subX, y, sub, { size: 16, fill: t.muted })
  );
}

function chip(x, y, w, h, body, t, o = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${o.fill ?? t.code}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="1.5"` : ""}/>${body}`;
}

function howItWorks(t) {
  const W = 1280,
    H = 900;
  let b = `<defs>${markers(t)}<radialGradient id="tok"><stop offset="0" stop-color="${t.api}"/><stop offset=".45" stop-color="${t.api}" stop-opacity=".55"/><stop offset="1" stop-color="${t.api}" stop-opacity="0"/></radialGradient></defs>`;

  // 1. Learn
  b += panel(32, 32, 1216, 220, t);
  b += heading(56, 78, 1, "Learn", "once, from two example inputs", 160, t);
  b += text(56, 122, "two example inputs", { size: 14, fill: t.muted });
  for (const [i, v] of ["github.com", "github.io"].entries())
    b += chip(
      56,
      136 + i * 46,
      220,
      36,
      text(
        72,
        160 + i * 46,
        [
          ["domain=", t.text2],
          [v, t.browserText, 600],
        ],
        { size: 16, mono: true, fill: t.text2 },
      ),
      t,
    );
  b += arrow("M296,177H386", t.muted, "arrowMuted");
  b += text(340, 166, "the browser", { size: 13, fill: t.muted, anchor: "middle" });
  b += text(340, 196, "loads each", { size: 13, fill: t.muted, anchor: "middle" });
  b += text(408, 122, "the request each load sent", { size: 14, fill: t.muted });
  for (const [i, v] of ["github.com", "github.io"].entries())
    b += chip(
      408,
      136 + i * 46,
      304,
      36,
      text(
        424,
        160 + i * 46,
        [
          ["GET ", t.text, 600],
          ["/from?site=", t.text2],
          [v, t.browserText, 600],
        ],
        {
          size: 16,
          mono: true,
          fill: t.text2,
        },
      ),
      t,
    );
  b += arrow("M732,177H832", t.muted, "arrowMuted");
  b += text(782, 166, "what changed", { size: 13, fill: t.muted, anchor: "middle" });
  b += text(782, 196, "becomes a slot", { size: 13, fill: t.muted, anchor: "middle" });
  b += text(852, 122, "the saved operation", { size: 14, fill: t.muted });
  {
    const x = 852,
      s = 16,
      cw = s * 0.6;
    const l1 = "GET /from?site=",
      l2 = "Cookie: ";
    b += `<rect x="${x}" y="136" width="372" height="82" rx="10" fill="${t.apiSoft}" stroke="${t.api}" stroke-width="1.5"/>`;
    const slot = (sx, y, label, fill, color) =>
      `<rect x="${r1(sx - 5)}" y="${y - 17}" width="${r1(label.length * cw + 10)}" height="24" rx="6" fill="${fill}"/>` +
      text(sx, y, label, { size: s, mono: true, fill: color, weight: 600 });
    b += text(
      x + 18,
      168,
      [
        ["GET ", t.text, 600],
        ["/from?site=", t.text2],
      ],
      { size: s, mono: true, fill: t.text2 },
    );
    b += slot(x + 18 + l1.length * cw + 6, 168, "{domain}", t.api, t.panel);
    b += text(x + 18, 202, l2, { size: s, mono: true, fill: t.text2 });
    b += slot(x + 18 + l2.length * cw + 6, 202, "cookie:user", t.panel, t.apiText);
  }
  b += text(1224, 240, "No LLM. Cookies and tokens become references, never values.", {
    size: 14,
    fill: t.muted,
    anchor: "end",
  });

  // 2. Call: the tier ladder
  b += panel(32, 276, 680, 388, t);
  b += heading(56, 322, 2, "Call", "every time, the fastest way first", 140, t);
  const cmd = "api-anything call hn-demo links domain=arxiv.org";
  b += chip(
    56,
    342,
    monoW(cmd, 15) + 28,
    34,
    text(
      70,
      364,
      [
        ["api-anything call ", t.text2],
        ["hn-demo links ", t.text],
        ["domain=", t.text2],
        ["arxiv.org", t.apiText, 600],
      ],
      {
        size: 15,
        mono: true,
        fill: t.text2,
      },
    ),
    t,
  );
  const steps = [
    { x: 56, y: 396, tier: "TIER 1", title: "Node fetch, plain HTTP", right: "no browser" },
    { x: 136, y: 492, tier: "TIER 2", title: "fetch from inside a browser page" },
    { x: 216, y: 588, tier: "TIER 3", title: "run the page, read its response", right: "reads only" },
  ];
  const drops = ["if the site blocks plain HTTP", "last resort for a read: repair failed"];
  const sw = 380,
    sh = 56;
  for (const [i, s] of steps.entries()) {
    const first = i === 0;
    b += `<rect x="${s.x}" y="${s.y}" width="${sw}" height="${sh}" rx="10" fill="${first ? t.apiSoft : t.panel}" stroke="${first ? t.api : t.wall}" stroke-width="1.5"/>`;
    b += text(s.x + 20, s.y + 22, s.tier, { size: 12, weight: 700, fill: first ? t.apiText : t.muted, ls: 1.2 });
    b += text(s.x + 20, s.y + 44, s.title, { size: 17, weight: 600, fill: t.text });
    if (s.right)
      b += text(s.x + sw - 18, s.y + 34, s.right, {
        size: first ? 15 : 13,
        mono: first,
        weight: first ? 600 : undefined,
        fill: first ? t.apiText : t.muted,
        anchor: "end",
      });
    if (i < steps.length - 1) {
      const ax = s.x + 104;
      b += arrow(`M${ax},${s.y + sh + 4}V${s.y + 92}`, t.muted, "arrowMuted", `class="drop"`);
      b += text(ax + 16, s.y + sh + 25, drops[i], { size: 14, fill: t.text2 });
    }
    // every tier answers into the same result
    const cy = s.y + sh / 2;
    if (first) b += arrow(`M${s.x + sw + 4},${cy}H${754}`, t.api, "arrowApi");
    else
      b += `<path d="M${s.x + sw + 4},${cy}H724V${steps[0].y + sh / 2}" fill="none" stroke="${t.muted}" stroke-width="1.75" stroke-linejoin="round"/>`;
  }
  b += arrow("M96,378V392", t.muted, "arrowMuted");

  // the result an agent reads
  b += panel(736, 276, 512, 388, t);
  b += heading(760, 322, undefined, "Result", "fields an agent can act on", 836, t);
  b += text(760, 394, "a read that worked", { size: 14, fill: t.muted });
  b += chip(
    760,
    407,
    464,
    34,
    text(
      774,
      429,
      [
        ['{"ok": ', t.muted],
        ["true", t.ok, 600],
        [', "class": ', t.muted],
        ['"ok"', t.ok],
        [', "tier": ', t.muted],
        ["1", t.apiText, 600],
        [', "ms": ', t.muted],
        ["111", t.apiText, 600],
        ["}", t.muted],
      ],
      { size: 14, mono: true, fill: t.muted },
    ),
    t,
    { stroke: t.api },
  );
  b += `<rect class="land" x="760" y="407" width="464" height="34" rx="8" fill="${t.api}" opacity="0"/>`;
  const fields = [
    ["class", "what happened", "ok · drift · auth · rate · blocked · input · error · …"],
    [
      "write",
      "what a write did; a repeat is refused",
      "not_sent · not_applied · accepted · applied · may_have_applied",
    ],
    ["retry", "whether to send it again", "no · safe · after_wait · after_fix"],
    ["nextCall", "the one step to take next", "login · relearn · fix_args · check_site · …"],
  ];
  for (const [i, [f, what, vals]] of fields.entries()) {
    const y = 478 + i * 47;
    b += text(760, y, f, { size: 15, mono: true, weight: 600, fill: t.apiText });
    b += text(760 + monoW(f, 15) + 12, y, what, { size: 15, fill: t.text2 });
    // 12.5 px: the five write outcomes have to fit the panel
    b += text(760, y + 21, vals, { size: 12.5, mono: true, fill: t.muted });
  }

  // 3. Repair
  b += panel(32, 688, 1216, 180, t);
  b += heading(56, 734, 3, "Repair", "only when a request drifts", 168, t);
  const fix = [
    ["It drifts", "the answer stops fitting:", "a rotated id, a moved field"],
    ["Re-learn", "rescan the page's scripts, or", "capture the request again"],
    ["Replay", "send the new request", "with the call's own inputs"],
    ["Save", "only if the replay succeeds;", "otherwise, an honest error"],
  ];
  const fw = 262,
    gap = 40;
  for (const [i, [title, l1, l2]] of fix.entries()) {
    const x = 56 + i * (fw + gap),
      y = 754;
    const last = i === fix.length - 1;
    b += `<rect x="${x}" y="${y}" width="${fw}" height="90" rx="10" fill="${last ? t.okSoft : t.panel}" stroke="${last ? t.ok : t.wall}" stroke-width="1.5"/>`;
    b += text(x + 18, y + 30, title, { size: 17, weight: 600, fill: last ? t.ok : t.text });
    b += text(x + 18, y + 55, l1, { size: 14, fill: t.text2 });
    b += text(x + 18, y + 75, l2, { size: 14, fill: t.text2 });
    if (!last) b += arrow(`M${x + fw + 8},${y + 45}H${x + fw + gap - 8}`, t.muted, "arrowMuted");
  }

  // a request token taking the usual path: the call, tier 1, the result
  b += `<circle r="9" fill="url(#tok)" opacity="0"><animateMotion dur="3.6s" repeatCount="indefinite" path="M96,378V424H760" keyPoints="0;1;1" keyTimes="0;0.3;1" calcMode="spline" keySplines="0.45 0 0.2 1;0 0 1 1"/><animate attributeName="opacity" dur="3.6s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.03;0.28;0.32;1"/></circle>`;

  const css =
    ".drop{stroke-dasharray:3 5;animation:drop 1.4s linear infinite}@keyframes drop{to{stroke-dashoffset:-8}}" +
    ".land{animation:land 3.6s cubic-bezier(.23,1,.32,1) infinite}@keyframes land{0%,28%{opacity:0}33%{opacity:.18}75%,100%{opacity:0}}";
  return doc(
    W,
    H,
    "How API Anything works. 1, Learn: the browser loads the page for two example inputs; what changed becomes a slot, and cookies become references. 2, Call: tier 1 sends plain HTTP with Node fetch, with no browser; if the site blocks that, tier 2 fetches from inside a browser page; as a last resort for reads, tier 3 runs the page and reads its response. Every result carries class, write, retry and nextCall. 3, Repair: when a request drifts, re-learn it, replay it, and save it only if the replay succeeds.",
    t,
    b,
    css,
  );
}

// Medians from bench/results/summary.json (bench/README.md), 5 trials per row.
const BENCH = [
  { task: "1 date", seconds: [12.9, 8.4], cost: [0.166, 0.074] },
  { task: "5 dates", seconds: [41.6, 21.1], cost: [0.154, 0.152] },
];

function benchmark(t) {
  const W = 1280,
    H = 480;
  let b = "";
  b += text(40, 62, "Same agent, same prompt: driving a browser vs calling API Anything", {
    size: 22,
    weight: 700,
    fill: t.text,
    ls: -0.3,
  });
  b += text(
    40,
    90,
    "Google Flights, cheapest nonstop SFO to JFK. Median of 5 runs per setup. Claude Opus 5.5 in Claude Code, 2026-09-28.",
    { size: 15, fill: t.muted },
  );
  const tiles = [
    ["1.5–2×", "sooner to answer", 36],
    ["about ½", "the tokens read", 36],
    ["20 / 20", "answers correct", 36],
    ["182.5 s → 30.5 s", "Goodreads, 5 books: time to answer", 28],
  ];
  const tw = (1200 - 3 * 16) / 4;
  for (const [i, [big, label, size]] of tiles.entries()) {
    const x = 40 + i * (tw + 16);
    b += `<rect x="${x}" y="114" width="${tw}" height="96" rx="12" fill="${t.panel}" stroke="${t.border}"/>`;
    b += text(x + 20, 162, big, { size, weight: 700, fill: t.apiText, ls: -0.8 });
    b += text(x + 20, 190, label, { size: 15, fill: t.text2 });
  }
  const groups = [
    { title: "Time to answer", x: 40, key: "seconds", max: 45, fmt: (v) => `${v.toFixed(1)} s` },
    { title: "Cost per task", x: 660, key: "cost", max: 0.18, fmt: (v) => `$${v.toFixed(3)}` },
  ];
  const colors = [t.browser, t.api];
  for (const g of groups) {
    b += text(g.x, 258, g.title, { size: 16, weight: 600, fill: t.text });
    const x0 = g.x + 84,
      span = 400;
    b += `<path d="M${x0},274V392" stroke="${t.wall}"/>`;
    for (const [r, row] of BENCH.entries()) {
      const y = 282 + r * 60;
      b += text(g.x, y + 26, row.task, { size: 15, fill: t.text2 });
      for (const [k, v] of row[g.key].entries()) {
        const w = (v / g.max) * span,
          by = y + k * 24;
        b += `<path d="M${x0},${by}H${r1(x0 + w - 4)}a4,4 0 0 1 4,4V${by + 14}a4,4 0 0 1 -4,4H${x0}Z" fill="${colors[k]}"/>`;
        b += text(x0 + w + 10, by + 14, g.fmt(v), {
          size: 14,
          weight: k ? 600 : undefined,
          fill: k ? t.text : t.text2,
        });
      }
    }
  }
  b += `<rect x="40" y="416" width="12" height="12" rx="3" fill="${t.browser}"/>`;
  b += text(60, 427, "Agent + browser (Playwright MCP, headless Chrome)", { size: 14, fill: t.text2 });
  b += `<rect x="420" y="416" width="12" height="12" rx="3" fill="${t.api}"/>`;
  b += text(440, 427, "Agent + API Anything (MCP)", { size: 14, fill: t.text2 });
  b += text(
    40,
    456,
    "Cost as reported by Claude Code at API list prices. Every answer was checked against live fares. Method and raw numbers: bench/README.md",
    { size: 13, fill: t.muted },
  );
  return doc(
    W,
    H,
    "Benchmark, median of 5 runs. 1 date: browser 12.9 s and $0.166, API Anything 8.4 s and $0.074. 5 dates: browser 41.6 s and $0.154, API Anything 21.1 s and $0.152. 1.5 to 2 times sooner, about half the tokens, 20 of 20 answers correct. Goodreads, 5 books: browser 182.5 s, API Anything 30.5 s.",
    t,
    b,
  );
}

// Every way in reaches the same local operations, which reach the sites over plain HTTP.
function surfaces(t) {
  const W = 1280,
    H = 600,
    cy = 311;
  const ways = [
    ["MCP over stdio", "Claude Code, Codex, Cursor, VS Code, Gemini CLI", false],
    ["HTTP server", "api-anything serve: REST, /openapi.json, /mcp", true],
    ["Python", "pip install api-anything", true],
    ["TypeScript", 'import { call } from "api-anything"', true],
    ["CLI", "api-anything call <site> <op> key=value", true],
  ];
  const sites = ["news.ycombinator.com", "youtube.com", "github.com", "google.com/travel/flights", "goodreads.com"];
  const row = (i) => 104 + i * 86;
  let b = `<defs>${markers(t)}</defs>`;
  b += text(40, 76, "where you call it", { size: 13, fill: t.muted, mono: true, ls: 0.3 });
  b += text(870, 76, "websites, over plain HTTP", { size: 13, fill: t.muted, mono: true, ls: 0.3 });
  for (const [i, [title, sub, mono]] of ways.entries()) {
    const y = row(i);
    b += `<rect x="40" y="${y}" width="400" height="70" rx="12" fill="${t.panel}" stroke="${t.border}"/>`;
    b += text(60, y + 29, title, { size: 17, weight: 700, fill: t.text, ls: -0.2 });
    b += text(60, y + 53, sub, { size: mono ? 13.5 : 14, fill: mono ? t.apiText : t.text2, mono });
    b += arrow(`M440,${y + 35}C485,${y + 35} 480,${cy} 516,${cy}`, t.api, "arrowApi", 'class="march"');
  }
  for (const [i, s] of sites.entries()) {
    const y = row(i) + 9;
    b += chip(870, y, 370, 52, text(890, y + 32, s, { size: 15, fill: t.text, mono: true }), t);
    b += arrow(`M764,${cy}C800,${cy} 820,${y + 26} 864,${y + 26}`, t.api, "arrowApi", 'class="march"');
  }
  b += text(870, row(4) + 92, "and more: 114 sites, 323 read operations bundled", { size: 14, fill: t.text2 });
  // the machine in the middle, and the catalog it trades specs with
  b += `<rect x="520" y="${cy - 120}" width="240" height="240" rx="18" fill="${t.apiSoft}" stroke="${t.api}" stroke-width="1.5"/>`;
  b += text(640, cy - 62, "{ }", { size: 24, weight: 600, fill: t.api, mono: true, anchor: "middle" });
  b += text(640, cy - 26, "api-anything", { size: 21, weight: 700, fill: t.text, anchor: "middle", ls: -0.3 });
  b += text(640, cy + 2, "on your machine", { size: 14, fill: t.text2, anchor: "middle" });
  const inside = ["learned or pulled once,", "called from everywhere", "sessions stay here,", "never in a spec"];
  for (const [k, l] of inside.entries())
    b += text(640, cy + 40 + k * 20 + (k > 1 ? 8 : 0), l, { size: 13, fill: t.text2, anchor: "middle" });
  b += `<rect x="540" y="56" width="200" height="64" rx="12" fill="${t.panel}" stroke="${t.border}" stroke-dasharray="4 4"/>`;
  b += text(640, 84, "shared catalog", { size: 15, weight: 700, fill: t.text, anchor: "middle" });
  b += text(640, 104, "specs and reports, no calls", { size: 12.5, fill: t.muted, anchor: "middle" });
  b += `<path d="M640,124V${cy - 126}" stroke="${t.muted}" stroke-width="1.5" stroke-dasharray="3 5" marker-start="url(#arrowMuted)" marker-end="url(#arrowMuted)"/>`;
  b += text(
    W / 2,
    H - 24,
    "Learn an operation once and every agent and program on the machine can call it. Calls run here, from your network, never through the catalog.",
    { size: 13.5, fill: t.muted, anchor: "middle" },
  );
  const css = `.march{stroke-dasharray:2 7;animation:march 1.4s linear infinite}@keyframes march{to{stroke-dashoffset:-9}}`;
  return doc(
    W,
    H,
    "Use it anywhere. MCP over stdio for Claude Code, Codex, Cursor, Gemini CLI, VS Code and Hermes; an HTTP server with REST, an OpenAPI document and MCP; a Python package; the TypeScript library; the CLI. All of them call the same operations on your machine, learned once or pulled from the shared catalog, which reach websites such as Hacker News, YouTube, GitHub, Google Flights and Goodreads over plain HTTP. Calls never go through the catalog.",
    t,
    b,
    css,
  );
}

// Feature icons for a "what you get" grid: 96×96, meant to be shown at 48 px.
const ICONS = {
  learn: (t) =>
    `<rect x="18" y="24" width="24" height="14" rx="4"/><rect x="18" y="58" width="24" height="14" rx="4"/>` +
    `<path d="M42,31C52,31 50,48 58,48M42,65C52,65 50,48 58,48"/>` +
    `<rect x="58" y="37" width="24" height="22" rx="5" stroke="${t.api}"/><rect x="64" y="45" width="12" height="6" rx="3" fill="${t.api}" stroke="none"/>`,
  fast: (t) =>
    `<path d="M16,40h14M12,52h18M16,64h10"/>` +
    `<path d="M36,52H76" stroke="${t.api}" stroke-width="5"/><path d="M66,41L78,52L66,63" stroke="${t.api}" stroke-width="5"/>`,
  heals: (t) =>
    `<path d="M70,38A24,24 0 1 0 72,58"/><path d="M71,24V39H56"/>` +
    `<path d="M38,49l7,7l13,-14" stroke="${t.ok}" stroke-width="5"/>`,
  writes: (t) =>
    `<rect x="30" y="20" width="44" height="34" rx="7" stroke-dasharray="4 6" opacity=".55"/>` +
    `<rect x="22" y="34" width="44" height="40" rx="7" fill="${t.panel}"/>` +
    `<path d="M33,54l7,7l14,-15" stroke="${t.ok}" stroke-width="5"/>`,
  sessions: (t) =>
    `<rect x="26" y="44" width="44" height="34" rx="7"/><path d="M36,44V34a12,12 0 0 1 24,0V44"/>` +
    `<circle cx="48" cy="59" r="4" fill="${t.api}" stroke="${t.api}"/><path d="M48,63v6" stroke="${t.api}"/>`,
  share: (t) =>
    `<path d="M16,34a6,6 0 0 1 6,-6h14l6,7h32a6,6 0 0 1 6,6v31a6,6 0 0 1 -6,6H22a6,6 0 0 1 -6,-6Z"/>` +
    `<path d="M40,66V48M33,55l7,-7l7,7" stroke="${t.api}"/><path d="M58,48V66M51,59l7,7l7,-7" stroke="${t.api}"/>`,
};

function icon(draw) {
  return (t) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img">` +
    `<rect x="1" y="1" width="94" height="94" rx="22" fill="${t.apiSoft}" stroke="${t.border}" stroke-opacity="0"/>` +
    `<g fill="none" stroke="${t.text2}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">${draw(t)}</g></svg>`;
}

/**
 * The mark: the wildcard. To a programmer `*` means "anything", so it is the name in one glyph.
 * Six round-capped arms; on the 64-unit logo, arms of 23 and a stroke of 10.
 */
function asterisk(cx, cy, arm, width, fill, cls = "") {
  const d = [0, 60, 120]
    .map((deg) => {
      const a = (deg * Math.PI) / 180,
        dx = r1(arm * Math.sin(a)),
        dy = r1(arm * Math.cos(a));
      return `M${r1(cx - dx)},${r1(cy - dy)}L${r1(cx + dx)},${r1(cy + dy)}`;
    })
    .join("");
  return `<path${cls ? ` class="${cls}"` : ""} d="${d}" fill="none" stroke="${fill}" stroke-width="${width}" stroke-linecap="round"/>`;
}

// logo.svg, also the favicon: dark on a light page or tab bar, light on a dark one
const logo = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="API Anything">` +
  `<style>@media (prefers-color-scheme: dark){.mark{stroke:${THEMES.dark.text}}}</style>` +
  `${asterisk(32, 32, 23, 10, THEMES.light.text, "mark")}</svg>`;

const ASSETS = {
  hero,
  flywheel,
  "how-it-works": howItWorks,
  benchmark,
  surfaces,
  ...Object.fromEntries(Object.entries(ICONS).map(([k, d]) => [`feature-${k}`, icon(d)])),
};
const only = process.argv.slice(2);
for (const [name, draw] of Object.entries(ASSETS)) {
  if (only.length && !only.includes(name)) continue;
  for (const [mode, t] of Object.entries(THEMES)) writeFileSync(join(out, `${name}-${mode}.svg`), draw(t));
}
if (!only.length || only.includes("logo")) writeFileSync(join(out, "logo.svg"), logo());
