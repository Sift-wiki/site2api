/**
 * A stand-in for the registry service on localhost, implementing the wire contract in
 * src/registry-api.ts: it serves what a test puts in it, and keeps what the client sent, with each
 * signature checked by WebCrypto the way the service checks it.
 */
import { createHash, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { siteOf } from "../../src/domain.js";
import {
  type Report,
  type SearchMatch,
  type ServedSite,
  signingText,
  type UploadResult,
  type VerifyJob,
  type VersionUpload,
  versionHashText,
} from "../../src/registry-api.js";
import { type Operation, OperationSchema, type Site } from "../../src/spec.js";

export interface Received {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string | undefined>;
  /** the three headers are there and the signature verifies */
  verified: boolean;
}

export const hashOf = (site: string, op: Operation) => {
  const { version: _v, ...rest } = OperationSchema.parse(op);
  return createHash("sha256").update(versionHashText(site, rest)).digest("hex");
};

/** A local spec as the registry serves it: each op its best version, live. */
export function served(
  s: Site,
  notes?: string,
  status: ServedSite["operations"][number]["status"] = "live",
): ServedSite {
  return {
    name: s.name,
    domain: siteOf(new URL(s.baseUrl).hostname),
    baseUrl: s.baseUrl,
    ...(s.displayName ? { displayName: s.displayName } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.pace ? { pace: s.pace } : {}),
    ...(notes !== undefined ? { notes } : {}),
    operations: s.operations.map((op) => {
      const { version: _v, ...operation } = op;
      return { hash: hashOf(s.name, op), status, confirmations: 2, operation };
    }),
  };
}

async function verify(method: string, path: string, body: string, h: Record<string, string | undefined>) {
  const [key, ts, sig] = [h["x-aa-key"], h["x-aa-ts"], h["x-aa-sig"]];
  if (!key || !ts || !sig) return false;
  const k = await webcrypto.subtle.importKey("raw", Buffer.from(key, "base64url"), { name: "Ed25519" }, false, [
    "verify",
  ]);
  const text = signingText(method, path, ts, createHash("sha256").update(body).digest("hex"));
  return webcrypto.subtle.verify({ name: "Ed25519" }, k, Buffer.from(sig, "base64url"), Buffer.from(text));
}

export async function startRegistry() {
  const fake = {
    url: "",
    sites: new Map<string, ServedSite>(),
    /** what GET /v1/search answers, whatever the query */
    matches: [] as SearchMatch[],
    jobs: [] as VerifyJob[],
    /** what POST and GET /v1/claims answer as wanted */
    wanted: [] as { site: string; fingerprint: string; named: boolean }[],
    /** raw answers by path, ahead of everything else: for answers the contract does not allow */
    raw: new Map<string, { status: number; body: string; headers?: Record<string, string> }>(),
    /** every request answers 503 */
    down: false,
    /** every request is left unanswered */
    hang: false,
    /** hung requests whose client gave up on them */
    abandoned: 0,
    /** how POST /v1/versions answers an upload; by default new, candidate for a public read, else review */
    onUpload: (u: VersionUpload): { status: number; body: UploadResult | { error: string; reasons?: string[] } } => {
      const pub =
        (u.evidence.cleanReplay === "ok" || u.evidence.cleanReplay === "blocked") &&
        u.operation.readOnly &&
        !u.evidence.learnedLoggedIn;
      return {
        status: 201,
        body: {
          hash: hashOf(u.site.name, u.operation),
          status: pub ? "candidate" : "review",
          duplicate: false,
        },
      };
    },
    received: [] as Received[],
    uploads: () => fake.received.filter((r) => r.path === "/v1/versions").map((r) => r.body as VersionUpload),
    reports: () =>
      fake.received.filter((r) => r.path === "/v1/reports").flatMap((r) => (r.body as { reports: Report[] }).reports),
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (d) => (text += d));
    req.on("end", async () => {
      const path = req.url ?? "/";
      const method = req.method ?? "GET";
      const headers = req.headers as Record<string, string | undefined>;
      const body = text ? JSON.parse(text) : undefined;
      fake.received.push({ method, path, body, headers, verified: await verify(method, path, text, headers) });
      const send = (status: number, v: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
      const raw = fake.raw.get(path);
      if (raw) return res.writeHead(raw.status, raw.headers ?? {}).end(raw.body);
      if (fake.hang) return void res.on("close", () => fake.abandoned++);
      if (fake.down) return send(503, { error: "down" });
      const u = new URL(path, "http://x");
      if (method === "GET" && u.pathname === "/v1/search") return send(200, { matches: fake.matches });
      if (method === "GET" && u.pathname.startsWith("/v1/sites/")) {
        const s = fake.sites.get(decodeURIComponent(u.pathname.slice("/v1/sites/".length)));
        return s ? send(200, s) : send(404, { error: "nothing servable" });
      }
      if (method === "POST" && u.pathname === "/v1/versions") {
        const r = fake.onUpload(body);
        return send(r.status, r.body);
      }
      if (method === "POST" && u.pathname === "/v1/reports")
        return send(200, { accepted: body.reports.length, ignored: 0 });
      if (method === "GET" && u.pathname === "/v1/verify-jobs") return send(200, { jobs: fake.jobs });
      if (u.pathname === "/v1/claims") return send(200, { wanted: fake.wanted });
      send(404, { error: "no such endpoint" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

export type FakeRegistry = Awaited<ReturnType<typeof startRegistry>>;
