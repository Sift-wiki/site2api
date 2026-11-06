/** Library entry: `import { call } from "api-anything"`. */

export { type BatchItem, type BatchOptions, type BatchResult, callReads } from "./batch.js";
export { browserAvailable, browserChoice, closeBrowser } from "./browser.js";
export { classify } from "./classify.js";
export { describeOperation, type OperationDescription } from "./describe.js";
export {
  type CallOptions,
  type CallResult,
  call,
  heal,
  type NextAction,
  type NextCall,
  type Retry,
  type Tier,
  type WriteStatus,
} from "./execute.js";
export { type AddInput, addOperation, capturePage, healOperation } from "./heal.js";
export { learnOperation, rankCandidates } from "./learn.js";
export { prepareLink } from "./links.js";
export { createServer, serveStdio } from "./mcp.js";
export { pull, search } from "./registry.js";
export { shutdown } from "./report.js";
export { type GetResultOptions, getResult, type ResultCursor, type ResultSlice, type ResultView } from "./results.js";
export {
  type Match,
  type Operation,
  type OperationLink,
  type Param,
  parseSite,
  type Request,
  type ResponseSpec,
  type Site,
  type Slot,
  type Trigger,
} from "./spec.js";
export { exportSite, listSites, loadSite, saveSite } from "./store.js";
export type { CaptureResult, Exchange, StoredCookie, TriggerStep } from "./types.js";
