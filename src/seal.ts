/**
 * Files that hold credential values or signed-in answers (session jars, captures, kept answers in
 * snapshots/) are sealed with AES-256-GCM under one 32-byte data key. The key lives in the OS store
 * (macOS Keychain, Linux Secret Service, Windows DPAPI) or comes from the `API_ANYTHING_KEY`
 * passphrase. Only a home that has never sealed a file, on a machine with no key store at all,
 * writes 0600 plaintext (and the caller is told once); any other key failure refuses the write.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { corruptFile, ensureDir, home, pause, pruneCaptures, readJson, tryLock, writePrivate } from "./session.js";

/** The version marker inside a sealed file's envelope; a later format gets another number. */
export const SEALED = "api-anything/1";
/**
 * The first line of every sealed file. It is not JSON on purpose: api-anything 0.3.2 and earlier read
 * a session file with JSON.parse and throw on anything else, so an older version refuses a sealed
 * file loudly instead of reading it as an empty session and saving plaintext over it.
 */
export const MAGIC = "#api-anything-sealed\n";
const SERVICE = "api-anything";
const ACCOUNT = "data-key";
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const STORE_TIMEOUT_MS = 15_000;
/** The key-creation lock outlives what its holder does under it: three store calls of up to 15 s each. */
const KEY_LOCK_MS = 120_000;

/**
 * Where the data key is kept. `get` answers undefined when the store holds none. A store that does
 * not exist on this machine throws `KeyUnavailable`; any other throw is a failure of a store that
 * does exist (a locked keychain, a timeout), which refuses the write.
 */
export interface KeyStore {
  /** shown in messages and recorded in each sealed file: "macos-keychain", "secret-tool", "dpapi" */
  readonly name: string;
  get(): Buffer | undefined;
  /** store a new key; may replace one another process stored meanwhile (creation is locked, and read back) */
  put(key: Buffer): void;
  /**
   * The lock file (without `.lock`) that guards creating this store's key. A store shared by every
   * home of the user (Keychain, Secret Service) locks per user; by default, per home.
   */
  readonly lock?: string;
}

/** The key store this platform names is not here at all: no binary, no session bus, no keyring service. */
export class KeyUnavailable extends Error {}

export class SealError extends Error {
  constructor(
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
}

interface Envelope {
  sealed: string;
  alg: "A256GCM";
  /** where the key came from, so a mismatch can say which one is missing */
  key: string;
  kid: string;
  iv: string;
  tag: string;
  data: string;
}

export type Sealing =
  | { sealed: true; key: string }
  | {
      sealed: false;
      why: string;
      /** API_ANYTHING_PLAINTEXT=1: the user chose plaintext, so nothing warns */
      chosen: boolean;
    };

interface DataKey {
  key: Buffer;
  kid: string;
  source: string;
}

const kidOf = (key: Buffer) => createHmac("sha256", key).update("api-anything key id").digest("hex").slice(0, 16);
const b64 = (b: Buffer) => b.toString("base64");
const firstLine = (e: unknown) => (e as Error).message.split("\n")[0]!;

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: STORE_TIMEOUT_MS });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new KeyUnavailable(`${cmd} is not here`);
  if (r.error) throw r.error;
  return r;
}

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

const decodeKey = (text: string, from: string): Buffer => {
  const k = Buffer.from(text.trim(), "base64");
  if (k.length !== 32) throw new Error(`the key in ${from} is not 32 bytes`);
  return k;
};

/**
 * The lock for a store every home of this user shares: in the user's runtime directory (Linux) or
 * temporary directory (per user on macOS), never in one home, so two homes cannot each create a key.
 */
export const userKeyLock = () =>
  join(process.env.XDG_RUNTIME_DIR || tmpdir(), `api-anything-${process.getuid?.() ?? userInfo().username}`, ACCOUNT);

/**
 * The login Keychain through /usr/bin/security. An item `security` adds lists `security` itself as a
 * trusted application in its access control, so a later `find-generic-password` by the same binary
 * reads it without a dialog. The secret goes in on stdin (`security -i`), never on the command line.
 */
export const macosKeychain = (bin = "/usr/bin/security"): KeyStore => ({
  name: "macos-keychain",
  get lock() {
    return userKeyLock();
  },
  get() {
    const r = run(bin, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (r.status === 44) return undefined; // errSecItemNotFound
    if (r.status !== 0) throw new Error(`security find-generic-password: ${r.stderr.trim() || `exit ${r.status}`}`);
    return decodeKey(r.stdout, "the Keychain");
  },
  put(key) {
    // no -U: a key another process added first is kept, and read back
    const r = run(bin, ["-i"], `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -l ${SERVICE} -w ${b64(key)}\n`);
    if (r.status !== 0 && r.status !== 45) throw new Error(`security add-generic-password: exit ${r.status}`);
  },
});

/**
 * stderr of a Secret Service client when no keyring daemon serves the bus, or when GLib finds no bus
 * and cannot autolaunch one (no X11 `$DISPLAY`): no store here, as with no bus address at all
 */
const NO_SECRET_SERVICE = /org\.freedesktop\.secrets was not provided|ServiceUnknown|autolaunch D-Bus/i;
/** stderr when the bus address names a socket that refuses the connection or is gone */
const BUS_UNREACHABLE = /Could not connect/i;

/** The Secret Service through libsecret's `secret-tool`, when it is installed and a session bus answers. */
export const secretTool = (): KeyStore => ({
  name: "secret-tool",
  get lock() {
    return userKeyLock();
  },
  get() {
    if (!onPath("secret-tool")) throw new KeyUnavailable("secret-tool is not installed");
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && !existsSync(`/run/user/${process.getuid?.()}/bus`))
      throw new KeyUnavailable("no D-Bus session bus");
    const r = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
    if (r.status === 0 && r.stdout.trim()) return decodeKey(r.stdout, "the Secret Service");
    // a lookup that finds nothing exits 1 quietly; anything on stderr is a bus or keyring failure
    if (r.status === 1 && !r.stderr.trim()) return undefined;
    if (NO_SECRET_SERVICE.test(r.stderr)) throw new KeyUnavailable(`no Secret Service: ${r.stderr.trim()}`);
    // A bus that is set but down (restarting, or a stale address) is not a machine without a store:
    // fail the write rather than fall back to plaintext.
    if (BUS_UNREACHABLE.test(r.stderr))
      throw new SealError(
        `the Secret Service could not be reached: ${r.stderr.trim()}`,
        "start the D-Bus session bus and the keyring daemon (or fix DBUS_SESSION_BUS_ADDRESS), then retry; or set API_ANYTHING_KEY to a passphrase to seal with it instead (files already sealed with the secret-tool key still need that key); nothing was written",
      );
    throw new Error(`secret-tool lookup: ${r.stderr.trim() || `exit ${r.status}`}`);
  },
  put(key) {
    const r = run(
      "secret-tool",
      ["store", "--label=api-anything data key", "service", SERVICE, "account", ACCOUNT],
      b64(key),
    );
    if (r.status !== 0) throw new Error(`secret-tool store: ${r.stderr.trim() || `exit ${r.status}`}`);
  },
});

const dpapiScript = (op: "Protect" | "Unprotect") =>
  "Add-Type -AssemblyName System.Security; " +
  "$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); " +
  `$o = [System.Security.Cryptography.ProtectedData]::${op}($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
  "[Console]::Out.Write([Convert]::ToBase64String($o))";

/** Windows DPAPI (CurrentUser) through PowerShell; the protected blob is kept in the home folder. */
export const dpapi = (): KeyStore => {
  const file = () => join(home(), "data-key.dpapi");
  const ps = (op: "Protect" | "Unprotect", input: string) => {
    const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", dpapiScript(op)], input);
    if (r.status !== 0) throw new Error(`DPAPI ${op}: ${r.stderr.trim() || `exit ${r.status}`}`);
    return r.stdout;
  };
  return {
    name: "dpapi",
    get() {
      if (!existsSync(file())) return undefined;
      return decodeKey(ps("Unprotect", readFileSync(file(), "utf8")), file());
    },
    put(key) {
      writePrivate(file(), ps("Protect", b64(key)));
    },
  };
};

function platformStore(): KeyStore | undefined {
  // node:test sets this in every test process (and the CLIs they spawn inherit it): no test may
  // reach the real Keychain or keyring, so tests get no OS store unless they inject one
  if (process.env.NODE_TEST_CONTEXT) return undefined;
  if (process.platform === "darwin") return macosKeychain();
  if (process.platform === "linux") return secretTool();
  if (process.platform === "win32") return dpapi();
  return undefined;
}

let injected: KeyStore | null | undefined;
/** Keys found, and key stores found missing. A failure is never cached: the next operation asks again. */
const cache = new Map<string, DataKey | { none: string }>();
let listener: ((why: string) => void) | undefined;
let warned = false;

/** Tests: use this store (null: none), or the platform's again (undefined). Forgets every cached key. */
export function setKeyStore(store: KeyStore | null | undefined): void {
  injected = store;
  cache.clear();
  warned = false;
}

/** Told once per process when a credential file is written unsealed and the user did not choose that. */
export function onPlaintext(fn: (why: string) => void): void {
  listener = fn;
}

const chosePlaintext = () => process.env.API_ANYTHING_PLAINTEXT === "1";
const saltFile = () => join(home(), "key-salt.json");
const markerFile = () => join(home(), "sealed.json");
const DIRS = [
  ["sessions", "session"],
  ["captures", "capture"],
  ["snapshots", "snapshot"],
] as const;

interface Marker {
  v: 1;
  at: string;
  /** the key the first sealed file here was sealed with */
  key: string;
  /** every file written before sealing has been sealed */
  migrated?: boolean;
}

const readMarker = (): Marker | undefined => {
  try {
    return JSON.parse(readFileSync(markerFile(), "utf8")) as Marker;
  } catch {
    return existsSync(markerFile()) ? ({ v: 1, at: "", key: "unknown" } as Marker) : undefined;
  }
};

/** Recorded before the first sealed write: from then on this home never falls back to plaintext. */
function markSealed(k: DataKey): void {
  if (!existsSync(markerFile()))
    writePrivate(markerFile(), `${JSON.stringify({ v: 1, at: new Date().toISOString(), key: k.source })}\n`);
}

/** The first bytes of a file: enough to tell a sealed one. */
function head(file: string, n = 512): string {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(n);
    return b.toString("utf8", 0, readSync(fd, b, 0, n, 0));
  } finally {
    closeSync(fd);
  }
}

/** The `key` of each sealed session, capture or snapshot file here (its envelope's source), one per file. */
function sealedKeys(): string[] {
  const keys: string[] = [];
  for (const [dir] of DIRS) {
    let files: string[];
    try {
      files = readdirSync(join(home(), dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const text = head(join(home(), dir, f));
        if (isSealedText(text)) keys.push(/"key":"([^"]*)"/.exec(text)?.[1] ?? "unknown");
      } catch {
        // vanished meanwhile
      }
    }
  }
  return keys;
}

/**
 * A lock whose holder writes its pid: taken over only when that process is gone. A live holder keeps
 * it however long it holds it — making the key can wait on a keychain or Secret Service prompt for
 * minutes — so age alone never takes a lock from a running process; a lock whose pid cannot be read
 * (a partial write) is taken after two seconds.
 */
function staleLock(lock: string): string | undefined {
  try {
    const text = readFileSync(lock, "utf8");
    const age = Date.now() - statSync(lock).mtimeMs;
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 0) return age > 2000 ? text : undefined; // being written
    if (pid === process.pid) return undefined;
    try {
      process.kill(pid, 0);
      return undefined;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ESRCH" ? text : undefined;
    }
  } catch {
    return undefined; // released meanwhile
  }
}

/**
 * Run fn holding the lock that guards creating a key. Unlike `withLock` it never expires under a
 * live holder (store subprocesses can outlast `withLock`'s 10 s) and never goes ahead unlocked.
 */
export function keyLock<T>(file: string, fn: () => T, waitMs = KEY_LOCK_MS): T {
  ensureDir(dirname(file));
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const stale = staleLock(lock);
    if (stale !== undefined) {
      // move it aside and check it is still the one judged stale, not a lock taken meanwhile
      const aside = `${lock}.${process.pid}.stale`;
      try {
        renameSync(lock, aside);
        if (readFileSync(aside, "utf8") !== stale) linkSync(aside, lock);
      } catch {
        // another waiter moved it first
      }
      rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new SealError(
        `another api-anything process has held ${lock} for over ${Math.round(waitMs / 1000)} s while making the key`,
        `retry; if it repeats with no other api-anything running, delete ${lock}`,
      );
    pause(10);
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** The passphrase's key: scrypt under this home's salt, made on first use, with the key id that tells a wrong passphrase. */
function passphraseKey(pass: string): DataKey {
  return keyLock(saltFile(), () => {
    let kept: { salt?: unknown; kid?: unknown } | undefined;
    try {
      kept = readJson<typeof kept>(saltFile(), undefined);
    } catch (e) {
      kept = { salt: firstLine(e) };
    }
    const reset = `run api-anything logout <site> for each site in ${join(home(), "sessions")}, delete the files in ${join(home(), "captures")} and ${join(home(), "snapshots")}, then log in again`;
    if (kept !== undefined && (typeof kept?.salt !== "string" || typeof kept.kid !== "string"))
      throw new SealError(
        `${saltFile()} is damaged, so the passphrase's key cannot be made`,
        `restore the original ${saltFile()} from a backup of this home; or, to start over, delete it, ${reset}`,
      );
    if (!kept && sealedKeys().includes("passphrase"))
      throw new SealError(
        `${saltFile()} is missing, but files here are sealed with a passphrase: a new salt would make another key`,
        `restore the original ${saltFile()} from a backup of this home; or, to start over, ${reset}`,
      );
    const salt = kept ? Buffer.from(kept.salt as string, "base64") : randomBytes(16);
    const key = scryptSync(pass.normalize("NFC"), salt, 32, SCRYPT);
    const kid = kidOf(key);
    if (kept && kept.kid !== kid)
      throw new SealError(
        "API_ANYTHING_KEY is not the passphrase this home's files were sealed with",
        `set API_ANYTHING_KEY to the passphrase used before; to start over, delete ${saltFile()}, ${reset}`,
      );
    if (!kept) writePrivate(saltFile(), `${JSON.stringify({ v: 1, salt: b64(salt), kid }, null, 1)}\n`);
    return { key, kid, source: "passphrase" };
  });
}

/** The store's key, made on first need. First writer wins: creation is locked, looked up again under the lock, and read back. */
function storeKey(store: KeyStore): DataKey {
  const k =
    store.get() ??
    keyLock(store.lock ?? join(home(), ACCOUNT), () => {
      const again = store.get();
      if (again) return again;
      store.put(randomBytes(32));
      const stored = store.get();
      if (!stored) throw new Error(`${store.name} did not keep the new key`);
      return stored;
    });
  return { key: k, kid: kidOf(k), source: store.name };
}

/** Where a key comes from, or why there is none; throws `SealError` when a key source exists and failed. */
function findKey(pass: string | undefined): DataKey | { none: string } {
  if (pass) {
    try {
      return passphraseKey(pass);
    } catch (e) {
      if (e instanceof SealError) throw e;
      throw new SealError(
        `the API_ANYTHING_KEY key could not be made: ${firstLine(e)}`,
        "fix the error, then retry; nothing was written",
      );
    }
  }
  const store = injected === undefined ? platformStore() : (injected ?? undefined);
  if (!store)
    return { none: process.env.NODE_TEST_CONTEXT ? "no key store in tests" : `no key store on ${process.platform}` };
  try {
    return storeKey(store);
  } catch (e) {
    if (e instanceof KeyUnavailable) return { none: firstLine(e) };
    if (e instanceof SealError) throw e;
    throw new SealError(
      `the ${store.name} key store failed: ${firstLine(e)}`,
      `make the ${store.name} key store answer (unlock it if it is locked), then retry; nothing was written`,
    );
  }
}

/**
 * The data key for this process, made in the OS store on first need. Undefined only when there is no
 * key store here and this home has never sealed a file: the one case that writes plaintext.
 * `sealedWith`: the key a file being opened names, for the message.
 */
function dataKey(sealedWith?: string): DataKey | undefined {
  const pass = process.env.API_ANYTHING_KEY;
  const id = `${home()}\0${pass ?? ""}`;
  let got = cache.get(id);
  if (!got) {
    got = findKey(pass);
    cache.set(id, got);
    if ("key" in got) migrate(got);
  }
  if ("key" in got) return got;
  const marker = readMarker();
  const keys = marker ? [] : sealedKeys();
  if (!marker && !keys.length) return undefined;
  const source = sealedWith ?? marker?.key ?? keys[0]!;
  throw new SealError(
    `this home's credential files are sealed with the ${source} key, which is not available here (${got.none}); nothing is written unsealed`,
    source === "passphrase"
      ? "set API_ANYTHING_KEY to the passphrase they were sealed with"
      : `run api-anything where the ${source} key store is available; or, to start over unsealed here, delete ${markerFile()} and the files in ${join(home(), "sessions")}, ${join(home(), "captures")} and ${join(home(), "snapshots")}, then log in again`,
  );
}

/** Whether credential files are sealed here, and if not, why. Makes the key on first need, as a save would. */
export function sealing(): Sealing {
  const k = dataKey();
  if (k) {
    migrate(k); // a long-lived process (the MCP server) retries a migration that left files, as status says
    return { sealed: true, key: k.source };
  }
  const got = cache.get(`${home()}\0${process.env.API_ANYTHING_KEY ?? ""}`);
  return { sealed: false, why: got && "none" in got ? got.none : "no key", chosen: chosePlaintext() };
}

/** Whether a file's text (all of it, or only its start) is sealed. */
export function isSealedText(text: string): boolean {
  return text.startsWith(MAGIC);
}

function sealWith(k: DataKey, text: string, label: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(label));
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  const env: Envelope = {
    sealed: SEALED,
    alg: "A256GCM",
    key: k.source,
    kid: k.kid,
    iv: b64(iv),
    tag: b64(c.getAuthTag()),
    data: b64(data),
  };
  return `${MAGIC}${JSON.stringify(env)}`;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const bytes = (v: unknown, n?: number): Buffer | undefined => {
  if (typeof v !== "string" || !BASE64.test(v)) return undefined;
  const b = Buffer.from(v, "base64");
  return n === undefined || b.length === n ? b : undefined;
};

function open(text: string, file: string, label: string, next: string): string {
  const broken = (why: string) =>
    new SealError(`${file} failed its integrity check (${why}): it was changed or damaged after it was sealed`, next);
  let env: Partial<Envelope>;
  try {
    env = JSON.parse(text.slice(MAGIC.length));
  } catch {
    throw broken("its envelope is not JSON");
  }
  if (!env || typeof env !== "object") throw broken("its envelope is not an object");
  if (env.sealed !== SEALED || env.alg !== "A256GCM")
    throw new SealError(
      `${file} failed its integrity check: its marker (${String(env.sealed)}, ${String(env.alg)}) is not one this version reads`,
      `upgrade api-anything if a newer version wrote it; otherwise ${next}`,
    );
  const iv = bytes(env.iv, 12);
  const tag = bytes(env.tag, 16);
  const data = bytes(env.data);
  if (!iv || !tag || !data || typeof env.kid !== "string" || typeof env.key !== "string")
    throw broken("its iv, tag, data or key id is malformed");
  const k = dataKey(env.key);
  if (!k)
    throw new SealError(
      `${file} is sealed with the ${env.key} key, which is not available here`,
      env.key === "passphrase" ? "set API_ANYTHING_KEY to the passphrase it was sealed with" : next,
    );
  if (k.kid !== env.kid)
    throw new SealError(
      `${file} was sealed with another key (${env.key}) than the one in use (${k.source})`,
      env.key === "passphrase"
        ? "set API_ANYTHING_KEY to the passphrase it was sealed with"
        : k.source === "passphrase"
          ? `unset API_ANYTHING_KEY to read it with the ${env.key} key, or ${next}`
          : next,
    );
  try {
    const d = createDecipheriv("aes-256-gcm", k.key, iv, { authTagLength: 16 });
    d.setAAD(Buffer.from(label));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    throw broken("its tag does not match");
  }
}

/** A plaintext file's value. One that carries a `sealed` field is an envelope that lost its first line, not a session. */
function plainValue<T>(text: string, file: string, next: string): T {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw corruptFile(file);
  }
  if (v && typeof v === "object" && "sealed" in v)
    throw new SealError(
      `${file} failed its integrity check: it carries a sealed marker (${String((v as Envelope).sealed)}) but is not a sealed file`,
      next,
    );
  return v as T;
}

/**
 * A JSON file that may be sealed, or plaintext from before sealing (or from a home with no key).
 * `label` binds the file to what it is (`session:<site>`), so one cannot be swapped for another.
 */
export function readSealed<T>(file: string, fallback: T, label: string, next: string): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
  if (!isSealedText(text)) return plainValue<T>(text, file, next);
  const inner = open(text, file, label, next);
  try {
    return JSON.parse(inner) as T;
  } catch {
    throw corruptFile(file);
  }
}

/** Write `text` sealed when there is a key, else as 0600 plaintext (and say so once); throws `SealError` when a key failed. */
export function writeSealed(file: string, text: string, label: string): void {
  const k = dataKey();
  if (k) {
    markSealed(k);
    writePrivate(file, sealWith(k, text, label));
    return;
  }
  if (!chosePlaintext() && !warned) {
    warned = true;
    const s = sealing();
    if (!s.sealed) listener?.(s.why);
  }
  writePrivate(file, text);
}

/** The warning a front end prints for `onPlaintext`. */
export const plaintextWarning = (why: string) =>
  `api-anything: sessions and captures are stored unsealed (0600 plaintext JSON): ${why}. ` +
  "Set API_ANYTHING_KEY to a passphrase to seal them, or API_ANYTHING_PLAINTEXT=1 to keep plaintext without this warning.";

/** The names of the plaintext files in sessions/ or captures/: what `status` reports. */
export function plaintextFiles(dir: "sessions" | "captures"): string[] {
  const d = join(home(), dir);
  try {
    return readdirSync(d)
      .filter((f) => {
        if (!f.endsWith(".json")) return false;
        try {
          return !isSealedText(head(join(d, f), MAGIC.length));
        } catch {
          return false;
        }
      })
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/** The plaintext session files under this home. */
export const plaintextSessions = () => plaintextFiles("sessions");

/** Seal one file written before sealing; false when it could not be (busy, corrupt, unwritable). */
function migrateOne(k: DataKey, file: string, label: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (isSealedText(text)) return true;
  plainValue(text, file, "");
  const { atime, mtime } = statSync(file);
  markSealed(k);
  writePrivate(file, sealWith(k, text, label));
  utimesSync(file, atime, mtime);
  return true;
}

/**
 * The first time a process has a key for a home whose migration is not done: seal the session,
 * capture and snapshot files written before sealing, in place. Each session and snapshot is re-read
 * and sealed under the lock its writers take, so an update made meanwhile is kept. A file that could not be sealed is left for
 * the next process (and `status` reports it); completion is recorded only when none is left.
 */
function migrate(k: DataKey): void {
  if (readMarker()?.migrated) return;
  try {
    pruneCaptures();
  } catch {
    // pruning is the next capture's job too
  }
  let left = 0;
  for (const [dir, kind] of DIRS) {
    let files: string[];
    try {
      files = readdirSync(join(home(), dir)).filter((f) => f.endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(home(), dir, f);
      const one = () => migrateOne(k, file, `${kind}:${f.slice(0, -5)}`);
      try {
        // sessions and snapshots are read-modify-written under a lock; a capture is written once
        const done = kind === "capture" ? one() : tryLock(file, one)?.value;
        if (!done) left++;
      } catch {
        left++; // a corrupt or unwritable file is left for its reader to report
      }
    }
  }
  // with no marker nothing was sealed here: nothing to record, and no reason to call this home sealed
  if (left || !existsSync(markerFile())) return;
  try {
    const m = readMarker();
    writePrivate(
      markerFile(),
      `${JSON.stringify({ v: 1, at: m?.at || new Date().toISOString(), key: m?.key ?? k.source, migrated: true })}\n`,
    );
  } catch {
    // a read-only home: tried again by the next process
  }
}
