// Who's talking about my project: Hacker News stories and comments, Reddit, YouTube, new GitHub
// repositories and Mastodon, searched at once over plain HTTP and merged newest first.
// No browser, no account, no API keys. Read-only.
// Usage: node examples/mentions.mjs <project> [--days 7] [--limit 12] [--json]
import { call } from "api-anything";

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(argv.splice(i, 2)[1]);
};
const days = option("days", 7);
const limit = option("limit", 12);
const json = argv.includes("--json");
const project = argv.filter((a) => a !== "--json").join(" ") || "duckdb";
const since = Date.now() - days * 86_400_000;
const sinceDay = new Date(since).toISOString().slice(0, 10);
// YouTube's own upload-date filters (sites/youtube.md); its search results carry no date.
const uploaded = days <= 1 ? "EgQIAhAB" : days <= 7 ? "EgQIAxAB" : days <= 31 ? "EgQIBBAB" : "EgQIBRAB";

const text = (html) =>
  String(html ?? "")
    .replace(/<\/?(a|b|em|i|span|strong)\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(quot|amp|gt|lt);/g, (_, e) => ({ quot: '"', amp: "&", gt: ">", lt: "<" })[e])
    .replace(/\s+/g, " ")
    .trim();
// A comment from just before the first mention, so its line shows why it matched.
const around = (s) => {
  const i = s.toLowerCase().indexOf(project.toLowerCase());
  return i < 30 ? s : `…${s.slice(s.lastIndexOf(" ", i - 20) + 1)}`;
};
const hn = (id) => `https://news.ycombinator.com/item?id=${id}`;
const mention = (at, where, score, title, url) => ({ at, where, score, title, url });

// One read per source, and how each of its items becomes a mention.
const sources = [
  [
    "hacker-news",
    "searchByDate",
    { query: project },
    (s) => mention(s.created_at, "HN", `${s.points} pts`, s.title, hn(s.objectID)),
  ],
  [
    "hacker-news",
    "searchByDate",
    { query: project, type: "comment" },
    (c) => mention(c.created_at, "HN comment", "", around(text(c.comment_text)), hn(c.objectID)),
  ],
  [
    "reddit",
    "search",
    { query: project },
    (p) => mention(p.posted, `r/${p.subreddit}`.replace("r/r/", "r/"), `${p.votes} votes`, p.title, p.url),
  ],
  [
    "youtube",
    "search",
    { q: project, filter: uploaded },
    (v) =>
      mention(null, "YouTube", v.views ?? "", `${v.title} (${v.channel})`, `https://www.youtube.com/watch?v=${v.id}`),
  ],
  [
    "github",
    "searchRepos",
    { q: `${project} created:>${sinceDay}` },
    (r) =>
      mention(
        r.updatedAt,
        "GitHub repo",
        `${r.stars} stars`,
        `${r.owner}/${r.name} ${text(r.description)}`,
        `https://github.com/${r.owner}/${r.name}`,
      ),
  ],
];
// A hashtag is one word.
if (/^[\p{L}\p{N}_]+$/u.test(project))
  sources.push([
    "mastodon",
    "tagTimeline",
    { tag: project },
    (p) => mention(p.created_at, "Mastodon", `${p.favourites_count} favs`, `${p.account}: ${text(p.content)}`, p.url),
  ]);

const t0 = Date.now();
// Different sites run in parallel; calls to one site are paced about a second apart.
const results = await Promise.all(
  sources.map(async ([site, op, args, toMention]) => {
    // maxTier 1 is plain HTTP only: a site that would need a browser answers `blocked` instead.
    const r = await call(site, op, args, { maxTier: 1 });
    const items = r.ok ? (r.data ?? []).map(toMention).filter((m) => !m.at || Date.parse(m.at) >= since) : [];
    const source = `${site}.${op}${args.type ? ` (${args.type}s)` : ""}`;
    return { source, ok: r.ok, class: r.class, tier: r.tier, ms: r.ms, reason: r.reason, items };
  }),
);
const seconds = ((Date.now() - t0) / 1000).toFixed(1);
// Newest first. YouTube's results have no date: its own filter kept them to the window, and they come last.
const mentions = results.flatMap((r) => r.items).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

if (json) {
  const calls = results.map(({ items, ...r }) => ({ ...r, mentions: items.length }));
  console.log(JSON.stringify({ project, days, seconds: Number(seconds), mentions, calls }, null, 2));
} else {
  // Cut to n terminal columns; CJK and full-width characters take two.
  const width = (c) => (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60]/.test(c) ? 2 : 1);
  const cut = (s, n) => {
    if ([...s].reduce((w, c) => w + width(c), 0) <= n) return s;
    let out = "";
    for (const c of s) {
      if ([...out].reduce((w, c) => w + width(c), width(c)) > n - 1) break;
      out += c;
    }
    return `${out}…`;
  };
  const ago = (at) => {
    const h = (Date.now() - Date.parse(at)) / 3_600_000;
    return !at
      ? `< ${days}d`
      : h < 1
        ? `${Math.ceil(h * 60)}m ago`
        : h < 48
          ? `${Math.round(h)}h ago`
          : `${Math.round(h / 24)}d ago`;
  };
  console.log(`${mentions.length} mentions of "${project}" in the last ${days} days, newest first\n`);
  for (const m of mentions.slice(0, limit))
    console.log(
      `${ago(m.at).padStart(7)}  ${cut(m.where, 13).padEnd(13)} ${m.score.padStart(11)}  ${cut(m.title, 64)}`,
    );
  if (mentions.length > limit)
    console.log(`         … ${mentions.length - limit} more: --limit, or --json for every link`);
  console.log("");
  for (const r of results) {
    const said = r.ok ? `tier ${r.tier}  ${r.items.length} in the window` : cut(r.reason ?? "", 44);
    console.log(`${r.source.padEnd(35)} ${r.class.padEnd(8)} ${`${r.ms} ms`.padStart(8)}  ${said}`);
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok} of ${results.length} calls answered in ${seconds} s: plain HTTP, no browser, no API keys`);
}
