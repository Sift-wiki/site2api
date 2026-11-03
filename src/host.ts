/**
 * Local discovery and approval-bound calls for agent hosts. Learning, login, registry maintenance
 * and sharing remain CLI workflows. This module never installs specs or starts background work.
 */
import { createHash } from "node:crypto";
import { closeBrowser } from "./browser.js";
import { setAt } from "./codec.js";
import { describeOperation, type OperationDescription } from "./describe.js";
import {
  bareCall,
  type CallOptions,
  type CallResult,
  call,
  callOnlyWriteRefusal,
  callSession,
  callTiers,
  finish,
  resolveCall,
  type Tier,
  tierBlocked,
} from "./execute.js";
import { fillTrigger } from "./heal.js";
import { buildRequest, unknownArgs, withDefaults } from "./http.js";
import { profileSignedIn } from "./profile-state.js";
import { captureLive, redact } from "./secrets.js";
import { loadSession, type Session } from "./session.js";
import type { Operation, Request, Trigger } from "./spec.js";
import { listSites, loadSite, type Resolved, rememberedTier, siteNotes, templateHash } from "./store.js";

/** A callable operation and the trigger-page prefixes a host can match against browser URLs. */
export interface HostOperation {
  name: string;
  readOnly: boolean;
  description?: string;
  /** Static origin + path before the first {param}; templated origins and invalid URLs are omitted. */
  pages: string[];
}

/** One locally installed site. signedIn is a caution, not a verified login. */
export interface HostSite {
  name: string;
  source: "user" | "bundled" | "pulled";
  hosts: string[];
  /** Stored values, own-profile cookies when browser tiers are reachable, or unreadable profile state. */
  signedIn: boolean;
  operations: HostOperation[];
}

/** An offline preview, or the same input/error class call() would return without sending. */
export type CallPlan =
  | {
      ok: true;
      site: string;
      op: string;
      readOnly: boolean;
      signedIn: boolean;
      /** Starting transport tier, with the same remembered-tier and cap rules as call(). */
      tier: Tier;
      /** Approved transport cap. Changing it requires a new plan. */
      maxTier: Tier;
      /** Defaults filled; these are call arguments, not redacted display text. */
      args: Record<string, unknown>;
      /** Like CLI --dry: credentials are placeholders. UUIDs and derived values are placeholders too. */
      request: Request;
      /** Tier-3 steps, companion matches, and the count/step indices of confirms the page may accept. */
      trigger?: Omit<Trigger, "confirms"> & { confirms?: { count: number; steps: number[] } };
      /** SHA-256 binding args, spec, preview, tier and cap to this approval. */
      fingerprint: string;
    }
  | { ok: false; result: CallResult };

/** Host controls only transport and write permission, never healing, force or duplicate overrides. */
export type HostCallOptions = Pick<
  CallOptions,
  "allowWrites" | "maxTier" | "timeoutMs" | "fetchImpl" | "minIntervalMs"
>;
export type HostPlanOptions = Pick<CallOptions, "maxTier">;

/** Point every default bundled-spec/notes lookup at the host's extracted directory. */
export { setBundledDir } from "./store.js";
/** Shared call result and transport tier types, without importing the main library entry. */
export type { CallResult, OperationDescription, Tier };

const PARAM = "__api_anything_param__";

function staticUrl(text: string): URL | undefined {
  try {
    const url = new URL(text.replace(/\{[^{}]+\}/g, PARAM));
    if (!["http:", "https:"].includes(url.protocol) || url.host.includes(PARAM)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function pages(op: Operation): string[] {
  const url = staticUrl(op.trigger.url);
  return url ? [url.origin + url.pathname.split(PARAM)[0]!] : [];
}

function urlsOf(op: Pick<Operation, "request" | "trigger" | "slots"> & Partial<Pick<Operation, "readback">>): string[] {
  return [
    op.request.url,
    ...op.slots.flatMap((s) => (s.from ? [s.from.request.url] : [])),
    op.trigger.url,
    ...(op.trigger.softFrom ? [op.trigger.softFrom] : []),
    ...(op.trigger.steps ?? []).flatMap((s) => (s.action === "goto" && s.value ? [s.value] : [])),
    ...(op.readback && "read" in op.readback ? urlsOf(op.readback.read) : []),
  ];
}

function hostnames(urls: string[]): string[] {
  return [
    ...new Set(
      urls.flatMap((text) => {
        const url = staticUrl(text);
        return url ? [url.hostname] : [];
      }),
    ),
  ];
}

const hostsOf = (r: Pick<Resolved, "site">) => hostnames([r.site.baseUrl, ...r.site.operations.flatMap(urlsOf)]);

/** Unknown template origins could use any of the profile's sites; do not claim they are signed out. */
function profileHostsOf(r: Pick<Resolved, "site">): string[] {
  const urls = [r.site.baseUrl, ...r.site.operations.flatMap(urlsOf)];
  return urls.some((url) => !staticUrl(url)) ? [] : hostnames(urls);
}

function signedIn(s: Session, hosts: string[], browser: boolean): boolean {
  return s.cookies.length > 0 || Object.keys(s.values).length > 0 || (browser && profileSignedIn(hosts));
}

function summary(r: Resolved): HostSite {
  return {
    name: r.site.name,
    source: r.source === "registry" ? "pulled" : r.source,
    hosts: hostsOf(r),
    signedIn: signedIn(loadSession(r.site.name), profileHostsOf(r), r.site.operations.length > 0),
    operations: r.site.operations.map((op) => ({
      name: op.name,
      readOnly: op.readOnly,
      ...(op.description ? { description: op.description } : {}),
      pages: pages(op),
    })),
  };
}

/** List every valid callable site using local files only; invalid specs/sessions are omitted. */
export function hostSites(): HostSite[] {
  return listSites().flatMap((name) => {
    try {
      const r = loadSite(name);
      return r ? [summary(r)] : [];
    } catch {
      return [];
    }
  });
}

/** Describe one installed site and its caller notes, without pulling, calling or opening a browser. */
export function hostSite(
  name: string,
): { site: HostSite; notes?: string; operations: OperationDescription[] } | undefined {
  const r = loadSite(name);
  if (!r) return undefined;
  const notes = siteNotes(r.site.name);
  return {
    site: summary(r),
    ...(notes ? { notes } : {}),
    operations: r.site.operations.map((op) => describeOperation(r.site, op.name)),
  };
}

/** Build a redacted preview and approval hash. No requests, file writes or browser launch. */
export function planCall(
  site: string,
  op: string,
  args: Record<string, unknown> = {},
  opts: HostPlanOptions = {},
): CallPlan {
  const found = resolveCall(site, op);
  if ("ok" in found) return { ok: false, result: { ...finish(found, undefined, undefined, []), ms: 0 } };
  const fail = (reason: string, cls: "input" | "error" = "input"): CallPlan => ({
    ok: false,
    result: {
      ...finish(
        { ok: false, class: cls, reason, next: `check the args against: api-anything ops ${found.site.name}` },
        found.op,
        found.site.name,
        [],
      ),
      ms: 0,
    },
  });
  if (
    args === null ||
    typeof args !== "object" ||
    (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)
  )
    return fail("args must be a plain object");
  if (opts.maxTier !== undefined && ![1, 2, 3].includes(opts.maxTier)) return fail("maxTier must be 1, 2 or 3");
  const unknown = unknownArgs(found.op, args);
  if (unknown) return fail(unknown);
  let session: Session;
  try {
    session = loadSession(found.site.name);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "could not load session", "error");
  }
  try {
    const { tier, maxTier } = callTiers(
      found.site,
      found.op,
      opts.maxTier,
      rememberedTier(found.site.name, found.op.name),
    );
    if (tier > maxTier)
      return {
        ok: false,
        result: {
          ...finish(tierBlocked(found.site, found.op, { tier, maxTier }, opts.maxTier), found.op, found.site.name, []),
          ms: 0,
        },
      };
    const unsafeWrite = callOnlyWriteRefusal(found.site.name, found.op, tier);
    if (unsafeWrite) return { ok: false, result: { ...finish(unsafeWrite, found.op, found.site.name, []), ms: 0 } };
    args = structuredClone(withDefaults(found.op, args));
    const effective = callSession(found.site, found.op, session, found.theirs);
    // Validate live headers too: replacing a credential first could hide a BadHeader refusal.
    buildRequest(found.op, args, effective, "host-preview");
    const placeholders: Session = {
      ...effective,
      cookies: effective.cookies.map((c) => ({ ...c, value: `<${c.name}>` })),
      values: Object.fromEntries(Object.keys(effective.values).map((k) => [k, `<${k}>`])),
    };
    let req = buildRequest(found.op, args, placeholders, "host-preview");
    for (const slot of found.op.slots) {
      if (slot.gen) req = setAt(req, slot.at, "<generated:uuid>");
      if (slot.from) req = setAt(req, slot.at, `<derived:${slot.path}>`);
    }
    if (tier >= 2) {
      delete req.headers.cookie;
      // The page, not the per-site jar, chooses cookies. Do not imply the jar's account will be used.
      if (tier === 3 || !bareCall(found.site, found.op)) req.headers.cookie = "<browser-profile cookies>";
    }
    // A caller's arg or a stored literal can echo a live value outside a credential slot.
    const live = captureLive({ cookies: session.cookies, storage: session.values });
    const hide = (text: string) => redact(text, live, { named: true });
    const request: Request = {
      method: hide(req.method),
      url: hide(req.url),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [hide(k), hide(v)])),
      ...(req.body !== undefined ? { body: hide(req.body) } : {}),
    };
    const filled = tier === 3 ? fillTrigger(found.op.trigger, args) : undefined;
    const trigger: Extract<CallPlan, { ok: true }>["trigger"] = filled && {
      url: hide(filled.url),
      ...(filled.softFrom ? { softFrom: hide(filled.softFrom) } : {}),
      ...(filled.steps
        ? {
            steps: filled.steps.map((s) => ({
              ...s,
              ...(s.selector !== undefined ? { selector: hide(s.selector) } : {}),
              ...(s.value !== undefined ? { value: hide(s.value) } : {}),
            })),
          }
        : {}),
      ...(found.op.trigger.confirms
        ? {
            confirms: {
              count: found.op.trigger.confirms.length,
              steps: found.op.trigger.confirms.map((c) => c.step),
            },
          }
        : {}),
      ...(found.op.trigger.companions
        ? {
            companions: found.op.trigger.companions.map((c) =>
              Object.fromEntries(Object.entries(c).map(([k, v]) => [k, hide(v)])),
            ),
          }
        : {}),
    };
    return {
      ok: true,
      site: found.site.name,
      op: found.op.name,
      readOnly: found.op.readOnly,
      signedIn: signedIn(
        session,
        profileHostsOf(found),
        tier >= 2 || (maxTier >= 2 && (found.op.readOnly || !!found.op.readback)),
      ),
      tier,
      maxTier,
      args,
      request,
      ...(trigger ? { trigger } : {}),
      // The whole spec also binds tier-3 steps, write classification, trust rules and readbacks.
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            found.site.name,
            found.op.name,
            templateHash(found.op),
            found.source,
            found.site,
            args,
            request,
            trigger,
            tier,
            maxTier,
          ]),
        )
        .digest("hex"),
    };
  } catch (e) {
    return fail(redact(e instanceof Error ? e.message : "invalid arguments", session));
  }
}

/**
 * Re-plan immediately before calling; any approval mismatch refuses without sending. The approved
 * preview itself must match too, so mutating its displayed request cannot bypass the fingerprint.
 * Calls only the installed op, with all write gates and duplicate-write protection intact.
 */
export async function callPlanned(
  plan: Extract<CallPlan, { ok: true }>,
  opts: HostCallOptions = {},
): Promise<CallResult> {
  const fresh = planCall(plan.site, plan.op, plan.args, { maxTier: opts.maxTier ?? plan.maxTier });
  if (!fresh.ok) return fresh.result;
  if (
    fresh.fingerprint !== plan.fingerprint ||
    JSON.stringify(fresh.request) !== JSON.stringify(plan.request) ||
    JSON.stringify(fresh.trigger) !== JSON.stringify(plan.trigger) ||
    fresh.tier !== plan.tier ||
    fresh.maxTier !== plan.maxTier ||
    fresh.readOnly !== plan.readOnly ||
    fresh.signedIn !== plan.signedIn
  )
    return {
      ok: false,
      class: "refused",
      reason: "the operation or request changed after it was approved; plan and approve it again",
      ...(!plan.readOnly || !fresh.readOnly ? { write: "not_sent" as const } : {}),
      retry: "after_fix",
      next: "plan and approve the current request before calling",
      ms: 0,
    };
  return call(fresh.site, fresh.op, fresh.args, {
    allowWrites: opts.allowWrites,
    maxTier: fresh.maxTier,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    minIntervalMs: opts.minIntervalMs,
    callOnly: true,
  });
}

/** Close the shared browser so the process can exit. Host calls never queue background work. */
export async function closeHost(): Promise<void> {
  await closeBrowser();
}
