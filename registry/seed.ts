/**
 * Seeds the registry with the bundled specs: each `sites/<name>.json` with the caller notes of its `.md`
 * (the text before `## Maintainer notes`, as `siteNotes` in src/store.ts reads it), as live versions.
 *
 *   npx tsx registry/seed.ts <registry url> [sites dir]
 *
 * The maintainer's token is read from ~/.api-anything-admin-token.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { siteOf } from "../src/domain.js";
import type { SiteContext } from "../src/registry-api.js";
import { parseSite } from "../src/spec.js";

const [url, dir = join(import.meta.dirname, "..", "sites")] = process.argv.slice(2);
if (!url) throw new Error("usage: npx tsx registry/seed.ts <registry url> [sites dir]");
const token = readFileSync(join(homedir(), ".api-anything-admin-token"), "utf8").trim();

let failed = 0;
for (const file of readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .sort()) {
  const name = file.slice(0, -5);
  const site = parseSite(JSON.parse(readFileSync(join(dir, file), "utf8")));
  const md = join(dir, `${name}.md`);
  const notes = existsSync(md)
    ? readFileSync(md, "utf8")
        .split(/^## Maintainer notes\s*$/im)[0]!
        .trim()
    : undefined;
  const context: SiteContext = {
    name,
    domain: siteOf(new URL(site.baseUrl).hostname),
    baseUrl: site.baseUrl,
    ...(site.displayName ? { displayName: site.displayName } : {}),
    ...(site.description ? { description: site.description } : {}),
    ...(site.loginCookies ? { loginCookies: site.loginCookies } : {}),
    ...(site.pace && Object.keys(site.pace).length ? { pace: site.pace } : {}),
    ...(notes ? { notes } : {}),
  };
  const res = await fetch(new URL("/v1/admin/seed", url), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ site: context, operations: site.operations }),
  });
  const body = (await res.json()) as {
    operations?: { name: string; status: string }[];
    error?: string;
    reasons?: string[];
  };
  if (res.ok) console.log(`${name}: ${body.operations!.map((o) => `${o.name} ${o.status}`).join(", ")}`);
  else {
    failed++;
    console.log(`${name}: ${res.status} ${body.error}${body.reasons ? `\n  ${body.reasons.join("\n  ")}` : ""}`);
  }
}
process.exitCode = failed ? 1 : 0;
