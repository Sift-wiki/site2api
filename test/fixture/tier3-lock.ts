/**
 * A tier-3 write the page sent and the site accepted, whose session save then meets a lock another
 * process holds. node:test module mocks need --experimental-test-module-mocks; execute.test.ts launches it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { CaptureResult, StoredCookie } from "../../src/types.js";

const HOME = mkdtempSync(join(tmpdir(), "api-anything-tier3-lock-"));
process.env.API_ANYTHING_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

let runs = 0;
/** what the stubbed page run does after it sent the write: answer, or fail on a lock */
let afterSend: "answer" | "busy" = "answer";
/** what the site answers the write, and the cookies the run ends with */
let page: { status: number; body: string; cookies: StoredCookie[] } = { status: 200, body: '{"id":1}', cookies: [] };
const { LockBusy } = await import("../../src/lock.js");
const browser = await import("../../src/browser.js");
mock.module(new URL("../../src/browser.ts", import.meta.url).href, {
  namedExports: {
    ...browser,
    browserAvailable: () => true,
    closeBrowser: async () => {},
    runTrigger: async (): Promise<CaptureResult> => {
      runs++;
      if (afterSend === "busy") throw new LockBusy(join(HOME, "elsewhere.json"), 200);
      const request = { method: "POST", url: "http://127.0.0.1/api/create", headers: {}, body: "{}" };
      const response = { status: page.status, headers: {}, body: page.body, contentType: "application/json" };
      return {
        exchanges: [{ id: 1, resourceType: "fetch", request, response }],
        cookies: page.cookies,
        finalUrl: "http://127.0.0.1/compose",
      };
    },
  },
});
const { call } = await import("../../src/execute.js");
const { loadSession, lockWait, mergeCapture, saveSession, sessionFile } = await import("../../src/session.js");
const { readSealed } = await import("../../src/seal.js");
const { parseSite } = await import("../../src/spec.js");
const { loadWrites, saveSite } = await import("../../src/store.js");
const { holdInChild, kill } = await import("./locks.js");

const create = () =>
  saveSite(
    parseSite({
      name: "fixture",
      baseUrl: "http://127.0.0.1",
      operations: [
        {
          name: "create",
          readOnly: false,
          minTier: 3,
          request: { method: "POST", url: "http://127.0.0.1/api/create", headers: {}, body: "{}" },
          match: { method: "POST", host: "127.0.0.1", path: "/api/create" },
          trigger: { url: "http://127.0.0.1/compose", steps: [{ action: "click", selector: "#send" }], companions: [] },
        },
      ],
    }),
  );
const reset = () => {
  rmSync(join(HOME, "writes.json"), { force: true });
  runs = 0;
  afterSend = "answer";
  page = { status: 200, body: '{"id":1}', cookies: [] };
  create();
};

/** A call of the write while another process holds the session lock. */
async function callHeld() {
  const holder = await holdInChild(sessionFile("fixture"));
  lockWait.ms = 200;
  try {
    return await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 0 });
  } finally {
    lockWait.ms = 30_000;
    await kill(holder);
  }
}

const ROTATED = "rotated-5e55ion-7f3a9c21d84b6e05";
const rotated: StoredCookie = {
  name: "sid",
  value: ROTATED,
  domain: "127.0.0.1",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
};
const onDisk = () => readSealed<{ cookies?: StoredCookie[] }>(sessionFile("fixture"), {}, "session:fixture", "");

test("a tier-3 write whose session save meets a held lock keeps its answer, and an identical call does not send it again", async () => {
  reset();
  saveSession("fixture", { cookies: [], values: {} });
  const holder = await holdInChild(sessionFile("fixture"));
  lockWait.ms = 200;
  let first: Awaited<ReturnType<typeof call>>;
  try {
    first = await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 0 });
  } finally {
    lockWait.ms = 30_000;
    await kill(holder);
  }
  assert.equal(runs, 1);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.write, "accepted");
  assert.equal(first.warning, undefined, "the run captured nothing new: nothing was lost");
  assert.deepEqual(
    loadWrites({ site: "fixture" }).map((w) => w.status),
    ["accepted"],
  );

  const second = await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 0 });
  assert.equal(runs, 1, "the write is not sent again");
  assert.equal(second.ok, false);
  assert.equal(second.class, "duplicate", JSON.stringify(second));
  assert.notEqual(second.write, "accepted");
});

test("a busy lock that is not the send slot's may come after the send: the write may have applied, and is not sent again", async () => {
  reset();
  afterSend = "busy";
  const first = await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 0 });
  assert.equal(runs, 1);
  assert.deepEqual(
    [first.ok, first.write, first.retry, first.nextCall?.action],
    [false, "may_have_applied", "no", "check_site"],
    JSON.stringify(first),
  );
  assert.deepEqual(
    loadWrites({ site: "fixture" }).map((w) => w.status),
    ["may_have_applied"],
  );
  const second = await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 0 });
  assert.equal(runs, 1, "the write is not sent again");
  assert.equal(second.class, "duplicate", JSON.stringify(second));
});

test("a tier-3 write's busy send slot sends nothing: not_sent, and a retry is safe", async () => {
  reset();
  const pace = await holdInChild(join(HOME, "pace.json"));
  lockWait.ms = 200;
  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await call("fixture", "create", {}, { allowWrites: true, minIntervalMs: 1000 });
  } finally {
    lockWait.ms = 30_000;
    await kill(pace);
  }
  assert.equal(runs, 0);
  assert.deepEqual([r.ok, r.write, r.retry], [false, "not_sent", "safe"], JSON.stringify(r));
  assert.deepEqual(
    loadWrites({ site: "fixture" }).map((w) => w.status),
    ["not_sent"],
  );
});

test("a tier-3 write's session that could not be saved: a captured cookie the error body echoes never reaches the result", async () => {
  reset();
  saveSession("fixture", { cookies: [{ ...rotated, value: "old-session-value-1b2c3d4e5f60" }], values: {} });
  page = { status: 500, body: `{"error":"session sid=${ROTATED} could not be renewed"}`, cookies: [rotated] };
  const r = await callHeld();
  assert.equal(runs, 1);
  assert.equal(r.write, "may_have_applied", JSON.stringify(r));
  assert.match(r.reason ?? "", /could not be renewed/, "the body is quoted, so redaction is what keeps the value out");
  assert.ok(!JSON.stringify(r).includes(ROTATED), JSON.stringify(r));
  assert.ok(!JSON.stringify(loadWrites({ site: "fixture" })).includes(ROTATED));
  assert.match(r.warning ?? "", /could not be saved/);
});

test("a tier-3 write's session that could not be saved: the write stays accepted, the call warns, and this process keeps the session until a save succeeds", async () => {
  reset();
  saveSession("fixture", { cookies: [{ ...rotated, value: "old-session-value-1b2c3d4e5f60" }], values: {} });
  page = { status: 200, body: '{"id":1}', cookies: [rotated] };
  const r = await callHeld();
  assert.equal(runs, 1);
  assert.deepEqual([r.ok, r.write], [true, "accepted"], JSON.stringify(r));
  assert.match(r.warning ?? "", /the session the site set during this call could not be saved/);
  assert.match(r.next ?? "", /do not send it again.*api-anything login fixture/);
  assert.equal(loadSession("fixture").cookies.find((c) => c.name === "sid")?.value, ROTATED, "kept in memory");
  assert.notEqual(onDisk().cookies?.find((c) => c.name === "sid")?.value, ROTATED, "not on disk yet");
  mergeCapture("fixture", []); // the lock is free now: the next save writes it
  assert.equal(onDisk().cookies?.find((c) => c.name === "sid")?.value, ROTATED);
});
