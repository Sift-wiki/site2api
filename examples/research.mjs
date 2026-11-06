// Read-only workflow. Run after npm install: node examples/research.mjs "agent memory"
// Add --linkedin to enrich up to three matching companies using your imported session.
import { call, shutdown } from "api-anything";

const query = process.argv[2] || "agent memory";
const calls = [];
async function read(site, op, args) {
  const result = await call(site, op, args);
  calls.push({ op: `${site}.${op}`, args, ok: result.ok, tier: result.tier, ms: result.ms });
  if (!result.ok) throw new Error(`${site}.${op}: ${result.class}: ${result.reason}. ${result.next ?? ""}`);
  if (result.truncated) throw new Error(`${site}.${op}: result was truncated; narrow the query`);
  return result.data;
}

try {
  const stories = await read("hacker-news", "search", { query });
  const report = {
    query,
    stories: stories.slice(0, 5).map((s) => ({
      title: s.title,
      url: s.url,
      points: s.points,
      comments: s.num_comments,
      date: s.created_at?.slice(0, 10),
    })),
  };
  if (process.argv.includes("--linkedin")) {
    const matches = await read("linkedin", "searchCompanies", { keywords: query });
    report.companies = [];
    for (const company of matches.slice(0, 3)) {
      if (!company.universalName) throw new Error("LinkedIn search result lacks the company ID needed for enrichment");
      const c = await read("linkedin", "getCompany", { universalName: company.universalName });
      report.companies.push({
        name: c.name,
        universalName: c.universalName,
        tagline: c.tagline,
        industry: c.industry,
        staff: c.staffCount,
        hq: [c.headquarters?.city, c.headquarters?.country].filter(Boolean).join(", ") || undefined,
        website: c.website,
      });
    }
  }
  report.calls = calls;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await shutdown();
}
