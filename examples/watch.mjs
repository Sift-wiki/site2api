// Watch Hacker News for new stories that mention a project, and print only what is new. Made for cron
// (every 30 minutes, say): the first run records what is there, and each later run prints the stories
// posted since the run before. One plain HTTP request a run, no browser, no account, no model.
// Usage: node examples/watch.mjs "api-anything"
// crontab: */30 * * * * node /path/to/examples/watch.mjs "api-anything" >> ~/hn-mentions.log
import { call, shutdown } from "api-anything";

const query = process.argv[2] ?? "api-anything";
try {
  const r = await call(
    "hacker-news",
    "searchByDate",
    { query, type: "story" },
    // changesOnly: the answer is what changed since the last run, never the whole list again
    { changesOnly: true, view: { fields: ["title", "objectID", "created_at"] } },
  );
  if (!r.ok) {
    console.error(`${r.class}: ${r.reason}\nnext: ${r.next}`);
    process.exitCode = 1;
  } else if (r.changes.first) {
    console.log(`watching "${query}" on Hacker News; the next run prints what is new`);
  } else if (!r.changes.added.length) {
    console.log(`nothing new about "${query}" since ${r.changes.since}`);
  } else {
    for (const s of r.changes.added)
      console.log(`${s.created_at}  ${s.title}  https://news.ycombinator.com/item?id=${s.objectID}`);
  }
} finally {
  await shutdown();
}
