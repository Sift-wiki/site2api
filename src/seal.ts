/**
 * Files that hold credential values (session jars, captures) are sealed with AES-256-GCM under one
 * 32-byte data key. The key lives in the OS store (macOS Keychain, Linux Secret Service, Windows
 * DPAPI) or comes from the `API_ANYTHING_KEY` passphrase. With neither, files stay 0600 plaintext
 * and the caller is told once.
 */
import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { delimiter, join } from "node:path";
import { home, pruneCaptures, readJson, withLock, writePrivate } from "./session.js";

/** The format marker a sealed file starts with; a later format gets another number. */
export const SEALED = "api-anything/1";
const SERVICE = "api-anything";
const ACCOUNT = "data-key";
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Where the data key is kept. `get` answers undefined when the store holds none, and throws when it cannot answer. */
export interface KeyStore {
  /** shown in messages and recorded in each sealed file: "macos-keychain", "secret-tool", "dpapi" */
  readonly name: string;
  get(): Buffer | undefined;
  /** store a new key; must not replace one another process stored meanwhile (it is read back after) */
  put(key: Buffer): void;
}

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

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 15_000 });
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
 * The login Keychain through /usr/bin/security. An item `security` adds lists `security` itself as a
 * trusted application in its access control, so a later `find-generic-password` by the same binary
 * reads it without a dialog. The secret goes in on stdin (`security -i`), never on the command line.
 */
export const macosKeychain = (bin = "/usr/bin/security"): KeyStore => ({
  name: "macos-keychain",
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

/** The Secret Service through libsecret's `secret-tool`, when it is installed and a session bus answers. */
export const secretTool = (): KeyStore => ({
  name: "secret-tool",
  get() {
    if (!onPath("secret-tool")) throw new Error("secret-tool is not installed");
    if (!process.env.DBUS_SESSION_BUS_ADDRESS && !existsSync(`/run/user/${process.getuid?.()}/bus`))
      throw new Error("no D-Bus session bus");
    const r = run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT]);
    if (r.status === 0 && r.stdout.trim()) return decodeKey(r.stdout, "the Secret Service");
    // a lookup that finds nothing exits 1 quietly; anything on stderr is a bus or keyring failure
    if (r.status === 1 && !r.stderr.trim()) return undefined;
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
const cache = new Map<string, DataKey | { none: string } | { error: SealError }>();
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

/** The passphrase's key: scrypt under this home's salt, made on first use, with the key id that tells a wrong passphrase. */
function passphraseKey(pass: string): DataKey {
  return withLock(saltFile(), () => {
    const kept = readJson<{ salt?: string; kid?: string } | undefined>(saltFile(), undefined);
    const salt = kept?.salt ? Buffer.from(kept.salt, "base64") : randomBytes(16);
    const key = scryptSync(pass.normalize("NFC"), salt, 32, SCRYPT);
    const kid = kidOf(key);
    if (kept?.kid && kept.kid !== kid)
      throw new SealError(
        "API_ANYTHING_KEY is not the passphrase this home's files were sealed with",
        `set API_ANYTHING_KEY to the passphrase used before; to start over, delete ${saltFile()} and the files in ${join(home(), "sessions")} and ${join(home(), "captures")}, then log in again`,
      );
    if (!kept?.kid) writePrivate(saltFile(), `${JSON.stringify({ v: 1, salt: b64(salt), kid }, null, 1)}\n`);
    return { key, kid, source: "passphrase" };
  });
}

function storeKey(store: KeyStore): DataKey {
  const k =
    store.get() ??
    withLock(join(home(), "data-key"), () => {
      const again = store.get();
      if (again) return again;
      store.put(randomBytes(32));
      const stored = store.get();
      if (!stored) throw new Error(`${store.name} did not keep the new key`);
      return stored;
    });
  return { key: k, kid: kidOf(k), source: store.name };
}

/** The data key for this process, made in the OS store on first need; undefined when there is none to be had. */
function dataKey(): DataKey | undefined {
  const pass = process.env.API_ANYTHING_KEY;
  const id = `${home()}\0${pass ?? ""}`;
  let got = cache.get(id);
  if (!got) {
    try {
      if (pass) got = passphraseKey(pass);
      else {
        const store = injected === undefined ? platformStore() : (injected ?? undefined);
        got = store
          ? storeKey(store)
          : { none: process.env.NODE_TEST_CONTEXT ? "no key store in tests" : `no key store on ${process.platform}` };
      }
    } catch (e) {
      got = e instanceof SealError ? { error: e } : { none: (e as Error).message.split("\n")[0]! };
    }
    cache.set(id, got);
    if ("key" in got) migrate(got);
  }
  if ("error" in got) throw got.error;
  return "key" in got ? got : undefined;
}

/** Whether credential files are sealed here, and if not, why. Makes the key on first need, as a save would. */
export function sealing(): Sealing {
  const k = dataKey();
  if (k) return { sealed: true, key: k.source };
  const got = cache.get(`${home()}\0${process.env.API_ANYTHING_KEY ?? ""}`);
  return { sealed: false, why: got && "none" in got ? got.none : "no key", chosen: chosePlaintext() };
}

const isEnvelope = (v: unknown): v is Envelope =>
  !!v &&
  typeof v === "object" &&
  typeof (v as Envelope).sealed === "string" &&
  (v as Envelope).sealed.startsWith("api-anything/");

/** Whether a file's text is a sealed envelope (of any version). */
export function isSealedText(text: string): boolean {
  if (!text.startsWith('{"sealed":')) return false;
  try {
    return isEnvelope(JSON.parse(text));
  } catch {
    return false;
  }
}

function sealWith(k: DataKey, text: string, label: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k.key, iv);
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
  return JSON.stringify(env);
}

function open(env: Envelope, file: string, label: string, next: string): string {
  if (env.sealed !== SEALED || env.alg !== "A256GCM")
    throw new SealError(
      `${file} is sealed in a format this version does not read (${env.sealed})`,
      "upgrade api-anything",
    );
  const k = dataKey();
  if (!k) {
    const s = sealing();
    throw new SealError(
      `${file} is sealed with the ${env.key} key, which is not available here${s.sealed ? "" : ` (${s.why})`}`,
      env.key === "passphrase" ? "set API_ANYTHING_KEY to the passphrase it was sealed with" : next,
    );
  }
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
    const d = createDecipheriv("aes-256-gcm", k.key, Buffer.from(env.iv, "base64"));
    d.setAAD(Buffer.from(label));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new SealError(`${file} failed its integrity check: it was changed or damaged after it was sealed`, next);
  }
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
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is corrupt (${(e as Error).message}); fix or delete it`);
  }
  if (!isEnvelope(v)) return v as T;
  const inner = open(v, file, label, next);
  try {
    return JSON.parse(inner) as T;
  } catch (e) {
    throw new Error(`${file} is corrupt (${(e as Error).message}); fix or delete it`);
  }
}

/** Write `text` sealed when there is a key, else as 0600 plaintext (and say so once). */
export function writeSealed(file: string, text: string, label: string): void {
  const k = dataKey();
  if (k) {
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

/** The plaintext session files under this home: what `status` reports while sealing is off. */
export function plaintextSessions(): string[] {
  const dir = join(home(), "sessions");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !isSealedText(readFileSync(join(dir, f), "utf8").slice(0, 64)))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * Once per home, the first time a key is had: seal the session and capture files written before
 * sealing, in place. Captures keep their modification time, which their 24 h pruning reads. No lock
 * is taken (a caller may hold a session's lock already); a file another process sealed meanwhile is
 * left as it is.
 */
function migrate(k: DataKey): void {
  if (existsSync(markerFile())) return;
  try {
    pruneCaptures();
    for (const [dir, kind] of [
      ["sessions", "session"],
      ["captures", "capture"],
    ] as const) {
      let files: string[];
      try {
        files = readdirSync(join(home(), dir)).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        const file = join(home(), dir, f);
        try {
          const text = readFileSync(file, "utf8");
          if (isSealedText(text)) continue;
          JSON.parse(text);
          const { atime, mtime } = statSync(file);
          writePrivate(file, sealWith(k, text, `${kind}:${f.slice(0, -5)}`));
          if (kind === "capture") utimesSync(file, atime, mtime);
        } catch {
          // a corrupt or vanished file is left for its reader to report
        }
      }
    }
    writePrivate(markerFile(), `${JSON.stringify({ v: 1, at: new Date().toISOString(), key: k.source })}\n`);
  } catch {
    // a read-only home: tried again by the next process
  }
}
