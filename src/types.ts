/**
 * Shared contract between the browser layer (which produces exchanges) and the core
 * (which learns and executes operations from them). Both sides import only this file.
 */

/** One request/response pair observed in a real browser. Bodies are raw UTF-8 text. */
export interface Exchange {
  id: number;
  /** Playwright resource type: "document" | "xhr" | "fetch" | "script" | ... */
  resourceType: string;
  request: {
    method: string;
    url: string;
    /** lower-cased names; includes cookie and sec-fetch-* as the browser sent them */
    headers: Record<string, string>;
    body?: string;
  };
  response?: {
    status: number;
    headers: Record<string, string>;
    /** raw body text, read inside the response handler; absent for redirects/beacons */
    body?: string;
    contentType: string;
  };
  /** true when the request was intercepted and aborted before leaving the browser (write learning) */
  aborted?: boolean;
}

/** A Playwright-shaped cookie, stored in the per-site jar. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Everything the browser layer hands back from one trigger run. */
export interface CaptureResult {
  exchanges: Exchange[];
  cookies: StoredCookie[];
  /** final page URL after the trigger ran */
  finalUrl: string;
  /** the final page origin's localStorage and sessionStorage, so learning can ref a token kept there */
  storage?: Record<string, string>;
  /** every URL the page had, history API changes (an SPA's pushState) included: echoes of them are not evidence */
  locations?: string[];
  /** every native dialog the run's pages showed, in order, and how it was answered */
  dialogs?: SeenDialog[];
  /** why the run stopped waiting for the page, and how many of its requests were still open then */
  wait?: {
    /** the op's request answered, the page went quiet, or the run's time ran out */
    ended: "answered" | "quiet" | "deadline";
    open: number;
    /** HTTP status of the first page's last document */
    status?: number;
  };
  /** a trigger run's time ran out in steps[cut], which did not finish; the steps after it never ran */
  cut?: number;
}

/** A native dialog a page showed during a run. */
export interface SeenDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  /** the page's own text (kept in the local capture only; never in a spec or a call's reason) */
  message: string;
  /** origin of the page that showed it */
  origin: string;
  /** index of the trigger step running when it came; -1 before the first */
  step: number;
  accepted: boolean;
}

/** How to make the site's own frontend fire a request. */
export interface TriggerStep {
  action: "click" | "fill" | "press" | "wait" | "goto";
  selector?: string;
  value?: string;
  /** milliseconds for "wait" */
  ms?: number;
}
