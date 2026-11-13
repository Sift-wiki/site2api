/**
 * A page per domain agents asked for and nobody shared (docs/REGISTRY.md "Demand"), asking the visitor to
 * teach it. A demand domain came from someone's search, so only a clean registrable domain gets a page,
 * and it is escaped like any spec string.
 */
import { domainOf } from "../../src/search.js";
import { badAddress } from "../../src/vet.js";
import { command, esc, layout, plural } from "./pages.js";

/** Networks that must have asked before a wanted page is listed for search engines: one is too thin. */
export const WANTED_INDEX_NETWORKS = 2;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN = new RegExp(`^(?=.{4,253}$)(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);

/**
 * Whether `s` is a lowercase registrable domain on a public suffix, exactly as demand records one: no host,
 * port or path. Not a name of someone's own network (corp.internal, printer.home.arpa, nas.local), which a
 * search may name and no public list may show.
 */
export const cleanDomain = (s: string) => DOMAIN.test(s) && domainOf(s) === s && !badAddress(`https://${s}`);

export function wantedPage(d: { domain: string; networks: number }, origin: string, days: number): string {
  const { domain, networks } = d;
  const asked = plural(networks, "network");
  const learn = [
    `# a page of ${domain} that shows what you want, with {q} where your value goes`,
    `npx -y api-anything learn 'https://${domain}/search?q={q}' --args q=<value> --args2 q=<another value> --args3 q=<a third>`,
  ].join("\n");
  const body = `<h1>${esc(domain)} API<span class="tag">wanted</span></h1>
<p class="lede">Agents on ${esc(asked)} looked for ${esc(domain)} in the last ${days} days. Nobody has taught it to API Anything yet: the first install that does shares it with all of them.</p>
<h2>Teach it to your agent</h2>
<p class="note">1. Set up API Anything for your agents (Claude Code, Codex, Cursor, Claude Desktop):</p>
${command(esc("npx -y api-anything setup"))}
<p class="note">2. Ask your agent, saying what you want from the site:</p>
${command(esc(`Turn ${domain} into an API: <what you want from it, e.g. search results with prices>`))}
<p class="note">Or learn it from a shell. <code>--args</code> is the value you want the answer for, <code>--args2</code> another real value of the same kind, <code>--args3</code> a third:</p>
${command(esc(learn))}
<h2>What happens next</h2>
<p>Your agent learns the request ${esc(domain)}'s own page makes, proves it with a second and a third value and a call with no cookies, and answers you. With sharing on (setup's default), a read that works without a login is shared. Once installs on other networks confirm it, it is live here and every agent that asks for ${esc(domain)} calls it instead of learning it again. Nothing you sign in to is shared without your yes.</p>
<p><a href="/#wanted">← Other sites agents asked for</a> · <a href="/">All shared sites</a></p>`;
  return layout({
    title: `${domain} API for AI agents: asked for on ${asked}, nobody has taught it yet | API Anything`,
    description: `Agents on ${asked} asked for an unofficial ${domain} API in the last ${days} days. Teach it to your agent with API Anything once, and every agent can call ${domain} like an API.`,
    url: `${origin}/wanted/${encodeURIComponent(domain)}`,
    body,
    // a domain one network asked for is too thin a page to list
    noindex: networks < WANTED_INDEX_NETWORKS,
  });
}
