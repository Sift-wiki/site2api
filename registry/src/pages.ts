/**
 * The registry's HTML: a home page that lists and searches the shared sites, and one page per site. Every
 * string from a spec or its notes is someone else's text, so all of it goes through `esc`; none of it
 * reaches a script, and the one script is pinned by its hash in the CSP.
 */
import { createHash } from "node:crypto";
import type { ServedOp, ServedSite, Status } from "../../src/registry-api.js";
import { summarize } from "../../src/search.js";
import type { Operation } from "../../src/spec.js";
import type { PublicStats } from "./stats.js";

const REPO = "goodnight000/api-anything";
const INSTALL = "npx -y api-anything setup";
const TAGLINE = "Teach your agent a website once; after that it calls the site like an API.";

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const titleOf = (s: Pick<ServedSite, "name" | "displayName">) => s.displayName ?? s.name;

const day = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const text = d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return `<time datetime="${esc(iso)}">${text}</time>`;
};

/** `code`, **bold** and https links inside one line of escaped text; code spans are left as they are. */
function inline(text: string): string {
  return esc(text)
    .split(/(`[^`]+`)/)
    .map((part, i) =>
      i % 2
        ? `<code>${part.slice(1, -1)}</code>`
        : part
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" rel="nofollow ugc">$1</a>'),
    )
    .join("");
}

/** The markdown site notes use: paragraphs, `-` lists with indented continuation lines, headings. */
export function markdown(text: string): string {
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    if (items.length) out.push(`<ul>${items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`);
    para = [];
    items = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s{0,3}[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (item) {
      if (para.length) flush();
      items.push(item[1]!);
    } else if (items.length && /^\s/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else {
      if (items.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

/* ------------------------------------------------------------------ status */

const STATUS: Partial<Record<Status, [label: string, tone: string, why: string]>> = {
  live: ["Live", "ok", "confirmed by other installs"],
  candidate: ["Candidate", "mixed", "new: not yet confirmed by installs other than its uploader"],
  degraded: ["Degraded", "bad", "failing across installs; served while nothing better exists"],
};

function statusCell(o: ServedOp): string {
  const [label, tone, why] = STATUS[o.status] ?? [o.status, "none", ""];
  const facts = [
    `${o.confirmations} confirmation${o.confirmations === 1 ? "" : "s"}`,
    o.successRate !== undefined ? `${Math.round(o.successRate * 100)}% success` : "success unknown",
  ];
  const last = o.lastOkAt ? `; last worked ${day(o.lastOkAt)}` : "; last worked unknown";
  return `<span class="h ${tone}" title="${esc(why)}">${esc(label)}</span><small>${facts.join(" · ")}${last}</small>`;
}

function summary(s: ServedSite): { label: string; tone: string } {
  const live = s.operations.filter((o) => o.status === "live").length;
  const n = s.operations.length;
  if (live === n) return { label: "all live", tone: "ok" };
  if (s.operations.some((o) => o.status === "degraded")) return { label: `${live} of ${n} live`, tone: "bad" };
  return { label: live ? `${live} of ${n} live` : "candidates", tone: live ? "mixed" : "none" };
}

/* ------------------------------------------------------------------ sample call */

// for the try form's curl line alone: the URL of a bundled op, its query percent-encoded
const shellArg = (s: string) => (/^[\w.,:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const argText = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * `name=value` as one argument of a command a visitor copies into whatever shell they have. The value is
 * someone else's text, and no quoting holds everywhere: '...' is no quoting in cmd.exe, and '\'' ends a
 * PowerShell string. So it is spelled only when sh, cmd.exe and PowerShell read it alike: bare, or in
 * double quotes with a space or a comma (no $ ` \ ! % ^ & or quote). Anything else is a placeholder.
 */
export function callArg(name: string, value: unknown): string {
  const arg = `${name}=${argText(value)}`;
  if (/^[\w.:/@+=-]+$/.test(arg)) return arg;
  return /^[\w .,:/@+=-]+$/.test(arg) ? `"${arg}"` : `${name}=<${name}>`;
}

/** The op a visitor should try first: a read that runs logged out and has examples, preferring a live one. */
function sampleOp(s: ServedSite): Operation | undefined {
  const reads = s.operations.filter((o) => o.operation.readOnly);
  const runnable = (o: ServedOp) =>
    o.operation.params.every((p) => !p.required || p.example !== undefined || p.default !== undefined);
  const ranked = [
    reads.filter((o) => runnable(o) && !o.operation.learnedLoggedIn && o.status === "live"),
    reads.filter((o) => runnable(o) && !o.operation.learnedLoggedIn),
    reads.filter(runnable),
    reads,
  ];
  return ranked.find((l) => l.length)?.[0]?.operation;
}

function sampleCommands(name: string, op: Operation | undefined): string {
  const lines = [`api-anything pull ${name}`];
  if (op?.learnedLoggedIn) lines.push(`api-anything login ${name}    # signs in with your browser's cookies`);
  if (op) {
    const args = op.params.flatMap((p) =>
      p.example !== undefined ? [callArg(p.name, p.example)] : p.required ? [`${p.name}=<${p.name}>`] : [],
    );
    lines.push(["api-anything call", name, op.name, ...args].join(" "));
  }
  return esc(lines.join("\n"));
}

/* ------------------------------------------------------------------ layout */

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1c1c1e;--muted:#68686f;--line:#e7e4de;--card:#fff;--code:#f2f0eb;--accent:#2952e3;--ok:#18794e;--ok-bg:#e6f4ec;--bad:#c2352e;--bad-bg:#fbeae8;--mixed:#9a6700;--mixed-bg:#fbf1dc;--none-bg:#efede9}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#9b9ba3;--line:#2a2a2f;--card:#18181b;--code:#1f1f23;--accent:#86a6ff;--ok:#4cc38a;--ok-bg:#132d21;--bad:#ff7a70;--bad-bg:#3a1714;--mixed:#e2b340;--mixed-bg:#33270b;--none-bg:#232327}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:920px;margin:0 auto;padding:0 20px}
header.top{border-bottom:1px solid var(--line)}
header.top .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.brand{font-weight:650;color:var(--fg);letter-spacing:-.01em;display:flex;align-items:center;gap:9px}
.top nav a{color:var(--muted);margin-left:18px;font-size:15px}
main{padding:44px 0 64px}
h1{font-size:clamp(30px,5vw,44px);line-height:1.1;letter-spacing:-.025em;margin:0 0 14px}
h2{font-size:22px;letter-spacing:-.015em;margin:48px 0 14px}
h3,h4,h5,h6{font-size:17px;margin:24px 0 8px}
.lede{font-size:clamp(18px,2.4vw,21px);color:var(--muted);margin:0 0 26px;max-width:42em}
.tag{display:inline-block;vertical-align:middle;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin-left:10px;position:relative;top:-4px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
code{background:var(--code);padding:1px 5px;border-radius:5px}
pre code{background:none;padding:0;border-radius:0}
.cmd{position:relative;background:var(--card);border:1px solid var(--line);border-radius:12px;margin:10px 0 22px}
.cmd pre{margin:0;padding:16px 92px 16px 18px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.copy{position:absolute;top:10px;right:10px;font:inherit;font-size:13px;color:var(--muted);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
.copy:hover{color:var(--fg)}
.note{color:var(--muted);font-size:15px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px;padding:0;list-style:none}
.chips li{font-size:14px;background:var(--code);border-radius:999px;padding:2px 12px}
.h{display:inline-block;font-size:12.5px;font-weight:600;border-radius:999px;padding:1px 9px;white-space:nowrap}
.h.ok{color:var(--ok);background:var(--ok-bg)}.h.bad{color:var(--bad);background:var(--bad-bg)}.h.mixed{color:var(--mixed);background:var(--mixed-bg)}.h.none{color:var(--muted);background:var(--none-bg)}.h.comm{color:var(--accent);background:var(--code)}
.proof{font-size:15px;font-weight:600;color:var(--fg);margin:0 0 22px}
small{color:var(--muted);font-size:13px}
form.search{display:flex;gap:8px}
input[type=search]{flex:1;min-width:0;font:inherit;font-size:17px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;outline:none}
input[type=search]:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
form.search button{font:inherit;font-size:16px;color:#fff;background:var(--accent);border:0;border-radius:12px;padding:0 20px;cursor:pointer}
.sites{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}
.sites li a{display:block;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;color:var(--fg)}
.sites li a:hover{text-decoration:none;border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.sites .row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.sites strong{font-size:17px}
.sites p{margin:4px 0 0;color:var(--muted);font-size:15px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sites .meta{white-space:nowrap;display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted)}
.wanted{list-style:none;margin:12px 0 0;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.wanted li{display:flex;justify-content:space-between;gap:12px;padding:10px 18px;border-top:1px solid var(--line)}
.wanted li:first-child{border-top:0}
.wanted .meta{font-size:13px;color:var(--muted);white-space:nowrap}
table.ops{width:100%;border-collapse:collapse;font-size:15px}
.ops th{text-align:left;font-size:13px;font-weight:600;color:var(--muted);border-bottom:1px solid var(--line);padding:8px 10px}
.ops td{border-bottom:1px solid var(--line);padding:12px 10px;vertical-align:top}
.ops td.sig code{background:none;padding:0;font-weight:600;word-break:break-word}
.ops td.sig p{margin:4px 0 0;color:var(--muted);font-size:14px}
.ops .yes{font-weight:600}
.ops small{display:block;margin-top:4px;min-width:9em}
.notes{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:4px 22px}
.notes ul{padding-left:20px}.notes li{margin:6px 0}
.try{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;margin:12px 0}
.try form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.try label{display:flex;flex-direction:column;font-size:13px;color:var(--muted)}
.try input{font:inherit;font-size:15px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;min-width:12em}
.try button{font:inherit;font-size:15px;color:#fff;background:var(--accent);border:0;border-radius:8px;padding:7px 16px;cursor:pointer}
.try>pre{max-height:420px;overflow:auto;background:var(--code);border-radius:8px;padding:12px;margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
footer{border-top:1px solid var(--line);color:var(--muted);font-size:14px;padding:24px 0 40px}
footer p{margin:4px 0}
@media (max-width:680px){
  main{padding-top:30px}
  .cmd pre{padding:46px 16px 14px}
  .sites .row{flex-direction:column;gap:4px}
  .ops thead{display:none}
  .ops tr{display:block;border-bottom:1px solid var(--line);padding:10px 0}
  .ops td{display:inline-block;border:0;padding:3px 16px 3px 0}
  .ops td.sig{display:block}
  .ops td[data-label]:not(.sig)::before{content:attr(data-label) ": ";color:var(--muted);font-size:13px}
}
`;

const SCRIPT = `for(const b of document.querySelectorAll("[data-copy]"))b.addEventListener("click",()=>{navigator.clipboard.writeText(b.previousElementSibling.textContent).then(()=>{b.textContent="Copied";setTimeout(()=>{b.textContent="Copy"},1500)})});for(const f of document.querySelectorAll("form[data-try]"))f.addEventListener("submit",e=>{e.preventDefault();const o=f.nextElementSibling;o.hidden=false;o.textContent="Running…";fetch(f.getAttribute("action")+"?"+new URLSearchParams(new FormData(f))).then(r=>r.json()).then(j=>{o.textContent=JSON.stringify(j,null,2)},()=>{o.textContent="The request failed."})});`;

/**
 * No spec text is ever in a script, and this policy lets no script run but the copy buttons' and the try
 * forms', which fetch only this origin's /v1/try. Without the script a try form opens the JSON instead.
 */
export const CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

// docs/media/logo.svg, made by docs/media/draw.mjs: the favicon and the header's mark
const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="API Anything"><style>@media (prefers-color-scheme: dark){.mark{stroke:#ecebe6}}</style><path class="mark" d="M32,9L32,55M12.1,20.5L51.9,43.5M12.1,43.5L51.9,20.5" fill="none" stroke="#0b0b0b" stroke-width="10" stroke-linecap="round"/></svg>')}`;

/**
 * Structured data for search engines. A `application/ld+json` block is data, never run, so `script-src`
 * does not apply to it; `<`, `>` and `&` are written as JSON escapes so no string can close the element.
 */
export const jsonLd = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}</script>`;

export function layout(o: {
  title: string;
  description: string;
  url: string;
  body: string;
  noindex?: boolean;
  /** escaped markup for the head: jsonLd's */
  head?: string;
}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${o.noindex ? '<meta name="robots" content="noindex">\n' : ""}<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(o.url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="API Anything">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(o.url)}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description)}">
<link rel="icon" href="${ICON}">
<style>${CSS}</style>
${o.head ? `${o.head}\n` : ""}</head>
<body>
<header class="top"><div class="wrap"><a class="brand" href="/"><img src="${ICON}" width="22" height="22" alt="">API Anything</a><nav><a href="/#sites">Sites</a><a href="https://github.com/${REPO}">GitHub</a></nav></div></header>
<main><div class="wrap">
${o.body}
</div></main>
<footer><div class="wrap"><p>API Anything is open source (MIT). Shared operations are learned and checked by the installs that use them; none is affiliated with or endorsed by the site it calls.</p><p><a href="https://github.com/${REPO}">github.com/${REPO}</a> · <a href="/v1/index">index</a></p></div></footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** A copyable block of `text`, which is escaped already. */
export const command = (text: string) =>
  `<div class="cmd"><pre><code>${text}</code></pre><button class="copy" type="button" data-copy>Copy</button></div>`;

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** An op's name as words, for titles: `searchBooks` is "search books". An op named by its fingerprint has none. */
const opWords = (name: string) =>
  /^op_[0-9a-f]{8}$/.test(name)
    ? undefined
    : name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .toLowerCase()
        .trim();

const proofStrip = (s: PublicStats) =>
  `<p class="proof">${[
    `${plural(s.installs.last7Days, "install")} active this week`,
    `${plural(s.calls.last7Days, "call")} this week`,
    `${s.installs.activated.ok.total.toLocaleString("en-US")} of ${plural(s.installs.seen.total, "install")} seen made a call that worked`,
    `${plural(s.community.sites, "site")} taught by the community`,
  ].join(" · ")}</p>`;

const COMMUNITY =
  '<span class="h comm" title="first shared by an API Anything install, not the maintainers">taught by an install</span>';

/* ------------------------------------------------------------------ pages */

/** `sites` in the order to list them: every site, or a query's matches best first. */
export function homePage(
  sites: ServedSite[],
  origin: string,
  query?: string,
  demand: { domain: string; networks: number }[] = [],
  extra: { stats?: PublicStats; community?: Set<string> } = {},
): string {
  const rows = sites.map((s) => {
    const h = summary(s);
    const n = s.operations.length;
    const taught = extra.community?.has(s.name) ? ` ${COMMUNITY}` : "";
    return `<li><a href="/sites/${encodeURIComponent(s.name)}">
<div class="row"><strong>${esc(titleOf(s))}</strong><span class="meta">${n} operation${n === 1 ? "" : "s"}${taught} <span class="h ${h.tone}">${esc(h.label)}</span></span></div>
${s.description ? `<p>${esc(s.description)}</p>` : ""}</a></li>`;
  });
  const none = query
    ? "No shared site matches. Your agent can learn it: ask it to turn the site into an API."
    : "Nothing is shared yet.";
  const body = `<h1>API Anything</h1>
<p class="lede">${esc(TAGLINE)} It learns the requests a site's own pages make, then your agent calls them over MCP, the CLI or TypeScript and gets JSON back.</p>
${extra.stats ? `${proofStrip(extra.stats)}\n` : ""}<p class="note">Set it up for your agents (Claude Code, Codex, Cursor, Claude Desktop, Gemini CLI, VS Code):</p>
${command(esc(INSTALL))}
<h2 id="sites">Shared sites</h2>
<p class="note">Operations other installs learned. Each is checked by the installs that call it: live means installs other than its uploader confirmed it works.</p>
<form class="search" method="get" action="/#sites" role="search"><input id="q" name="q" type="search" placeholder="Search: book ratings, flight prices…" aria-label="Search shared sites" autocomplete="off" value="${esc(query ?? "")}"><button type="submit">Search</button></form>
${query ? `<p class="note">${sites.length} match${sites.length === 1 ? "" : "es"} for “${esc(query)}” · <a href="/#sites">all sites</a></p>` : ""}
${rows.length ? `<ul class="sites" id="site-list">\n${rows.join("\n")}\n</ul>` : `<p class="note">${none}</p>`}
${
  demand.length
    ? `<h2 id="wanted">Asked for, not shared yet</h2>
<p class="note">Sites agents looked for in the last 30 days that nobody has shared, by how many networks asked. Teaching one to your agent shares it with all of them.</p>
<ul class="wanted">${demand.map((d) => `<li><a href="/wanted/${encodeURIComponent(d.domain)}">${esc(d.domain)}</a><span class="meta">${plural(d.networks, "network")}</span></li>`).join("")}</ul>`
    : ""
}`;
  return layout({
    title: "API Anything: call any website like an API from your agent",
    description: `${TAGLINE} Shared, unofficial APIs for ${sites.slice(0, 6).map(titleOf).join(", ")} and more.`,
    url: `${origin}/`,
    body,
    head: jsonLd({ "@context": "https://schema.org", "@type": "WebSite", name: "API Anything", url: `${origin}/` }),
  });
}

/** Who shared a site: whether an install first shared it, and how many of its served ops installs uploaded. */
export interface Provenance {
  byInstall: boolean;
  opsByInstalls: number;
}

function provenanceNote(p: Provenance, n: number): string {
  const ops = p.opsByInstalls;
  if (p.byInstall)
    return `${COMMUNITY} First shared by an API Anything install, not by the maintainers${ops < n ? `; ${ops} of its ${plural(n, "operation")} came from installs` : ""}.`;
  return `Seeded by the maintainers${ops ? `; ${ops} of its ${plural(n, "operation")} came from installs` : ""}.`;
}

/** An op a visitor can run from the page (registry/src/try.ts `tryable`), with the args its form starts from. */
export interface Tryable {
  op: Operation;
  args: Record<string, unknown>;
}

function tryBlock(site: string, origin: string, tries: Tryable[]): string {
  const forms = tries.map(({ op, args }) => {
    const path = `/v1/try/${encodeURIComponent(site)}/${encodeURIComponent(op.name)}`;
    const inputs = op.params.map((p) => {
      const v = args[p.name];
      const hint = p.hint ?? p.description;
      return `<label>${esc(p.name)}<input name="${esc(p.name)}" value="${v === undefined ? "" : esc(argText(v))}"${hint ? ` placeholder="${esc(clip(hint, 60))}"` : ""}${p.required ? " required" : ""}></label>`;
    });
    const query = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, argText(v)])).toString();
    return `<div class="try"><p><code>${esc(op.name)}</code>${op.description ? ` <small>${esc(clip(op.description, 160))}</small>` : ""}</p>
<form method="get" action="${esc(path)}" data-try>${inputs.join("")}<button type="submit">Run</button></form>
<pre hidden aria-live="polite"></pre>
${command(esc(`curl -s ${shellArg(`${origin}${path}${query ? `?${query}` : ""}`)}`))}</div>`;
  });
  return `<h2 id="run">Run it here, no install</h2>
<p class="note">Run one of these from the catalog's server, with no install: one live read, sent once without cookies, limited per network and cached for 10 minutes. Your agent calls the site from your own machine instead.</p>
${forms.join("\n")}`;
}

export function sitePage(s: ServedSite, origin: string, provenance?: Provenance, tries: Tryable[] = []): string {
  const title = titleOf(s);
  const rows = s.operations.map((o) => {
    const sum = summarize(o.operation);
    return `<tr>
<td class="sig" data-label="Operation"><code>${esc(sum.op)}</code>${o.operation.description ? `<p>${esc(o.operation.description)}</p>` : ""}</td>
<td data-label="Method">${esc(sum.method)}</td>
<td data-label="Login">${sum.login ? '<span class="yes">needed</span>' : "no"}</td>
<td data-label="Writes">${sum.write ? '<span class="yes">yes</span>' : "no"}</td>
<td data-label="Status">${statusCell(o)}</td>
</tr>`;
  });
  const h = summary(s);
  const opNames = s.operations.map((o) => o.operation.name).join(", ");
  const description = clip(
    `Unofficial ${title} API for AI agents${s.description ? `: ${s.description}` : "."} Operations: ${opNames}. Call ${s.domain} from Claude Code, Codex, Cursor or any MCP client and get JSON back.`,
    300,
  );
  // live ops first: what the title promises should work
  const ranked = [...s.operations].sort((a, b) => Number(b.status === "live") - Number(a.status === "live"));
  const words = [...new Set(ranked.flatMap((o) => opWords(o.operation.name) ?? []))].join(", ");
  const pageTitle = words
    ? `${title} API for AI agents: ${clip(words, 60)} | API Anything`
    : `${title} API for AI agents (unofficial) | API Anything`;
  const url = `${origin}/sites/${encodeURIComponent(s.name)}`;
  const structured = jsonLd({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebAPI",
        name: `${title} API (unofficial)`,
        description,
        url,
        documentation: url,
        isAccessibleForFree: true,
        about: { "@type": "WebSite", name: title, url: `https://${s.domain}` },
        provider: { "@type": "Organization", name: "API Anything", url: `https://github.com/${REPO}` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "API Anything", item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: `${title} API`, item: url },
        ],
      },
    ],
  });
  const body = `<h1>${esc(title)} API<span class="tag">unofficial</span></h1>
${s.description ? `<p class="lede">${esc(s.description)}</p>` : ""}
<ul class="chips" aria-label="Domain"><li>${esc(s.domain)}</li></ul>
<p class="note"><span class="h ${h.tone}">${esc(h.label)}</span> ${s.operations.length} operation${s.operations.length === 1 ? "" : "s"}, checked by the installs that call them.</p>
${provenance ? `<p class="note">${provenanceNote(provenance, s.operations.length)}</p>` : ""}
<h2>Try it</h2>
<p class="note">Set up API Anything for your agents:</p>
${command(esc(INSTALL))}
<p class="note">Then ask your agent, which finds this site by itself, or call it from a shell:</p>
${command(sampleCommands(s.name, sampleOp(s)))}
${tries.length ? `${tryBlock(s.name, origin, tries)}\n` : ""}<h2>Operations</h2>
<table class="ops">
<thead><tr><th>Operation</th><th>Method</th><th>Login</th><th>Writes</th><th>Status</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
${s.notes ? `<h2>Notes</h2>\n<div class="notes">${markdown(s.notes)}</div>` : ""}
<h2>About these operations</h2>
<p>Each operation is a request learned from ${esc(title)}'s own web pages: API Anything replays it over plain HTTP and falls back to a browser when it must. <a href="/v1/sites/${encodeURIComponent(s.name)}">Read them as JSON</a>.</p>
<p><a href="/">← All shared sites</a></p>`;
  return layout({
    title: pageTitle,
    description,
    url,
    body,
    head: structured,
    // a site nobody else confirmed may say it is any brand: no search engine should list it
    noindex: !s.operations.some((o) => o.status === "live"),
  });
}

/** The home page, each confirmed site's page, and each indexable wanted page (`wanted`: their domains). */
export function sitemap(names: string[], origin: string, wanted: string[] = []): string {
  const urls = [
    "/",
    ...names.map((n) => `/sites/${encodeURIComponent(n)}`),
    ...wanted.map((d) => `/wanted/${encodeURIComponent(d)}`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${esc(`${origin}${u}`)}</loc></url>`).join("\n")}
</urlset>
`;
}
