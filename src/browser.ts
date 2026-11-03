/**
 * The browser layer: an installed Chromium (Google Chrome by default, or Brave, Edge, Chromium,
 * Vivaldi, Arc, or any `API_ANYTHING_BROWSER`) via playwright-core, one persistent profile per
 * process. Produces raw Exchanges for the learner (tier 3 / create / heal) and tier-2 page fetches.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import type { BrowserContext, Cookie, chromium, Dialog, Frame, Page, Request, Response, Route } from "playwright-core";
import { botWall } from "./classify.js";
import { SIGN_IN_AUTOCOMPLETE, SIGN_IN_REFUSAL } from "./secrets.js";
import { home, siteOf, writePrivate } from "./session.js";
import type { Request as Hop } from "./spec.js";
import type { CaptureResult, Exchange, SeenDialog, StoredCookie, TriggerStep } from "./types.js";

let current: { profileDir: string; headless: boolean; ctx: Promise<BrowserContext> } | undefined;
let headlessUA: string | undefined;
const originPages = new Map<string, OriginPage>();

// A browser locks a profile to one process. A long-lived process (the MCP server) releases it
// after this much idle time (an agent's calls are seconds apart, so the browser would mostly
// relaunch anyway), and a second process waits up to LOCK_WAIT_MS for it.
const IDLE_CLOSE_MS = 3_000;
const LOCK_WAIT_MS = 15_000;
const LOCKED = /ProcessSingleton|profile (directory )?is already in use|SingletonLock/i;

/** Another process holds api-anything's browser profile. */
export class ProfileInUse extends Error {
  constructor(dir: string) {
    super(
      `the api-anything browser profile is in use by another process (an MCP server or another api-anything command): ${dir}`,
    );
    this.name = "ProfileInUse";
  }
}

/** A page that did not load (a timeout, a network error): nothing it would have sent was seen. */
export class PageUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageUnreachable";
  }
}

let users = 0;
let idleTimer: NodeJS.Timeout | undefined;
function scheduleIdleClose(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void (users === 0 && closeBrowser()), IDLE_CLOSE_MS);
  idleTimer.unref();
}
/** Mark the browser busy; the returned function releases it (and starts the idle clock). */
function hold(): () => void {
  users++;
  clearTimeout(idleTimer);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) scheduleIdleClose();
  };
}

async function launch(
  profileDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await chromium.launchPersistentContext(profileDir, options);
    } catch (e) {
      if (!LOCKED.test((e as Error).message)) throw e;
      if (Date.now() > until) throw new ProfileInUse(profileDir);
      await sleep(500);
    }
  }
}

/**
 * The Chromium browsers api-anything can drive, in default order (Google Chrome first, then the
 * other Chromium builds people actually run). The list's paths are the standard install
 * locations; a portable install — or any browser outside the list — is named by path through
 * `API_ANYTHING_BROWSER`.
 */
const BROWSERS: { name: string; aliases: string[]; candidates: string[] }[] = [
  {
    name: "Google Chrome",
    aliases: ["google chrome", "chrome"],
    candidates: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/google-chrome",
    ],
  },
  {
    name: "Brave",
    aliases: ["brave", "brave browser", "bravebrowser"],
    candidates: [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/opt/brave.com/brave/brave",
      "/usr/bin/brave-browser",
    ],
  },
  {
    name: "Microsoft Edge",
    aliases: ["microsoft edge", "edge", "msedge"],
    candidates: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/opt/microsoft/msedge/msedge",
      "/usr/bin/microsoft-edge",
    ],
  },
  {
    name: "Chromium",
    aliases: ["chromium"],
    candidates: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
  },
  {
    name: "Vivaldi",
    aliases: ["vivaldi"],
    candidates: ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi", "/usr/bin/vivaldi"],
  },
  {
    name: "Arc",
    aliases: ["arc"],
    candidates: ["/Applications/Arc.app/Contents/MacOS/Arc"],
  },
];

/** Windows install locations, by key: `<root>\<dir>\<bin>` under the per-user then per-machine roots. */
const WIN_PATHS: Record<string, { dir: string; bin: string }[]> = {
  "Google Chrome": [{ dir: "Google/Chrome/Application", bin: "chrome.exe" }],
  Brave: [{ dir: "BraveSoftware/Brave-Browser/Application", bin: "brave.exe" }],
  "Microsoft Edge": [{ dir: "Microsoft/Edge/Application", bin: "msedge.exe" }],
  Chromium: [{ dir: "Chromium/Application", bin: "chrome.exe" }],
  Vivaldi: [{ dir: "Vivaldi/Application", bin: "vivaldi.exe" }],
  Arc: [],
};

/** One browser's installed executable (first that exists), or undefined. */
function browserBin(e: (typeof BROWSERS)[number]): string | undefined {
  const candidates =
    process.platform === "win32"
      ? (WIN_PATHS[e.name] ?? []).flatMap(({ dir, bin }) =>
          [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]]
            .filter((d): d is string => !!d)
            .map((root) => join(root, dir, bin)),
        )
      : e.candidates;
  return candidates.find((p) => existsSync(p));
}

/**
 * Resolve the browser to launch. `API_ANYTHING_BROWSER` is the escape hatch that also covers
 * browsers outside the list: a name ("brave", "Chrome", "microsoft edge") picks one of the
 * named ones, and a path (e.g. a portable build) picks whatever it points at. Without the
 * variable, the first installed browser in the list's order. Returns undefined when nothing is
 * found, so callers skip cleanly (the plain-HTTP tier needs no browser).
 */
export function browserChoice(): { name: string; bin: string } | undefined {
  const env = process.env.API_ANYTHING_BROWSER?.trim();
  if (env) {
    if (env.includes("/") || env.includes("\\")) {
      return existsSync(env) ? { name: basename(env).replace(/\.(exe|app)$/i, ""), bin: env } : undefined;
    }
    const wanted = env
      .toLowerCase()
      .replace(/\.(exe|app)$/i, "")
      .replace(/[-_]/g, " ")
      .replace(/\s+/g, " ");
    const hit = BROWSERS.find((b) => b.aliases.includes(wanted));
    if (!hit) return undefined; // an unknown name: a path would work
    const bin = browserBin(hit);
    return bin ? { name: hit.name, bin } : undefined;
  }
  for (const b of BROWSERS) {
    const bin = browserBin(b);
    if (bin) return { name: b.name, bin };
  }
  return undefined;
}

/** Checked up front so callers can skip cleanly. */
export const browserAvailable = (): boolean => !!browserChoice();

// Default headless UA says "HeadlessChrome/<v>" and x.com answers 403. sec-ch-ua already
// carries the browser's name, so only the UA string needs the fix.
async function probeHeadlessUA(): Promise<string> {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ executablePath: browserChoice()?.bin, headless: true });
  try {
    const p = await b.newPage();
    return (await p.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
  } finally {
    await b.close();
  }
}

/**
 * The user agent a headless browser is given. Asking it means starting it once more (most of a
 * cold call's time), so the answer is kept under the home, by the binary's path, modification
 * time and size: an update changes those, and then, or when the file cannot be read, it is
 * asked again.
 */
export async function headlessUserAgent(): Promise<string> {
  // the name from before other browsers: renaming it would orphan every install's cache
  const file = join(home(), "chrome-ua.json");
  let key: string | undefined;
  try {
    const choice = browserChoice();
    if (choice) {
      const s = statSync(choice.bin);
      key = `${choice.bin}:${s.mtimeMs}:${s.size}`;
    }
    const kept = JSON.parse(readFileSync(file, "utf8")) as { key?: unknown; ua?: unknown };
    if (kept.key === key && typeof kept.ua === "string" && /Chrome\/\d/.test(kept.ua) && !/Headless/.test(kept.ua))
      return kept.ua;
  } catch {
    /* nothing kept, or nothing usable */
  }
  const ua = await probeHeadlessUA();
  try {
    if (key) writePrivate(file, JSON.stringify({ key, ua }));
  } catch {
    /* a home that cannot be written: asked again next time */
  }
  return ua;
}

/**
 * The process-wide persistent context. A different profileDir or headless mode closes the old one
 * first, since Chrome locks a profile to one running instance.
 */
export function openBrowser({
  profileDir,
  headless = true,
}: {
  profileDir: string;
  headless?: boolean;
}): Promise<BrowserContext> {
  if (users === 0) scheduleIdleClose();
  if (current && current.profileDir === profileDir && current.headless === headless) return current.ctx;
  const prev = current;
  const ctx = (async () => {
    if (prev) await closeContext(prev.ctx);
    if (headless) headlessUA ??= await headlessUserAgent();
    const c = await launch(profileDir, {
      executablePath: browserChoice()?.bin,
      headless,
      userAgent: headless ? headlessUA : undefined,
      viewport: headless ? undefined : null,
      // A service worker's fetches bypass routing (so write interception) and hide requests from capture.
      serviceWorkers: "block",
      // Playwright's own SIGTERM handler keeps the process alive; Chrome exits with its pipe anyway.
      handleSIGTERM: false,
    });
    c.on("close", () => {
      if (current?.ctx === ctx) current = undefined;
    });
    return c;
  })();
  current = { profileDir, headless, ctx };
  ctx.catch(() => {
    if (current?.ctx === ctx) current = undefined;
  });
  return ctx;
}

async function closeContext(ctx: Promise<BrowserContext>): Promise<void> {
  try {
    await (await ctx).close();
  } catch {
    // launch failed or already closed
  }
}

/**
 * Close the shared context. Call it before a normal exit: an open context keeps the event loop
 * alive. On signals and hard exits Playwright kills the Chrome it launched by itself.
 */
export async function closeBrowser(): Promise<void> {
  const c = current;
  current = undefined;
  originPages.clear();
  if (c) await closeContext(c.ctx);
}

/**
 * Close the browser now if no call is using it, and wait for it to exit. A host plans from the profile on
 * disk, which a running browser locks (so plans fail closed to signed in) and has not flushed.
 */
export async function closeIdleBrowser(): Promise<void> {
  if (users === 0 && current) {
    clearTimeout(idleTimer);
    await closeBrowser();
  }
}

const toStored = (c: Cookie): StoredCookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: c.expires,
  httpOnly: c.httpOnly,
  secure: c.secure,
  sameSite: c.sameSite,
});

function siteCookies(cookies: Cookie[], url: string): StoredCookie[] {
  const site = siteOf(new URL(url).hostname);
  return cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, "");
      return d === site || d.endsWith(`.${site}`);
    })
    .map(toStored);
}

/** The profile's current cookies for url's site: the cheap auth refresh, no page load. */
export async function profileCookies({
  url,
  profileDir,
}: {
  url: string;
  profileDir: string;
}): Promise<StoredCookie[]> {
  const release = hold();
  try {
    const ctx = await openBrowser({ profileDir });
    return siteCookies(await ctx.cookies(), url);
  } finally {
    release();
  }
}

/** Put imported cookies into api-anything's own Chrome profile, so tier 2/3 and heals are logged in too. */
export async function addCookiesToProfile(cookies: StoredCookie[], profileDir: string): Promise<void> {
  if (!cookies.length) return;
  const release = hold();
  try {
    const ctx = await openBrowser({ profileDir });
    // Playwright wants a domain that starts with a dot or an exact host; a leading-dot domain plus path is safe.
    await ctx.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires > 0 ? c.expires : undefined,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })),
    );
  } finally {
    release();
  }
}

/** Clear one site's cookies from the profile: any host under the registrable domain. */
export async function clearProfileCookies(site: string, profileDir: string): Promise<void> {
  const release = hold();
  try {
    const ctx = await openBrowser({ profileDir });
    const esc = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await ctx.clearCookies({ domain: new RegExp(`(^|\\.)${esc}$`) });
  } finally {
    release();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// Binary resources: their bodies are never useful to the learner and are not valid UTF-8. A stream's never ends.
const NO_BODY = new Set(["image", "media", "font", "stylesheet", "eventsource", "websocket"]);
const QUIET_MS = 500;
// Streams never finish; a request open this long is a long poll or a hung tracker, not the data.
const LONG_LIVED = new Set(["eventsource", "websocket"]);
const LONG_MS = 3000;
// An endpoint hit more often than this is polling or a beacon: its repeats are not "still loading".
const REPEATS = 2;
// Pages that fetch their data a moment after load (deferred hydration): how long to wait for a first XHR.
const FIRST_XHR_MS = 2000;
// With an op's match: how long a quiet page may go without firing it before the run gives up on it.
const MATCH_GRACE_MS = 3000;
// How long a bot challenge's interstitial may take to solve itself and load the real page.
const CHALLENGE_WAIT_MS = 15_000;

type SocketGuard = (e: Exchange) => boolean;
const socketGuards = new WeakMap<BrowserContext, { guards: Set<SocketGuard>; ready: Promise<void> }>();

/**
 * Drop WebSocket messages a page sends while `guard` says so, in every page of the context (a
 * popup's socket opens before a per-page route could be set). One context-wide route, installed
 * once; returns the function that removes this guard.
 * ponytail: a socket can't be traced to its page, so a concurrent run's sends are guarded too
 * while a write is being learned; that errs on the side of not sending.
 */
async function guardSockets(ctx: BrowserContext, guard: SocketGuard): Promise<() => void> {
  let g = socketGuards.get(ctx);
  if (!g) {
    const guards = new Set<SocketGuard>();
    const ready = ctx.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => {
        const ex: Exchange = {
          id: 0,
          resourceType: "websocket",
          request: { method: "SEND", url: ws.url(), headers: {} },
        };
        if (![...guards].some((drop) => drop(ex))) server.send(m);
      });
    });
    g = { guards, ready };
    socketGuards.set(ctx, g);
  }
  g.guards.add(guard);
  await g.ready;
  return () => g.guards.delete(guard);
}

// How long a page gets to be emptied, and then to close, before the run ends without waiting for it.
const SEAL_MS = 5000;
/** A call into a page, given up on after a while: a hung renderer answers nothing, and evaluate() and close() have no timeout. */
const within = <T>(p: Promise<T>, otherwise: T, ms = SEAL_MS): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => {
    timer = setTimeout(() => r(otherwise), ms);
  });
  // cleared when the call settles first: a timer left running keeps the process alive for its 5 s
  return Promise.race([p.catch(() => otherwise), late]).finally(() => clearTimeout(timer));
};

/**
 * Who opened each tab of a browser, kept on a DevTools session of the browser itself. That session
 * outlives every page, so a tab can be asked about, and closed, after the tab that opened it is
 * gone; and the record is kept as tabs appear, since the browser forgets who opened a tab once the
 * opener is closed (as does Playwright's opener()). It holds open tabs only: when one closes, the
 * tabs it opened pass to the tab that opened it, so ancestry survives without the dead.
 */
interface Tabs {
  /** each open tab that another tab opened, with that tab (or, once it closed, the one that opened it) */
  openerOf: Map<string, string>;
  /** called whenever a tab closes */
  watchers: Set<() => void>;
  /** resolves with every tab the browser has now in the record */
  sync(): Promise<void>;
  /** close a tab, whether or not Playwright has a page for it */
  close(targetId: string): Promise<unknown>;
}
const tabRecords = new WeakMap<BrowserContext, Promise<Tabs>>();
export function tabsOf(ctx: BrowserContext): Promise<Tabs> {
  let record = tabRecords.get(ctx);
  if (!record) {
    record = (async () => {
      const browser = ctx.browser();
      if (!browser) throw new Error("this browser gives no session to watch its tabs through");
      const cdp = await browser.newBrowserCDPSession();
      const tabs: Tabs = {
        openerOf: new Map(),
        watchers: new Set(),
        sync: async () => (await cdp.send("Target.getTargets")).targetInfos.forEach(note),
        close: (targetId) => cdp.send("Target.closeTarget", { targetId }),
      };
      const note = (t: { targetId: string; openerId?: string }) =>
        void (t.openerId && tabs.openerOf.set(t.targetId, t.openerId));
      cdp.on("Target.targetCreated", (e) => note(e.targetInfo));
      cdp.on("Target.targetDestroyed", ({ targetId }) => {
        const opener = tabs.openerOf.get(targetId);
        tabs.openerOf.delete(targetId);
        if (opener) for (const [id, by] of tabs.openerOf) if (by === targetId) tabs.openerOf.set(id, opener);
        for (const changed of [...tabs.watchers]) changed();
      });
      await cdp.send("Target.setDiscoverTargets", { discover: true });
      return tabs;
    })();
    tabRecords.set(ctx, record);
    record.catch(() => tabRecords.delete(ctx));
  }
  return record;
}

/**
 * One page's requests as Chrome pauses them, below Playwright's routes, on a DevTools session of
 * our own. A route is not asked about every request. Playwright continues by itself, calling no
 * handler: every hop of a redirect (so an asset the guard allowed can be sent on to a write), and
 * any paused request that has no network id, which is what a document sends as it unloads (a
 * pagehide beacon, a keepalive fetch, an image ping) and a deferred fetchLater(). `drop` is asked
 * about each request, and told whether a route will see it too; a hop keeps the resource type of
 * the request that was redirected, and `drop` is given the request that started its chain (`via`).
 * ponytail: a frame on another site is a target of its own. Its redirect hops would need a tap on
 * the frame; what it sends as it unloads is seen by no session, its own included (tried: the
 * target is gone before the document unloads), only by interception on the browser target, for
 * every run at once.
 */
interface Tap {
  /** the page's DevTools target */
  id: string;
  /** resolves once every request paused so far has its answer */
  answered(): Promise<void>;
}
async function tap(
  ctx: BrowserContext,
  page: Page,
  drop: (e: Exchange, routed: boolean, via?: Exchange) => boolean,
): Promise<Tap> {
  const cdp = await ctx.newCDPSession(page);
  const answers = new Set<Promise<unknown>>();
  /** the request each chain of redirects started from, by network id */
  const chains = new Map<string, Exchange>();
  cdp.on("Fetch.requestPaused", (e) => {
    const ex: Exchange = {
      id: 0,
      resourceType: e.resourceType.toLowerCase(),
      request: {
        method: e.request.method,
        url: e.request.url + (e.request.urlFragment ?? ""),
        headers: Object.fromEntries(Object.entries(e.request.headers).map(([k, v]) => [k.toLowerCase(), v])),
        body: e.request.postData,
      },
    };
    const { requestId } = e;
    // A hop goes on under its request's network id. Chrome marks it with redirectedRequestId, but
    // not a cross-origin fetch's: the id seen before is what tells it.
    const via = e.networkId ? chains.get(e.networkId) : undefined;
    if (e.networkId && !via) chains.set(e.networkId, ex);
    const answer = (
      drop(ex, !!e.networkId && !via && !e.redirectedRequestId, via)
        ? cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" })
        : cdp.send("Fetch.continueRequest", { requestId })
    ).catch(() => {}); // the request or its page is gone
    answers.add(answer);
    void answer.then(() => answers.delete(answer));
  });
  const enable = () => cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await enable();
  return {
    id: (await cdp.send("Target.getTargetInfo")).targetInfo.targetId,
    async answered() {
      // a round trip through the browser: every request it paused before this has been reported
      await enable().catch(() => {});
      await Promise.all(answers);
    },
  };
}

export interface TriggerOptions {
  url: string;
  steps?: TriggerStep[];
  /** open this page first, then reach `url` by an in-app navigation so SPAs fire their XHRs */
  softFrom?: string;
  headless?: boolean;
  profileDir: string;
  /**
   * requests it matches are aborted before leaving the browser (in any tab the run opens) and
   * recorded with aborted:true; `acting` is true once the page has loaded and the steps run, and
   * false again while the page is a bot challenge's interstitial (its own verify POSTs must go
   * through, or it never reloads). A WebSocket message the page sends is asked as resourceType
   * "websocket", method "SEND". For a hop of a redirect, `via` is the request its chain started from.
   */
  intercept?: (e: Exchange, acting: boolean, via?: Exchange) => boolean;
  /**
   * the op's own request: the run waits for one to answer (up to the budget), then ends after a
   * short settle instead of waiting for the whole page to go quiet
   */
  match?: (e: Exchange) => boolean;
  /**
   * whether to accept a confirm() a page of the run shows once its steps run (`step`: the step
   * running, -1 before the first). Without it, and before the steps or after the run, a confirm is
   * dismissed. Alerts and prompts are always dismissed, and leaving a page (beforeunload) accepted.
   */
  confirm?: (a: { message: string; origin: string; step: number }) => boolean;
  /** extra wait after the network first goes quiet (default 300) */
  settleMs?: number;
  /** overall budget; also the per-action Playwright timeout (default 30000) */
  timeoutMs?: number;
}

/** A page load that treats "this URL is a download" as loaded (the request is still captured). */
async function goto(page: Page, url: string, referer?: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", ...(referer ? { referer } : {}) });
  } catch (e) {
    if (!/Download is starting|net::ERR_ABORTED/.test((e as Error).message))
      throw new PageUnreachable((e as Error).message);
  }
}

async function runStep(page: Page, s: TriggerStep): Promise<void> {
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`trigger step "${s.action}" needs ${what}`);
    return v;
  };
  switch (s.action) {
    case "click":
      return page.click(need(s.selector, "a selector"));
    case "fill": {
      const selector = need(s.selector, "a selector");
      // asked of the page, not the selector: a password typed here would be saved in the spec
      const field = await page.waitForSelector(selector, { state: "attached" });
      const secret = await field
        .evaluate((el, names) => {
          const f = el instanceof HTMLLabelElement && el.control ? el.control : el;
          const auto = (f.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/);
          return f.getAttribute("type")?.toLowerCase() === "password" || auto.some((t) => names.includes(t));
        }, SIGN_IN_AUTOCOMPLETE)
        .finally(() => field.dispose());
      if (secret)
        throw new Error(`trigger step fills a password or one-time-code field (${selector}): ${SIGN_IN_REFUSAL}`);
      // by selector, as before: an app that re-renders the input between the two finds the new one
      return page.fill(selector, s.value ?? "");
    }
    case "press":
      return s.selector ? page.press(s.selector, need(s.value, "a key")) : page.keyboard.press(need(s.value, "a key"));
    case "wait":
      if (s.selector) await page.waitForSelector(s.selector);
      else await page.waitForTimeout(s.ms ?? 1000);
      return;
    case "goto":
      return goto(page, need(s.value ?? s.selector, "a url in value"));
  }
}

/**
 * Answer a native dialog. A page waits on one, and Playwright leaves it to the listener once there
 * is one: every dialog gets an answer, or the page hangs.
 */
const answer = (d: Dialog, accept: boolean) => void (accept ? d.accept() : d.dismiss()).catch(() => {});

/** The request body as the server gets it: a gzip/deflate/br-encoded body (YouTube's innertube) decoded. */
function requestBody(req: Request): string | undefined {
  const enc = (req.headers()["content-encoding"] ?? "").toLowerCase();
  const buf = enc ? req.postDataBuffer() : null;
  if (buf) {
    try {
      return (
        enc.includes("gzip") ? gunzipSync(buf) : enc.includes("br") ? brotliDecompressSync(buf) : inflateSync(buf)
      ).toString("utf8");
    } catch {
      /* not really encoded: fall through */
    }
  }
  return req.postData() ?? undefined;
}

/** Load the trigger in the browser and return every exchange it caused, with bodies and cookies. */
export async function runTrigger(o: TriggerOptions): Promise<CaptureResult> {
  const timeout = o.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeout;
  const release = hold();
  let ctx: BrowserContext;
  let page: Page;
  let tabs: Tabs | undefined;
  try {
    ctx = await openBrowser(o);
    // a guarded run does not start without the browser's record of who opens which tab
    if (o.intercept) tabs = await tabsOf(ctx);
    page = await ctx.newPage();
  } catch (e) {
    release();
    throw e;
  }
  page.setDefaultTimeout(timeout);

  const exchanges: Exchange[] = [];
  let acting = false;
  const intercept = o.intercept;
  // Set when the run ends: from then on nothing its pages send may leave.
  let sealed = false;
  /** each guarded page's tap, once attached (undefined when that failed) */
  const taps = new Map<Page, Promise<Tap | undefined>>();
  /** the DevTools targets of the pages the run holds, closed ones included */
  const held = new Set<string>();
  const cover = (p: Page) => {
    if (!intercept || taps.has(p)) return;
    const drop = (ex: Exchange, routed: boolean, via?: Exchange) => {
      // What a route will see is the route's to judge, until the run ends: then this is the last word.
      if (routed && !sealed) return false;
      // Once sealed everything is stopped, but only what the guard itself stops joins the capture:
      // a write a page sends as it leaves can be learned, the rest of a closing page's traffic is noise.
      if (!intercept(ex, acting, via)) return sealed;
      exchanges.push({ ...ex, id: exchanges.length + 1, aborted: true });
      return true;
    };
    const attached = tap(ctx, p, drop).then(
      (t) => {
        held.add(t.id);
        return t;
      },
      () => undefined,
    );
    taps.set(p, attached);
  };
  /**
   * The open tabs that pages of the run opened (and the tabs those opened, through closed ones too)
   * which the run does not hold: Playwright has not reported them yet, or reported them when their
   * opener was already closed.
   */
  const strays = () => {
    if (!tabs) return [];
    const kin = new Set(held);
    for (let n = -1; n !== kin.size; ) {
      n = kin.size;
      for (const [id, opener] of tabs.openerOf) if (kin.has(opener)) kin.add(id);
    }
    return [...kin].filter((id) => !held.has(id));
  };
  /**
   * Whether a tab that has no page yet can be this run's, with the record brought up to date first
   * (so that a tab the browser has only just opened is in it). When the browser cannot be asked, or
   * does not answer in time, it can: the request is waiting on this, and so is its tab.
   */
  const mayOwnNewTab = async () => {
    const asked = tabs?.sync().then(() => true);
    return !asked || !(await within(asked, false)) || strays().length > 0;
  };

  /** the native dialogs the run's pages showed */
  const dialogs: SeenDialog[] = [];
  /** the trigger step running: -1 before the first */
  let step = -1;
  /** set as the run ends: no confirm is accepted from then on */
  let over = false;
  const onDialog = (d: Dialog) => {
    const type = d.type() as SeenDialog["type"];
    const message = d.message();
    let origin = "null";
    try {
      origin = new URL(d.page()?.url() ?? "").origin;
    } catch {
      /* no page left */
    }
    const accepted =
      type === "beforeunload" || (type === "confirm" && acting && !over && !!o.confirm?.({ message, origin, step }));
    dialogs.push({ type, message, origin, step, accepted });
    answer(d, accepted);
  };
  page.on("dialog", onDialog);

  // This run's pages: its own and any popup they open. The context is shared with concurrent runs.
  const own = new Set<Page>([page]);
  const ownerOf = (req: Request): Page | undefined => {
    try {
      return req.frame().page();
    } catch {
      return undefined; // a service worker's request, or a new tab's first navigation (its page comes later)
    }
  };
  /** pages found to be no stray of the run: not asked about again (who opened a tab does not change) */
  const foreign = new WeakSet<Page>();
  /** Whether a page is one of the run's strays, by its target: Playwright's opener() is null once the opener closed. */
  const stray = async (p: Page) => {
    if (!strays().length || foreign.has(p)) return false;
    const cdp = await ctx.newCDPSession(p).catch(() => undefined);
    const id = (await cdp?.send("Target.getTargetInfo").catch(() => undefined))?.targetInfo.targetId;
    void cdp?.detach().catch(() => {});
    if (!id) return false; // already closing: nothing left of it to guard
    const yes = strays().includes(id);
    if (!yes) foreign.add(p);
    return yes;
  };
  const adopt = async (p: Page | undefined) => {
    if (!p || own.has(p)) return !!p;
    const opener = await p.opener().catch(() => null);
    if ((opener && own.has(opener)) || (await stray(p))) {
      own.add(p);
      cover(p);
      p.on("dialog", onDialog);
    }
    return own.has(p);
  };
  const mine = (req: Request) => {
    const p = ownerOf(req);
    return !!p && own.has(p);
  };

  /** top-level documents of the run's first page, in order */
  const docs: Exchange[] = [];
  /** response bodies being read, so a guard can wait for the latest document's */
  const bodies = new Map<Exchange, Promise<unknown>>();
  /** every URL the first page's main frame had, history API changes included (an SPA's pushState) */
  const locations = new Set<string>();
  const onNavigated = (f: Frame) => void (f === page.mainFrame() && locations.add(f.url()));
  page.on("framenavigated", onNavigated);
  const byReq = new Map<Request, Exchange>();
  const reads: Promise<unknown>[] = [];
  const pending = new Map<Request, number>();
  // Resolves when the first page starts its next document: the old one's requests never finish then.
  let navigated = () => {};
  let nextDoc = new Promise<void>((r) => (navigated = r));
  const hits = new Map<string, number>();
  let lastActivity = Date.now();

  const describe = (req: Request): Exchange => ({
    id: 0,
    resourceType: req.resourceType(),
    request: { method: req.method(), url: req.url(), headers: req.headers(), body: requestBody(req) },
  });
  const record = (req: Request): Exchange => {
    let ex = byReq.get(req);
    if (!ex) {
      ex = { ...describe(req), id: exchanges.length + 1 };
      exchanges.push(ex);
      byReq.set(req, ex);
    }
    return ex;
  };
  // Never let one stuck body read (streams, long-poll) hold the whole capture.
  const bounded = (p: Promise<unknown>) =>
    reads.push(Promise.race([p, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())).unref())]));
  /** A new tab's aborted first navigation joins the capture once its page shows the tab was this run's. */
  const claim = async (req: Request) => {
    for (const end = Date.now() + 2000; !ownerOf(req) && Date.now() < end; ) await sleep(50);
    if (await adopt(ownerOf(req))) record(req).aborted = true;
  };

  const onRequest = (req: Request) => {
    if (!mine(req)) return;
    const ex = record(req);
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
      docs.push(ex);
      // A challenge's verify POST, cut off by the reload it triggered, would hold "quiet" and the body reads.
      for (const r of pending.keys()) if (r !== req) pending.delete(r);
      navigated();
      nextDoc = new Promise<void>((r) => (navigated = r));
    }
    // allHeaders() is what went on the wire: cookie, sec-fetch-*, origin, referer.
    bounded(
      req.allHeaders().then(
        (h) => (ex.request.headers = h),
        () => {},
      ),
    );
    let endpoint = req.url();
    try {
      const u = new URL(endpoint);
      endpoint = `${req.method()} ${u.origin}${u.pathname}`;
    } catch {
      /* keep the raw url */
    }
    const n = (hits.get(endpoint) ?? 0) + 1;
    hits.set(endpoint, n);
    if (LONG_LIVED.has(req.resourceType()) || n > REPEATS) return;
    pending.set(req, Date.now());
    lastActivity = Date.now();
  };
  const onDone = (req: Request) => {
    if (pending.delete(req)) lastActivity = Date.now();
  };
  // Bodies must be read here: after the next navigation the browser discards them.
  const onResponse = (res: Response) => {
    if (!mine(res.request())) return;
    const ex = record(res.request());
    const read = (async () => {
      const headers = await res.allHeaders().catch(() => res.headers());
      const body = NO_BODY.has(ex.resourceType) ? undefined : await res.text().catch(() => undefined);
      ex.response = { status: res.status(), headers, body, contentType: headers["content-type"] ?? "" };
    })();
    bodies.set(ex, read);
    // a body its document outlives by 2 s is not coming (Playwright never settles it)
    const gone = nextDoc.then(() => sleep(2000));
    bounded(Promise.race([read, gone]));
  };
  /** adoptions under way: a tab that has just been reported is not in `own` yet */
  const adopting = new Set<Promise<unknown>>();
  const onPage = (p: Page) => {
    const a = adopt(p).catch(() => {});
    adopting.add(a);
    void a.then(() => adopting.delete(a));
  };
  ctx.on("page", onPage);
  ctx.on("request", onRequest);
  ctx.on("requestfinished", onDone);
  ctx.on("requestfailed", onDone);
  ctx.on("response", onResponse);

  // The latest top-level document of this run's first page, when it is a bot challenge's interstitial.
  const walled = () => {
    const d = docs.at(-1);
    return (
      !!d?.response &&
      !!botWall({ status: d.response.status, headers: d.response.headers, body: d.response.body ?? "" })
    );
  };
  /** walled(), once the latest document's body is in (bounded: a stuck read is not a wall) */
  const walledNow = async () => {
    const d = docs.at(-1);
    if (d && !d.response) await Promise.race([bodies.get(d), sleep(3000)]);
    return walled();
  };
  // A JS challenge solves itself by POSTing a proof (AWS WAF's mp_verify, Cloudflare's
  // challenge-platform), then reloads: while it is on screen, the steps are not acting yet.
  const actingNow = async () => acting && !(await walledNow());
  /** requests the guard has been asked about and not answered yet */
  let deciding = 0;
  // Context-wide, so a popup the run opens is covered too; other runs' requests pass through.
  const guard = intercept
    ? async (route: Route) => {
        deciding++;
        try {
          const req = route.request();
          const owner = ownerOf(req);
          // A new tab's first navigation is routed before its page exists, and Playwright reports
          // the page only once that navigation commits: waiting for the owner would wait forever.
          // The browser says who opened each tab, though not which tab a request is from: the
          // request is judged as this run's own unless the run has no stray tab. Two runs opening
          // a tab at the same moment cannot be told apart, and then stopping the other run's tab
          // is the lesser harm.
          const orphan = !owner && !req.serviceWorker();
          if (orphan ? !(await mayOwnNewTab()) : !(await adopt(owner))) return await route.fallback();
          const ex = orphan ? describe(req) : record(req);
          if (!intercept(ex, await actingNow())) return await route.fallback();
          ex.aborted = true;
          if (orphan) bounded(claim(req));
          return await route.abort();
        } finally {
          deciding--;
        }
      }
    : undefined;

  const quiet = () =>
    ![...pending.values()].some((t) => Date.now() - t < LONG_MS) && Date.now() - lastActivity >= QUIET_MS;
  const idle = async (capMs = timeout) => {
    const end = Math.min(deadline, Date.now() + capMs);
    while (Date.now() < end && !quiet()) await sleep(50);
  };
  const answered = () => exchanges.some((e) => o.match!(e) && (e.response || e.aborted));
  let dropSocketSends: (() => void) | undefined;
  const waitForData = async () => {
    if (o.match) {
      // The op's own request answering is the signal; then a short settle.
      // A page quiet for a few seconds without it is not going to send it (a login wall, a 404 page).
      while (Date.now() < deadline && !answered() && !(quiet() && Date.now() - lastActivity > MATCH_GRACE_MS))
        await sleep(50);
      await sleep(o.settleMs ?? 300);
      await idle(3000);
      return;
    }
    await idle();
    await sleep(o.settleMs ?? 300);
    await idle();
    if (!exchanges.some((e) => e.resourceType === "xhr" || e.resourceType === "fetch")) {
      const end = Math.min(deadline, Date.now() + FIRST_XHR_MS);
      while (Date.now() < end && !exchanges.some((e) => e.resourceType === "xhr" || e.resourceType === "fetch"))
        await sleep(50);
      await idle();
    }
  };
  /** Wait (bounded) for a challenge interstitial to solve itself; true when a real document replaced it. */
  const outwait = async () => {
    if (!(await walledNow())) return false;
    const end = Math.min(deadline, Date.now() + CHALLENGE_WAIT_MS);
    const seen = docs.length;
    while (Date.now() < end && (docs.length === seen || !docs.at(-1)!.response || walled())) await sleep(100);
    return docs.length > seen && !walled();
  };

  /** Nothing of the run is left open: neither a page it holds nor a stray tab. */
  const gone = () => [...own].every((p) => p.isClosed()) && !strays().length;
  /**
   * The end of a run, as one sequence; true when every page of the run is known to be closed.
   * A guarded run's pages are emptied before they are closed, with their sessions and the guards
   * still live. A page that is being closed still sends (its pagehide handlers fire a beacon, a
   * client re-sends what the guard just failed), and by then nothing stops it: Playwright calls no
   * route handler for a page once close() was called, and Chrome sends a request that is paused in
   * a session on to the network when the session detaches. So each page goes to about:blank under
   * the seal first: its document unloads here, what it sends last fails, and the page that is
   * closed afterwards has nothing left to send. A tab of the run that has no page (Playwright has
   * not reported it, or its opener was closed by the time it did) is closed through the browser.
   * Pages keep being adopted meanwhile, and this goes round until there is nothing new; no round
   * starts after 15 s, but one under way runs its waits out. Each wait has its own 5 s: for the adoptions and taps under way, for
   * a page to be emptied and for its tap's answers, for the browser's list of tabs, for a stray
   * to close; and after the rounds, for each page's close(). The wait for the guard's requests
   * in flight ends with the rounds. A page that will not be emptied or closed does not hold the
   * run: the caller then leaves the guards in place.
   */
  const closePages = async (): Promise<boolean> => {
    if (guard) {
      sealed = true;
      const tapOf = (p: Page) => within(Promise.resolve(taps.get(p)), undefined);
      const emptied = new Set<Page>();
      for (const end = Date.now() + 3 * SEAL_MS; Date.now() < end; ) {
        await within(Promise.all([...adopting, ...taps.values()]), []);
        const fresh = [...own].filter((p) => !emptied.has(p) && !p.isClosed());
        for (const p of fresh) {
          emptied.add(p);
          // A round trip through the new document, then (in `answered`) through the browser:
          // whatever the old one sent as it unloaded has been paused and failed before either returns.
          const blank = p.goto("about:blank", { timeout: SEAL_MS }).then(() => true);
          if (await within(blank, false))
            await within(
              p.evaluate(() => 0),
              0,
            );
          await within(Promise.resolve((await tapOf(p))?.answered()), undefined);
        }
        while (deciding > 0 && Date.now() < end) await sleep(20);
        // Through the browser's own session: a stray has no page to close it by, and the page
        // that opened it may be gone.
        await within(Promise.resolve(tabs?.sync()), undefined);
        const lost = strays();
        for (const id of lost) await within(Promise.resolve(tabs?.close(id)), undefined);
        if (!fresh.length && !lost.length) break;
        if (lost.length) await sleep(20); // until the browser reports them gone
      }
    }
    await Promise.all([...own].map((p) => within(p.close(), undefined)));
    return gone();
  };

  try {
    if (guard) await ctx.route("**/*", guard);
    // A chat "send" goes over an open socket, where no HTTP route sees it; a popup's socket too.
    if (intercept) dropSocketSends = await guardSockets(ctx, (ex) => intercept(ex, acting));
    // in place before the first document, so that what it defers (fetchLater) passes through it
    cover(page);
    if (intercept && !(await within(Promise.resolve(taps.get(page)), undefined)))
      throw new Error("could not attach the request guard to the page");
    if (o.softFrom) {
      await goto(page, o.softFrom);
      await idle(5000);
      const from = page.url();
      const before = exchanges.length;
      // A link the app rendered goes through its router; otherwise the history API plus popstate,
      // which client routers (React Router, TanStack, Next) listen to. An injected <a> would not be routed.
      const routing = page.evaluate((u) => {
        const link = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find(
          (a) => a.href === u && (!a.target || a.target === "_self"),
        );
        if (link) return link.click();
        try {
          history.pushState({}, "", u);
          dispatchEvent(new PopStateEvent("popstate", { state: {} }));
        } catch {
          /* cross-origin: fall through to a plain load */
        }
      }, o.url);
      await within(routing, undefined);
      await idle(5000);
      // ponytail: "fired anything" is the routed signal; a page whose analytics fire on pushState fools it.
      const routed = exchanges.slice(before).some((e) => ["xhr", "fetch", "document"].includes(e.resourceType));
      if (!routed) await goto(page, o.url, from);
    } else {
      await goto(page, o.url);
    }
    acting = true;
    // steps typed into a challenge interstitial would time out on selectors the real page has
    if (o.steps?.length) await outwait();
    for (const [i, s] of (o.steps ?? []).entries()) {
      step = i;
      await runStep(page, s);
    }
    await waitForData();
    // A JS challenge (AWS WAF, Cloudflare) solves itself and reloads, often after a second or more:
    // judging now would take the interstitial for the page. Wait (bounded) for a real document.
    if (await outwait()) await waitForData();
    const wait: NonNullable<CaptureResult["wait"]> = {
      ended: o.match && answered() ? "answered" : Date.now() >= deadline ? "deadline" : "quiet",
      open: pending.size,
      ...(docs.at(-1)?.response ? { status: docs.at(-1)!.response!.status } : {}),
    };
    // Bodies still arriving get a short grace, not the whole budget: a hung long poll is not the data.
    const grace = new Promise((r) => setTimeout(r, Math.min(5000, Math.max(0, deadline - Date.now()))).unref());
    const settled = (async () => {
      for (let n = -1; n !== reads.length; ) {
        n = reads.length;
        await Promise.allSettled(reads);
      }
    })();
    await Promise.race([settled, grace]);
    // Tokens an SPA keeps in web storage (not the jar); learning turns a request repeating one into a session: ref.
    const storage = await within(
      page.evaluate(() =>
        Object.fromEntries(
          [localStorage, sessionStorage]
            .flatMap((s) => Object.keys(s).map((k) => [k, s.getItem(k) ?? ""]))
            .filter(([, v]) => v.length <= 16_384),
        ),
      ),
      {},
    );
    return {
      exchanges,
      cookies: siteCookies(await ctx.cookies(), o.url),
      finalUrl: page.url(),
      storage,
      locations: [...locations],
      // a copy: what a page shows while the run closes it is not the run's
      ...(dialogs.length ? { dialogs: [...dialogs] } : {}),
      wait,
    };
  } finally {
    over = true;
    page.off("framenavigated", onNavigated);
    ctx.off("request", onRequest);
    ctx.off("requestfinished", onDone);
    ctx.off("requestfailed", onDone);
    ctx.off("response", onResponse);
    const lift = async () => {
      ctx.off("page", onPage);
      if (guard) await ctx.unroute("**/*", guard).catch(() => {});
      dropSocketSends?.();
    };
    // New tabs are still adopted while the run ends: one opened now is the run's to close as well.
    // The pages are closed before the guards are lifted: an open page still sends (a client's
    // retry; Chrome reloads an aborted navigation's error page after a second), and unrouting
    // releases what is paused.
    if (await closePages()) await lift();
    else {
      // Not known to be closed (a hung renderer, a close that failed): the guards stay until the
      // run's pages and its stray tabs are all gone, whichever goes last. That includes the socket
      // guard, though it drops every run's sends: a page that is still open can still write, and
      // time passing is no sign that it cannot. The browser is released regardless.
      const retire = () => {
        if (!gone()) return;
        tabs?.watchers.delete(retire);
        void lift();
      };
      tabs?.watchers.add(retire);
      for (const p of own) p.once("close", retire);
    }
    release();
  }
}

const ENDED = { answered: "the op's request answered", quiet: "the page went quiet", deadline: "the time ran out" };
/** "at steps[1]", or before the first step */
export const atStep = (step: number) => (step < 0 ? "before the steps" : `at steps[${step}]`);

/**
 * Why a run stopped waiting, in a line for a failure's reason: how the wait ended, where the page
 * was (origin and path: a query can carry a token) and its document's status, the requests still
 * open, and the dialogs it showed with their answers. Never page text or a cookie or header value.
 */
export function waitReport(c: CaptureResult): string {
  let where = c.finalUrl;
  try {
    const u = new URL(c.finalUrl);
    where = u.origin === "null" ? u.protocol + u.pathname : u.origin + u.pathname;
  } catch {
    /* kept as it is */
  }
  if (where.length > 120) where = `${where.slice(0, 120)}...`;
  const w = c.wait;
  const parts = [
    `${w ? `${ENDED[w.ended]} ` : ""}on ${where}${w?.status !== undefined ? ` (HTTP ${w.status})` : ""}`,
    ...(w ? [`${w.open} request${w.open === 1 ? "" : "s"} still open`] : []),
  ];
  const seen = c.dialogs ?? [];
  if (seen.length) {
    const said = seen.slice(0, 3).map((d) => `${d.type} ${d.accepted ? "accepted" : "dismissed"} ${atStep(d.step)}`);
    parts.push(`dialogs: ${said.join(", ")}${seen.length > 3 ? ` and ${seen.length - 3} more` : ""}`);
  }
  return parts.join("; ");
}

export interface PageFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
  ms: number;
  /** the first answer was a redirect */
  redirected?: boolean;
}

/**
 * The redirect a page's manual fetch() got, read from what Playwright saw of it: the page itself is
 * told nothing, not even the status. The page (or another call) may have sent the same request at
 * the same moment; when their redirects differ, which one is this call's cannot be told.
 */
async function redirectOf(seen: Response[], hop: Hop, url: string) {
  const bare = (u: string) => u.split("#")[0];
  const mine = () =>
    seen.filter((res) => {
      const req = res.request();
      return req.method() === hop.method && bare(req.url()) === bare(url) && (req.postData() ?? hop.body) === hop.body;
    });
  for (const end = Date.now() + 1000; !mine().length && Date.now() < end; ) await sleep(20);
  const answers = await Promise.all(
    mine().map(async (res) => ({ status: res.status(), headers: await res.allHeaders().catch(() => res.headers()) })),
  );
  if (new Set(answers.map((a) => `${a.status} ${a.headers.location ?? ""}`)).size !== 1) {
    const why = answers.length
      ? "the page sent the same request at the same time and their redirects differ, so this one's cannot be told apart"
      : "its answer was not seen, so where it leads is unknown";
    // the origin only: the address is the filled request's, and can hold a session's value
    throw new Error(`not following a redirect from ${new URL(url).origin}: ${why}`);
  }
  return { ...answers[0]!, body: "", url, location: answers[0]!.headers.location };
}

/** One tier-2 fetch's hold on the requests of the page it runs in. */
interface Watch {
  /** may this request be the fetch's own? Same method and origin: the page's own can look alike, which only errs toward "sent" */
  mine(method: string, url: string): boolean;
  /** one of them reached the browser and was let go */
  started: boolean;
  /** given up on before any was let go: each later one is failed in the browser, so none leaves */
  sealed: boolean;
}

/** A cached tier-2 page and the fetches watching its requests. */
interface OriginPage {
  origin: string;
  page: Page;
  watches: Set<Watch>;
  retired?: boolean;
}

/** A tier-2 fetch none of whose requests left the page, and none of which ever will. */
class NotStarted extends Error {}

/** Hand out a page no more, and close it once no fetch that may still be answered is using it. */
function retire(e: OriginPage): void {
  e.retired = true;
  if (originPages.get(e.origin) === e) originPages.delete(e.origin);
  if ([...e.watches].every((w) => w.sealed)) void within(e.page.close(), undefined);
}

/** A page on `origin` to fetch from: its root, or a blank stand-in when the root redirects elsewhere (api.* to www). */
async function originPage(ctx: BrowserContext, origin: string, left: () => number): Promise<OriginPage> {
  const kept = originPages.get(origin);
  if (kept && !kept.page.isClosed()) {
    if (new URL(kept.page.url()).origin === origin) return kept;
    originPages.delete(origin);
    await within(kept.page.close(), undefined, Math.min(SEAL_MS, left()));
    if (left() <= 1) throw new Error("the origin page could not be replaced before the call's deadline");
  }
  const page = await ctx.newPage();
  // the same answers as a trigger run's, with no confirm accepted: this page only fetches
  page.on("dialog", (d) => answer(d, d.type() === "beforeunload"));
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: left() }).catch(() => {});
  let here = "";
  try {
    here = new URL(page.url()).origin;
  } catch {
    /* about:blank */
  }
  if (here !== origin) {
    // Same-origin is what matters for fetch(): serve a blank document at an unused path, never sent to the site.
    const blank = `${origin}/__api_anything_blank__`;
    await page.route(blank, (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title></title>" }),
    );
    await page.goto(blank, { waitUntil: "domcontentloaded", timeout: left() });
  }
  // Every request the page sends waits in the browser until it is let go here. So a fetch none of
  // whose requests was let go provably sent nothing, and one given up on can be kept from leaving
  // later, when a stalled page wakes up.
  const entry: OriginPage = { origin, page, watches: new Set() };
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Fetch.requestPaused", ({ requestId, request }) => {
    let drop = false;
    for (const w of entry.watches)
      if (w.mine(request.method, request.url)) {
        if (w.sealed) drop = true;
        else w.started = true;
      }
    void (
      drop
        ? cdp.send("Fetch.failRequest", { requestId, errorReason: "Aborted" })
        : cdp.send("Fetch.continueRequest", { requestId })
    ).catch(() => {}); // the page is gone
  });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  originPages.set(origin, entry);
  return entry;
}

// How long a page has to hand its fetch to the browser. It takes milliseconds; a page that has not
// by then is stalled (seen: a cached page whose renderer ran nothing until the next DevTools
// command reached it, so its fetch waited out the whole deadline) and is replaced.
const START_MS = 2000;

/** Tier 2: fetch() from inside a page on the site origin, so TLS, cookies and sec-fetch are the browser's own. */
export async function pageFetch(o: {
  origin: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  profileDir: string;
  headless?: boolean;
  timeoutMs?: number;
  /**
   * a read: when the origin page navigates mid-fetch (its own challenge or redirect destroys the
   * context), wait for it to load and fetch once more. A write is never resent: it may have left.
   */
  retryOnNavigation?: boolean;
  /**
   * The request a redirect asks for next, or a throw refusing it. The page takes one hop at a time
   * so that this is asked about each: left to itself, a page's fetch() follows a redirect to
   * another origin with every header and the body. `taken`: the redirects before this one, for
   * the caller's limit. Without it no redirect is followed, and the redirect itself is the answer.
   */
  redirect?: (from: Hop, status: number, location: string, taken: number) => Hop | Promise<Hop>;
  /** "omit": send none of the profile's cookies (someone else's spec, a request that may change something) */
  credentials?: "include" | "omit";
  /** waits for the site's send slot, once Chrome is up: its start overlaps the wait */
  pace?: () => Promise<void>;
}): Promise<PageFetchResult> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const release = hold();
  try {
    const ctx = await openBrowser(o);
    await o.pace?.();
    const once = async (entry: OriginPage, hop: Hop, left: number) => {
      const { page } = entry;
      const origin = new URL(hop.url).origin;
      const w: Watch = {
        mine: (method, url) => method === hop.method && URL.parse(url)?.origin === origin,
        started: false,
        sealed: false,
      };
      entry.watches.add(w);
      const redirects: Response[] = [];
      const onResponse = (res: Response) => void (res.status() >= 300 && res.status() < 400 && redirects.push(res));
      page.on("response", onResponse);
      const run = page.evaluate(
        async ({ url, method, headers, body, left, credentials }) => {
          const r = await fetch(url, {
            method,
            headers,
            body,
            credentials,
            redirect: "manual",
            signal: AbortSignal.timeout(left),
          });
          if (r.type === "opaqueredirect") return { opaque: true as const, url: r.url };
          const h: Record<string, string> = {};
          r.headers.forEach((v, k) => {
            h[k] = v;
          });
          return { opaque: false as const, status: r.status, headers: h, body: await r.text(), url: r.url };
        },
        { ...hop, left, credentials: o.credentials ?? ("include" as const) },
      );
      // the page itself can hang (a stuck renderer): the budget holds either way
      let timer: NodeJS.Timeout | undefined;
      let quietTimer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response within ${timeoutMs} ms`)), left + 1000);
      });
      // cut short by the deadline, the window says nothing about the page: the call ran out of time
      const why =
        left < START_MS
          ? `no response within ${timeoutMs} ms: the page never sent the request`
          : `the page did not send the request within ${START_MS} ms`;
      const quiet = new Promise<never>((_, reject) => {
        quietTimer = setTimeout(() => void (!w.started && reject(new NotStarted(why))), Math.min(START_MS, left));
      });
      try {
        const r = await Promise.race([run, late, quiet]);
        return r.opaque ? await redirectOf(redirects, hop, r.url) : { ...r, location: undefined };
      } catch (e) {
        const message = (e as Error).message;
        const timedOut = /TimeoutError|timed out|signal timed out|no response within/i.test(message);
        if (!w.started) {
          // decided before anything was let go, so whatever the page sends from now on is failed
          w.sealed = true;
          if (e instanceof NotStarted) throw e;
          if (timedOut) throw new NotStarted(`no response within ${timeoutMs} ms: the page never sent the request`);
          if (page.isClosed() || /Execution context was destroyed|navigat/i.test(message))
            throw new NotStarted(`the page went away before it sent the request: ${message.split("\n")[0]}`);
        }
        if (timedOut) throw new Error(`no response within ${timeoutMs} ms`);
        throw e;
      } finally {
        clearTimeout(timer);
        clearTimeout(quietTimer);
        page.off("response", onResponse);
        if (!w.sealed) entry.watches.delete(w);
        if (entry.retired) retire(entry);
      }
    };
    // One deadline for the whole call from here, with Chrome up: the origin page's load, every hop
    // of the fetch and a recovery after the page navigated all draw on it.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now());
    let entry = await originPage(ctx, o.origin, left);
    let replaced = false;
    let navigated = false;
    /** `first`: no hop before this one was sent, so a hop that never left means the call sent nothing */
    const fetchHop = async (hop: Hop, first: boolean) => {
      for (;;) {
        try {
          return await once(entry, hop, left());
        } catch (e) {
          if (e instanceof NotStarted) {
            // nothing left, so even a write may go again: once, from a fresh page, inside the same deadline
            retire(entry);
            if (replaced || left() <= 1) throw first ? new PageUnreachable(e.message) : new Error(e.message);
            replaced = true;
            entry = await originPage(ctx, o.origin, left);
            continue;
          }
          if (
            navigated ||
            !o.retryOnNavigation ||
            !/Execution context was destroyed|navigat/i.test((e as Error).message)
          )
            throw e;
          navigated = true;
          const { page } = entry;
          // waitForFunction outlives a context swap (a bare load-state wait can resolve on the old document)
          await page
            .waitForFunction(() => document.readyState !== "loading", undefined, { timeout: left() })
            .catch(() => {});
          // it may have landed on another origin (a challenge's redirect): start from a fresh page on ours
          let here = "";
          try {
            here = new URL(page.url()).origin;
          } catch {
            /* about:blank */
          }
          if (here !== o.origin) {
            retire(entry);
            await within(page.close(), undefined, Math.min(SEAL_MS, left()));
            entry = await originPage(ctx, o.origin, left);
          }
        }
      }
    };
    // Pseudo-headers are invalid names for fetch(); forbidden ones (cookie, host, ...) the browser drops itself.
    const headers = Object.fromEntries(Object.entries(o.headers).filter(([k]) => !k.startsWith(":")));
    const body = o.method === "GET" || o.method === "HEAD" ? undefined : o.body;
    let hop: Hop = { url: o.url, method: o.method, headers, body };
    const t0 = performance.now();
    let redirected = false;
    // Redirects are taken by hand, as at tier 1; how many is the policy's to say.
    try {
      for (let hops = 0; ; hops++) {
        const { location, ...r } = await fetchHop(hop, hops === 0);
        redirected ||= !!location;
        if (!location || !o.redirect)
          return { ...r, ms: Math.round(performance.now() - t0), ...(redirected ? { redirected } : {}) };
        hop = await o.redirect(hop, r.status, location, hops);
      }
    } catch (e) {
      // a page a call failed on (a dead server, a stale document, a stall) is not handed to the next one
      retire(entry);
      throw e;
    }
  } finally {
    release();
  }
}

/**
 * Open `url` headed so the user can sign in. Resolves when they close the window or press Enter
 * in the terminal; what counts as logged in is the caller's call. Returns the site's cookies as the
 * window opened, before the page loaded, and as it closed.
 */
export async function login({
  url,
  profileDir,
  waitForEnter = true,
}: {
  url: string;
  profileDir: string;
  waitForEnter?: boolean;
}): Promise<{ opened: StoredCookie[]; closed: StoredCookie[] }> {
  const release = hold();
  try {
    return await loginWindow(url, profileDir, waitForEnter);
  } finally {
    release();
  }
}

// It does not close itself once a login cookie appears: a site can set its session cookie before a
// second factor, a consent page or a redirect back from the identity provider is done, and closing
// then would keep a half-finished sign-in.
async function loginWindow(
  url: string,
  profileDir: string,
  waitForEnter: boolean,
): Promise<{ opened: StoredCookie[]; closed: StoredCookie[] }> {
  const ctx = await openBrowser({ profileDir, headless: false });
  const opened = siteCookies(await ctx.cookies(), url);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // Playwright answers the window's dialogs, not the human: leaving or closing a page is never refused
  // (a dismissed beforeunload would keep it open), an alert is only read, a confirm or prompt declined.
  const onDialog = (d: Dialog) => answer(d, d.type() === "beforeunload" || d.type() === "alert");
  const onPage = (p: Page) => p.on("dialog", onDialog);
  onPage(page);
  ctx.on("page", onPage); // a sign-in popup (an identity provider) too
  // The cookies are read while the window is open, never after it closed: closing Chrome's last window
  // on Linux or Windows quits it, and a quitting Chrome's jar has lost its session cookies (a login
  // cookie among them, on many sites). So the jar is read on every response, where a Set-Cookie lands,
  // and every half second for one a script sets. A read counts only if it completed while the window
  // was open (one in flight when it closed may answer from the quitting jar), and of those the newest
  // started is kept.
  let snapshot: Cookie[] = [];
  let started = 0;
  let kept = 0;
  /** no more reads start */
  let shut = false;
  /** the window began closing: no read that completes from here counts */
  let closing = false;
  const reads = new Set<Promise<void>>();
  const read = () => {
    if (shut) return;
    const n = ++started;
    const r = ctx.cookies().then(
      (c) => {
        if (!closing && n > kept) [kept, snapshot] = [n, c];
      },
      () => {},
    );
    reads.add(r);
    void r.finally(() => reads.delete(r));
  };
  ctx.on("response", read);
  const poll = setInterval(read, 500);
  let onEnter = () => {};
  let entered = false;
  const done = new Promise<void>((resolve) => {
    onEnter = () => {
      entered = true;
      resolve();
    };
    const close = () => {
      closing = true;
      shut = true;
      resolve();
    };
    ctx.once("close", close);
    page.once("close", close);
    // The MCP server's stdin is its transport; only the CLI reads Enter.
    if (waitForEnter) {
      process.stdin.once("data", onEnter);
      process.stdin.resume();
    }
  });
  try {
    // A user who clicks away before the page has loaded interrupts this navigation; the window stays theirs.
    await page.goto(url).catch(() => {});
    read();
    await done;
    // Enter leaves the window open, so one more read is current (unless the user closes it meanwhile).
    if (entered && !shut) read();
    shut = true;
    await Promise.all(reads);
  } finally {
    clearInterval(poll);
    ctx.off("response", read);
    ctx.off("page", onPage);
    if (waitForEnter) {
      process.stdin.off("data", onEnter);
      process.stdin.pause();
    }
    await closeBrowser();
  }
  return { opened, closed: siteCookies(snapshot, url) };
}
