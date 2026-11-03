/**
 * Local discovery and approval-bound calls for agent hosts. Learning, login, registry maintenance
 * and sharing remain CLI workflows. This module never installs specs or starts background work.
 */
import { createHash } from "node:crypto";
import { closeBrowser } from "./browser.js";
import { setAt } from "./codec.js";
import { describeOperation, type OperationDescription } from "./describe.js";
import { type CallOptions, type CallResult, call, finish, resolveCall, type Tier } from "./execute.js";
import { buildRequest, unknownArgs, withDefaults } from "./http.js";
import { captureLive, redact } from "./secrets.js";
import { loadSession, type Session } from "./session.js";
import type { Operation, Request } from "./spec.js";
import { listSites, loadSite, type Resolved, siteNotes, templateHash } from "./store.js";

/** A callable operation and the trigger-page prefixes a host can match against browser URLs. */
export interface HostOperation {
  name: string;
  readOnly: boolean;
  description?: string;
  /** Origin + path before the first {param}; query strings and fragments are excluded. */
  pages: string[];
}

/** One locally installed site. signedIn means stored values exist, not that login was verified. */
export interface HostSite {
  name: string;
  source: "user" | "bundled" | "pulled";
  hosts: string[];
  /** Conservative: any stored cookie or session value, even an expired cookie or a guest value. */
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
      /** Defaults filled; these are call arguments, not redacted display text. */
      args: Record<string, unknown>;
      /** Like CLI --dry: credentials are placeholders. UUIDs and derived values are placeholders too. */
      request: Request;
      /** SHA-256 binding args, the spec, template hash and redacted request to this approval. */
      fingerprint: string;
    }
  | { ok: false; result: CallResult };

/** Host controls only transport and write permission, never healing, force or duplicate overrides. */
export type HostCallOptions = Pick<
  CallOptions,
  "allowWrites" | "maxTier" | "timeoutMs" | "fetchImpl" | "minIntervalMs"
>;

/** Point every default bundled-spec/notes lookup at the host's extracted directory. */
export { setBundledDir } from "./store.js";
/** Shared call result and transport tier types, without importing the main library entry. */
export type { CallResult, OperationDescription, Tier };

const signedIn = (s: Session) => s.cookies.length > 0 || Object.keys(s.values).length > 0;

function pages(op: Operation): string[] {
  const url = new URL(op.trigger.url.replace(/\{[^{}]+\}/g, "__param__"));
  return [url.origin + url.pathname.split("__param__")[0]!];
}

function summary(r: Resolved): HostSite {
  return {
    name: r.site.name,
    source: r.source === "registry" ? "pulled" : r.source,
    hosts: [
      ...new Set(
        [r.site.baseUrl, ...r.site.operations.flatMap((op) => [op.request.url, op.trigger.url])].map(
          (url) => new URL(url.replace(/\{[^{}]+\}/g, "__param__")).hostname,
        ),
      ),
    ],
    signedIn: signedIn(loadSession(r.site.name)),
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

/** Build a credential-free preview and approval hash. No requests, file writes or browser access. */
export function planCall(site: string, op: string, args: Record<string, unknown> = {}): CallPlan {
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
  const unknown = unknownArgs(found.op, args);
  if (unknown) return fail(unknown);
  let session: Session;
  try {
    session = loadSession(found.site.name);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "could not load session", "error");
  }
  try {
    args = structuredClone(withDefaults(found.op, args));
    // Validate live headers too: replacing a credential first could hide a BadHeader refusal.
    buildRequest(found.op, args, session, "host-preview");
    const placeholders: Session = {
      ...session,
      cookies: session.cookies.map((c) => ({ ...c, value: `<${c.name}>` })),
      values: Object.fromEntries(Object.keys(session.values).map((k) => [k, `<${k}>`])),
    };
    let req = buildRequest(found.op, args, placeholders, "host-preview");
    for (const slot of found.op.slots) {
      if (slot.gen) req = setAt(req, slot.at, "<generated:uuid>");
      if (slot.from) req = setAt(req, slot.at, `<derived:${slot.path}>`);
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
    return {
      ok: true,
      site: found.site.name,
      op: found.op.name,
      readOnly: found.op.readOnly,
      signedIn: signedIn(session),
      args,
      request,
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
  const fresh = planCall(plan.site, plan.op, plan.args);
  if (
    !fresh.ok ||
    fresh.fingerprint !== plan.fingerprint ||
    JSON.stringify(fresh.request) !== JSON.stringify(plan.request) ||
    fresh.readOnly !== plan.readOnly ||
    fresh.signedIn !== plan.signedIn
  )
    return {
      ok: false,
      class: "refused",
      reason: "the operation or request changed after it was approved; plan and approve it again",
      ...(!plan.readOnly || (fresh.ok && !fresh.readOnly) ? { write: "not_sent" as const } : {}),
      retry: "after_fix",
      next: "plan and approve the current request before calling",
      ms: 0,
    };
  return call(fresh.site, fresh.op, fresh.args, {
    allowWrites: opts.allowWrites,
    maxTier: opts.maxTier,
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
