/**
 * This install's identity and its sharing choices. The key is an Ed25519 pair made once (`ensureKey`)
 * and kept in `~/.api-anything/key.json` (0600); the registry knows an install only by its public key.
 * `settings.json` holds the answers to setup's questions: `QUESTION` (share), asked by setup or by
 * learn_site the first time something could be shared, and `VERIFY_QUESTION` (background verification),
 * asked by setup only after a yes. Until one was answered, nothing it covers is sent. `localOnly` stops
 * every request to the registry.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { signingText } from "./registry-api.js";
import { home, readJson, writePrivate } from "./session.js";

interface KeyFile {
  /** the raw 32-byte public key, base64url */
  publicKey: string;
  /** PKCS#8 PEM */
  privateKey: string;
  createdAt: string;
}

export const keyFile = () => join(home(), "key.json");
export const settingsFile = () => join(home(), "settings.json");

export function ensureKey(): KeyFile {
  if (existsSync(keyFile())) return readJson<KeyFile>(keyFile(), undefined as unknown as KeyFile);
  const { privateKey } = generateKeyPairSync("ed25519");
  const k: KeyFile = {
    publicKey: createPublicKey(privateKey).export({ format: "jwk" }).x!,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    createdAt: new Date().toISOString(),
  };
  writePrivate(keyFile(), `${JSON.stringify(k, null, 2)}\n`);
  return k;
}

/** The headers that sign a request to the registry (see `signingText`). */
export function signedHeaders(method: string, path: string, body: string, now = Date.now()): Record<string, string> {
  const k = ensureKey();
  const ts = String(now);
  const text = signingText(method, path, ts, createHash("sha256").update(body).digest("hex"));
  const sig = sign(null, Buffer.from(text), createPrivateKey(k.privateKey)).toString("base64url");
  return { "x-aa-key": k.publicKey, "x-aa-ts": ts, "x-aa-sig": sig };
}

export interface Settings {
  /** share public reads this install learns or heals, and report how calls go. Off until the user answered. */
  share: boolean;
  /** when the user answered `QUESTION`, ISO time; absent: never asked */
  askedAt?: string;
  /** an idle MCP server tests a few new shared operations a day from this network. Off unless answered yes. */
  verify: boolean;
  /** when `verify` was answered, ISO time; absent: never asked */
  verifyAskedAt?: string;
  /**
   * "migrated": `verify` was not asked, but carried over from a `share` answer given to the old
   * question, which also covered background verification.
   */
  verifyFrom?: "asked" | "migrated";
  /** no request goes to the registry at all (`setup --local-only`); `API_ANYTHING_LOCAL_ONLY=1` too */
  localOnly?: true;
}

export const QUESTION =
  "Help build the shared catalog? Your agent will share operations it learns from public pages (never your cookies or logins) and report under this install's anonymous key whether calls work. Site searches go to the catalog either way, unless you choose local-only.";

export const VERIFY_QUESTION =
  "Also let an idle server test up to 20 new shared operations a day from your network? No cookies, public https hosts only.";

type Stored = Partial<Settings>;

function readStored(): Stored {
  try {
    return readJson<Stored>(settingsFile(), {}) ?? {};
  } catch {
    return {};
  }
}

/**
 * An install that answered the old question, which also said "test a few new operations a day from your
 * network", keeps the answer it gave for verification: written once, so no read infers it.
 */
function migrate(s: Stored): Stored {
  if (!s.askedAt || s.verify !== undefined) return s;
  const next: Stored = {
    ...s,
    verify: s.share === true,
    verifyAskedAt: s.askedAt,
    verifyFrom: "migrated",
  };
  try {
    writePrivate(settingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // unwritable: the same answer is carried over on the next read
  }
  return next;
}

export function loadSettings(): Settings {
  const s = migrate(readStored());
  const share = s.share === true && !!s.askedAt;
  return {
    share,
    ...(s.askedAt ? { askedAt: s.askedAt } : {}),
    verify: share && s.verify === true && !!s.verifyAskedAt,
    ...(s.verifyAskedAt ? { verifyAskedAt: s.verifyAskedAt } : {}),
    ...(s.verifyFrom ? { verifyFrom: s.verifyFrom } : {}),
    ...(s.localOnly === true ? { localOnly: true as const } : {}),
  };
}

/** `verify` is always written: a file without it is one an older version wrote, which `migrate` reads. */
export function saveSettings(s: Omit<Settings, "verify"> & { verify?: boolean }): void {
  writePrivate(settingsFile(), `${JSON.stringify({ ...s, verify: s.verify ?? false }, null, 2)}\n`);
}

const now = () => new Date().toISOString();

/**
 * Keeps the user's answer to `QUESTION`: it is not asked again. A no also turns verification off, since
 * its outcomes go to the catalog as reports. `verify` is always written, so the migration below never
 * mistakes this answer for one to the old question.
 */
export function answerShare(share: boolean): void {
  const s = loadSettings();
  saveSettings({ ...s, share, askedAt: now(), ...(share ? {} : { verify: false }) });
}

/** Keeps the user's answer to `VERIFY_QUESTION`. */
export function answerVerify(verify: boolean): void {
  saveSettings({ ...loadSettings(), verify, verifyAskedAt: now(), verifyFrom: "asked" });
}

/** Turns local-only mode on or off in settings.json. */
export function setLocalOnly(on: boolean): void {
  const { localOnly: _, ...s } = loadSettings();
  saveSettings({ ...s, ...(on ? { localOnly: true as const } : {}) });
}

const envLocalOnly = () => /^(1|true|yes|on)$/i.test(process.env.API_ANYTHING_LOCAL_ONLY ?? "");

/** No request goes to the registry: `API_ANYTHING_LOCAL_ONLY=1`, or `setup --local-only`. */
export const localOnly = (): boolean => envLocalOnly() || readStored().localOnly === true;

/** How the user turns local-only mode off, for a `next`. */
export const localOnlyOff = (): string =>
  envLocalOnly()
    ? "unset API_ANYTHING_LOCAL_ONLY to reach the shared catalog"
    : "api-anything setup --no-local-only --share-only turns it off";
