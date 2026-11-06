/** Bounded, ordered reads. Every attempt uses call()'s pacing, cool-downs and tier ladder. */
import { z } from "zod";
import { type CallOptions, type CallResult, call } from "./execute.js";

export const BATCH_MAX = 200;
export const BATCH_CONCURRENCY = 4;
export const BatchItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  site: z.string().min(1),
  op: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type BatchItem = z.infer<typeof BatchItemSchema>;
export type BatchResult = CallResult & { id: string | number; site: string; op: string };

export interface BatchOptions
  extends Pick<CallOptions, "fetchImpl" | "maxTier" | "timeoutMs" | "maxAgeMs" | "changes" | "changesOnly"> {
  /** Default 1; at most 4, and only across different sites. */
  concurrency?: number;
  /** Default 200; may only lower the cap. The whole batch is checked before any call. */
  maxItems?: number;
}

const input = (reason: string): CallResult => ({
  ok: false,
  class: "input",
  reason,
  ms: 0,
  retry: "after_fix",
  next: "fix or remove this item before submitting another read batch",
  nextCall: { action: "fix_args" },
});

/** No args or unrecognized fields are copied into a result, even for a malformed item. */
function identity(value: unknown, index: number): Pick<BatchResult, "id" | "site" | "op"> {
  const v = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    id: typeof v.id === "string" || (typeof v.id === "number" && Number.isFinite(v.id)) ? v.id : index + 1,
    site: typeof v.site === "string" ? v.site : "",
    op: typeof v.op === "string" ? v.op : "",
  };
}

/**
 * Yield one result per item, in input order; absent ids are 1-based positions. Invalid items fail
 * individually. Invalid bounds or an oversized batch throw before sending anything. Stopping
 * iteration starts no more calls, but lets the at most four already running finish.
 */
export async function* callReads(items: readonly BatchItem[], opts: BatchOptions = {}): AsyncGenerator<BatchResult> {
  const { concurrency = 1, maxItems = BATCH_MAX } = opts;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > BATCH_CONCURRENCY)
    throw new Error(`batch concurrency must be an integer from 1 to ${BATCH_CONCURRENCY}`);
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > BATCH_MAX)
    throw new Error(`batch maxItems must be an integer from 1 to ${BATCH_MAX}`);
  if (!Array.isArray(items) || items.length > maxItems)
    throw new Error(`batch must be an array of at most ${maxItems} items`);

  const pending = Array.from(items, (value, index) => ({
    ...identity(value, index),
    parsed: BatchItemSchema.safeParse(value),
    index,
  }));
  const count = pending.length;
  const run = async (item: (typeof pending)[number]): Promise<BatchResult> => {
    const { id, site, op, parsed } = item;
    if (!parsed.success) return { id, site, op, ...input("expected {id?: string or number, site, op, args?: object}") };
    try {
      // Whitelist options: a JS caller's allowWrites, force or pacing override cannot escape the bounds.
      const r = await call(site, op, parsed.data.args ?? {}, {
        fetchImpl: opts.fetchImpl,
        maxTier: opts.maxTier,
        timeoutMs: opts.timeoutMs,
        maxAgeMs: opts.maxAgeMs,
        changes: opts.changes,
        changesOnly: opts.changesOnly,
        allowWrites: false,
      });
      return {
        id,
        site,
        op,
        ...(r.class === "refused" ? { ...input("writes are not batched"), write: "not_sent" as const, ms: r.ms } : r),
      };
    } catch {
      // An unexpected local exception may quote args or a session value. Never print its text.
      return {
        id,
        site,
        op,
        ok: false,
        class: "error",
        ms: 0,
        reason: "batch item failed unexpectedly; nothing else in the batch was stopped",
        retry: "after_fix",
        next: "check the local spec and session before retrying this read",
        nextCall: { action: "report" },
      };
    }
  };

  const activeSites = new Set<string>();
  const running = new Map<number, Promise<{ index: number; result: BatchResult }>>();
  const finished = new Map<number, BatchResult>();
  let next = 0;
  try {
    while (next < count) {
      while (running.size < concurrency) {
        // Case variants resolve to the same store key. Keep that site's input order too.
        const at = pending.findIndex((item) => !activeSites.has(item.site.toLowerCase()));
        if (at < 0) break;
        const item = pending.splice(at, 1)[0]!;
        activeSites.add(item.site.toLowerCase());
        running.set(
          item.index,
          run(item).then((result) => ({ index: item.index, result })),
        );
      }
      const { index, result } = await Promise.race(running.values());
      running.delete(index);
      activeSites.delete(result.site.toLowerCase());
      finished.set(index, result);
      while (finished.has(next)) {
        const ready = finished.get(next)!;
        finished.delete(next++);
        yield ready;
      }
    }
  } finally {
    await Promise.all(running.values());
  }
}
