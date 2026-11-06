/**
 * `api-anything serve`: the MCP tools over HTTP, for whatever cannot start a local process. Three
 * surfaces on one port: MCP over Streamable HTTP at /mcp, plain JSON endpoints under /v1 and an
 * OpenAPI document. Every REST answer is a tool's answer, run through the very handler MCP runs
 * (mcp.ts `createToolset`), so the two cannot drift.
 *
 * It holds the user's sessions, so it is guarded like a key: a bearer token on every request but
 * the health check, no browser origin unless listed (a page the user visits cannot call it), and,
 * bound to loopback, no Host but the loopback names (DNS rebinding).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idleWork } from "./background.js";
import { Jobs } from "./jobs.js";
import { createServer, createToolset, type Reply, type ServerOptions, VERSION } from "./mcp.js";
import { openApiDocument } from "./openapi.js";
import { ensureDir, home } from "./session.js";

export const DEFAULT_PORT = 8787;
export const BODY_MAX = 1024 * 1024;
/** MCP sessions kept at once; a new one past this closes the least recently used. */
const SESSIONS_MAX = 64;
/** How long a shutdown waits for answers still being written. */
const DRAIN_MS = 30_000;
const WAIT_MS = 25_000;

export interface ServeOptions extends Pick<ServerOptions, "allowWrites" | "sites" | "waitMs" | "run"> {
  host?: string;
  /** 0 picks a free port */
  port?: number;
  /** browser origins allowed to call, exactly as a page sends them (https://app.example.com) */
  cors?: string[];
  /** the address clients reach this server at through a tunnel or proxy: its Host is accepted, and the OpenAPI document names it */
  publicUrl?: string;
  /** default: serveToken() */
  token?: string;
  /** where each request is logged; default stderr */
  log?: (line: string) => void;
}

export interface Served {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;
export const isLoopback = (host: string) => LOOPBACK.test(host);

export const tokenFile = () => join(home(), "serve-token");

/**
 * The token every request but the health check carries: API_ANYTHING_TOKEN, else the one in
 * ~/.api-anything/serve-token, made on first start (32 random bytes, hex, readable by the user only).
 */
export function serveToken(): { token: string; file?: string } {
  const fromEnv = process.env.API_ANYTHING_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv };
  const file = tokenFile();
  const read = () => {
    const t = readFileSync(file, "utf8").trim();
    if (!t) throw new Error(`${file} is empty: delete it and start again`);
    chmodSync(file, 0o600);
    return t;
  };
  try {
    return { token: read(), file };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  ensureDir(home());
  try {
    // wx: two servers starting at once keep one token, never each other's
    writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return { token: read(), file };
}

/** Equal tokens, in time that depends on neither: both are hashed to one length first. */
export function sameToken(given: string, token: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(given), h(token));
}

/** A browser origin as a page sends it: scheme, host and port, nothing else. */
export function originOf(text: string): string {
  if (text === "*") throw new Error("--cors takes origins, not *: any page could then use your sessions");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`--cors ${text}: not an origin, e.g. https://app.example.com`);
  }
  if (u.origin === "null") throw new Error(`--cors ${text}: not an http(s) origin`);
  return u.origin;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The request's JSON body, at most BODY_MAX bytes; an empty one is undefined. */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > BODY_MAX) throw new HttpError(413, `body over ${BODY_MAX} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_MAX) throw new HttpError(413, `body over ${BODY_MAX} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

/** A REST answer is the tool's answer: its JSON, whether it is an object or (list_sites) a list. */
const answerOf = (r: Reply): unknown => r.structuredContent ?? JSON.parse(r.content[0]!.text);

const objectBody = (v: unknown): Record<string, unknown> => {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "the body must be a JSON object");
  return v as Record<string, unknown>;
};

const issues = (e: z.ZodError) =>
  e.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ");

const CallBody = z.strictObject({
  args: z.unknown().optional(),
  view: z.unknown().optional(),
  maxTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  // accepted so a client written for them works; this version has no response cache
  maxAgeMs: z.number().int().min(0).optional(),
  changes: z.boolean().optional(),
  changesOnly: z.boolean().optional(),
});
const WriteBody = CallBody.extend({ again: z.unknown().optional(), idempotencyKey: z.unknown().optional() });
const BatchBody = z.strictObject({ calls: z.unknown(), concurrency: z.unknown().optional() });

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, issues(r.error));
  return r.data;
}

export async function serve(o: ServeOptions = {}): Promise<Served> {
  const host = o.host ?? "127.0.0.1";
  const allowWrites = !!o.allowWrites;
  const token = o.token ?? serveToken().token;
  const cors = new Set((o.cors ?? []).map(originOf));
  const publicUrl = o.publicUrl ? new URL(o.publicUrl) : undefined;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const waitMs = o.waitMs ?? WAIT_MS;
  // one job table: a job a REST call or any MCP session started is found and joined by every other
  const jobs = new Jobs<Reply>(waitMs);
  const serverOptions: ServerOptions = {
    allowWrites,
    sites: o.sites ?? [],
    waitMs,
    jobs,
    ...(o.run ? { run: o.run } : {}),
  };
  const tools = createToolset(serverOptions);
  // `serve --no-learn` turns learnTool off before this, as `mcp --no-learn` does
  const learn = !!tools.input("learn_site", {});
  const idle = idleWork();

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; used: number }>();
  let active = 0;
  let closing = false;
  let allowedHosts = new Set<string>();
  let base = "";

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    if (res.headersSent) return void res.end();
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  };
  const fail = (res: ServerResponse, status: number, error: string, headers?: Record<string, string>) =>
    send(res, status, { ok: false, error }, headers);

  /** a tool's input, or 400 with what its schema refused */
  const input = (name: string, value: unknown) => {
    const r = tools.input(name, value);
    if (!r) throw new HttpError(404, "not found");
    if ("invalid" in r) throw new HttpError(400, r.invalid);
    return r.value;
  };
  const runTool = async (res: ServerResponse, name: string, value: unknown) =>
    send(res, 200, answerOf(await tools.run(name, input(name, value))));

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readBody(req) : undefined;
    if (typeof sid === "string") {
      const s = sessions.get(sid);
      if (!s) return send(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "no such session" }, id: null });
      s.used = Date.now();
      return s.transport.handleRequest(req, res, body);
    }
    if (req.method !== "POST" || !isInitializeRequest(body))
      return send(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "no mcp-session-id: start with an initialize request" },
        id: null,
      });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, used: Date.now() });
        if (sessions.size <= SESSIONS_MAX) return;
        const [oldest] = [...sessions.entries()].sort((a, b) => a[1].used - b[1].used);
        if (oldest) void oldest[1].transport.close();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    // a server per session (one transport each), sharing the job table
    await createServer(serverOptions).connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    let parts: string[];
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, "the path is not valid percent-encoding");
    }
    const path = url.pathname;
    const only = (...methods: string[]) => {
      if (!methods.includes(method)) throw new HttpError(405, `${path} takes ${methods.join(", ")}`);
    };

    if (path === "/mcp") return mcp(req, res);
    if (path === "/openapi.json") {
      only("GET");
      return send(
        res,
        200,
        openApiDocument(tools, { url: base, version: VERSION, allowWrites, learn, sites: o.sites }),
      );
    }
    if (parts[0] !== "v1") throw new HttpError(404, "not found");
    const [, what, a, b, ...rest] = parts;
    if (rest.length) throw new HttpError(404, "not found");

    if (what === "sites" && !b) {
      only("GET");
      return a ? runTool(res, "list_operations", { site: a }) : runTool(res, "list_sites", {});
    }
    if (what === "find" && !a) {
      only("GET");
      const q = url.searchParams.get("q");
      if (!q) throw new HttpError(400, "give q: words, a domain or a URL");
      return runTool(res, "find_sites", { query: q });
    }
    if ((what === "call" || what === "write") && a && b) {
      if (what === "write" && !tools.callWrite) throw new HttpError(404, "not found: writes need serve --allow-writes");
      only("POST");
      const raw = objectBody(await readBody(req));
      const parsed: z.infer<typeof WriteBody> = parse(what === "write" ? WriteBody : CallBody, raw);
      const { maxTier, args, view, again, idempotencyKey } = parsed;
      const extra = maxTier ? { maxTier } : {};
      if (what === "call") {
        const value = input("call_operation", { site: a, op: b, args, view }) as Parameters<
          typeof tools.callOperation
        >[0];
        return send(res, 200, answerOf(await tools.callOperation(value, extra)));
      }
      const value = input("call_write_operation", { site: a, op: b, args, view, again, idempotencyKey }) as Parameters<
        NonNullable<typeof tools.callWrite>
      >[0];
      return send(res, 200, answerOf(await tools.callWrite!(value, extra)));
    }
    if (what === "batch" && !a) {
      only("POST");
      const { calls, concurrency } = parse(BatchBody, objectBody(await readBody(req)));
      return runTool(res, "call_batch", { items: calls, concurrency });
    }
    if (what === "jobs" && a && !b) {
      only("GET");
      return runTool(res, "get_job", { job: a });
    }
    if (what === "results" && a && !b) {
      only("GET");
      const q = url.searchParams;
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const fields = q
        .get("fields")
        ?.split(",")
        .map((f) => f.trim())
        .filter(Boolean);
      return runTool(res, "get_result", {
        resultId: a,
        ...(q.has("offset") ? { offset: num("offset") } : {}),
        ...(q.has("maxChars") ? { maxChars: num("maxChars") } : {}),
        ...(fields?.length ? { fields } : {}),
        ...(q.has("format") ? { format: q.get("format") } : {}),
      });
    }
    if (what === "learn" && !a && learn) {
      only("POST");
      return runTool(res, "learn_site", objectBody(await readBody(req)));
    }
    throw new HttpError(404, "not found");
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    // a GET /mcp is the server's event stream, open as long as the client stays: not an answer to wait for
    const stream = url.pathname === "/mcp" && req.method === "GET";
    if (!stream) active++;
    idle.touch();
    res.once("finish", () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      const hostHeader = (req.headers.host ?? "").toLowerCase();
      if (allowedHosts.size && !allowedHosts.has(hostHeader))
        return fail(res, 403, `Host ${hostHeader || "(none)"} is not this server's`);
      const origin = req.headers.origin;
      const corsHeaders: Record<string, string> = {};
      if (origin !== undefined) {
        if (!cors.has(origin))
          return fail(res, 403, `Origin ${origin} is not allowed: start serve with --cors ${origin}`);
        corsHeaders["access-control-allow-origin"] = origin;
        corsHeaders.vary = "Origin";
        corsHeaders["access-control-expose-headers"] = "mcp-session-id";
        for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
            "access-control-allow-headers":
              "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
            "access-control-max-age": "600",
          });
          return void res.end();
        }
      }
      if (closing) return fail(res, 503, "the server is shutting down", { connection: "close" });
      if (url.pathname === "/v1/health") {
        if (req.method !== "GET") return fail(res, 405, "/v1/health takes GET");
        return send(res, 200, { ok: true, version: VERSION });
      }
      const auth = req.headers.authorization ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (!m || !sameToken(m[1]!.trim(), token))
        return fail(res, 401, m ? "wrong token" : "missing Authorization: Bearer <token>", {
          "www-authenticate": "Bearer",
        });
      await route(req, res, url);
    } catch (e) {
      if (e instanceof HttpError)
        return fail(res, e.status, e.message, e.status === 413 ? { connection: "close" } : {});
      log(`serve: ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      fail(res, 500, `internal error: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      if (!stream) active--;
    }
  };

  const server = httpServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? DEFAULT_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const hostPart = host.includes(":") ? `[${host}]` : host;
  base = publicUrl ? publicUrl.origin : `http://${hostPart}:${port}`;
  if (isLoopback(host)) {
    allowedHosts = new Set([`${hostPart}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (publicUrl) allowedHosts.add(publicUrl.host);
  }

  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      closing = true;
      server.close();
      server.closeIdleConnections();
      const until = Date.now() + DRAIN_MS;
      while (active > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      await Promise.all([...sessions.values()].map((s) => s.transport.close().catch(() => undefined)));
      server.closeAllConnections();
      idle.stop();
    })());

  return { server, host, port, url: `http://${hostPart}:${port}`, close };
}
