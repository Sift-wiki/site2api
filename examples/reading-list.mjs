// A reading list from Goodreads, with no browser and no model: plain calls to the goodreads
// operations an agent explored (sites/goodreads.json). Read-only.
// Usage: node examples/reading-list.mjs "Circe by Madeline Miller" "Piranesi by Susanna Clarke" ...
import { call, shutdown } from "api-anything";

const books = process.argv.slice(2);
if (!books.length)
  books.push(
    "Circe by Madeline Miller",
    "Piranesi by Susanna Clarke",
    "The Left Hand of Darkness by Ursula K. Le Guin",
  );
const calls = [];
async function read(op, args) {
  const r = await call("goodreads", op, args);
  calls.push({ op, tier: r.tier, ms: r.ms, ok: r.ok });
  if (!r.ok) throw new Error(`goodreads.${op}: ${r.class}: ${r.reason}. ${r.next ?? ""}`);
  return Array.isArray(r.data) ? r.data : [r.data];
}
const num = (s) => Number(String(s ?? "").replace(/[^\d.]/g, "")) || 0;
const same = (a, b) =>
  String(a)
    .toLowerCase()
    .replace(/[^a-z]/g, "") ===
  String(b)
    .toLowerCase()
    .replace(/[^a-z]/g, "");

const t0 = Date.now();
const rows = [];
try {
  for (const entry of books) {
    const [title, author] = entry.split(/ by /i);
    // search by title (a "title author" query ranks study guides first), then pick by author and popularity
    const hits = await read("searchBooks", { q: title });
    const byAuthor = author
      ? hits.filter(
          (h) =>
            same(h.author, author) || String(h.author).toLowerCase().includes(author.toLowerCase().split(" ").at(-1)),
        )
      : hits;
    const hit = byAuthor.sort((a, b) => num(b.ratingsCount) - num(a.ratingsCount))[0];
    if (!hit) {
      rows.push({ entry, missing: true });
      continue;
    }
    const [book] = await read("getBook", { bookId: String(hit.bookId) });
    const others = (await read("authorBooks", { authorId: String(hit.authorId) }))
      .filter((b) => !same(b.title, book.title) && num(b.ratingsCount) >= 20_000)
      .sort((a, b) => num(b.avgRating) - num(a.avgRating));
    rows.push({
      title: book.title,
      author: book.author,
      rating: book.avgRating,
      ratings: num(book.ratingsCount),
      pages: num(book.pages),
      genres: (book.genres ?? []).slice(0, 3).join(", "),
      next: others[0] ? `${others[0].title} (${others[0].avgRating})` : "",
    });
  }
  console.log(
    "| book | author | rating | ratings | pages | genres | author's best other book |\n|---|---|---|---|---|---|---|",
  );
  for (const r of rows)
    console.log(
      r.missing
        ? `| ${r.entry} | not found | | | | | |`
        : `| ${r.title} | ${r.author} | ${r.rating} | ${r.ratings.toLocaleString("en-US")} | ${r.pages || ""} | ${r.genres} | ${r.next} |`,
    );
  const tiers = [...new Set(calls.map((c) => c.tier))].join(", ");
  console.error(
    `${calls.length} calls, all ok, tier ${tiers}, ${((Date.now() - t0) / 1000).toFixed(1)} s total, no browser, no model`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await shutdown();
}
