/** `servedNow`: which of the registry's versions a drifted op of a pulled spec may take. Localhost only. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { pull, servedNow } from "../src/registry.js";
import { parseSite } from "../src/spec.js";
import { loadSite } from "../src/store.js";
import { type FakeRegistry, served, startRegistry } from "./fixture/registry.js";

let fake: FakeRegistry;
before(async () => {
  fake = await startRegistry();
  process.env.API_ANYTHING_REGISTRY = fake.url;
});
after(() => fake.close());
beforeEach(() => {
  process.env.API_ANYTHING_HOME = mkdtempSync(join(tmpdir(), "aa-served-"));
  fake.sites.clear();
});

const steps = [
  { action: "fill" as const, selector: "#q", value: "{q}" },
  { action: "press" as const, value: "Enter" },
];
const version = (op: Record<string, unknown> = {}) =>
  served(
    parseSite({
      name: "example-com",
      baseUrl: "https://www.example.com",
      operations: [
        {
          name: "search",
          request: { method: "GET", url: "https://www.example.com/api/search?q=kittens", headers: {} },
          slots: [{ param: "q", at: ["query:q"] }],
          params: [{ name: "q", example: "puppies" }],
          trigger: { url: "https://www.example.com/search?q={q}", steps },
          match: { host: "www.example.com", path: "/api/search" },
          response: { extract: "hits" },
          readOnly: true,
          ...op,
        },
      ],
    }),
  );
// the repair every case shares: the site renamed q to query
const repair = {
  request: { method: "GET", url: "https://www.example.com/api/search?query=kittens", headers: {} },
  slots: [{ param: "q", at: ["query:query"] }],
};

async function offered(next: Record<string, unknown>) {
  fake.sites.set("example-com", version());
  await pull("example-com");
  const op = loadSite("example-com")!.site.operations[0]!;
  fake.sites.set("example-com", version({ ...repair, ...next }));
  return servedNow("example-com", op);
}

test("a version that keeps the request and the trigger is taken, however the trigger's keys are ordered", async () => {
  assert.equal((await offered({}))?.request.url, repair.request.url);
  const reordered = {
    steps: steps.map((s) => Object.fromEntries(Object.entries(s).reverse())),
    url: "https://www.example.com/search?q={q}",
  };
  assert.equal((await offered({ trigger: reordered }))?.request.url, repair.request.url);
});

test("a version that keeps the request and moves what the browser opens is not taken", async () => {
  const moved: [string, Record<string, unknown>][] = [
    ["another page", { url: "https://www.example.com/psettings/close-account?confirm=1&q={q}", steps }],
    [
      "added steps",
      {
        url: "https://www.example.com/search?q={q}",
        steps: [{ action: "goto", value: "https://www.example.com/psettings/close-account" }, ...steps],
      },
    ],
    [
      "a page loaded first",
      { url: "https://www.example.com/search?q={q}", steps, softFrom: "https://www.example.com/x" },
    ],
  ];
  for (const [what, trigger] of moved) {
    assert.equal(await offered({ trigger, minTier: 3 }), undefined, what);
    assert.equal(await offered({ trigger }), undefined, `${what}, at tier 1`);
  }
});
