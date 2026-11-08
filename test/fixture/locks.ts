/**
 * Another process holding a lock, for tests. Run as a script it holds the lock beside a file until it
 * is killed (`hold <file>`), or takes the key lock three times, logging each entry and exit
 * (`race <file> <log> <go>`).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hold } from "../../src/lock.js";
import { keyLock } from "../../src/seal.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run this script in a child process. */
export function lockChild(...args: string[]): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", SELF, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** A child process that holds the lock beside `file`, once it holds it. */
export async function holdInChild(file: string): Promise<ChildProcess> {
  const p = lockChild("hold", file);
  const held = once(p.stdout!, "data").then(([chunk]) => String(chunk) === "held\n");
  const exited = once(p, "exit").then(() => false);
  if (!(await Promise.race([held, exited]))) throw new Error(`the child could not take the lock beside ${file}`);
  return p;
}

export async function kill(p: ChildProcess): Promise<void> {
  if (p.exitCode !== null || p.signalCode !== null) return;
  const exited = once(p, "exit");
  p.kill("SIGKILL");
  await exited;
}

/** Kill `pid` after `ms`, from another process: this one may be blocked waiting for its lock. */
export function killLater(pid: number, ms: number): ChildProcess {
  return spawn(process.execPath, ["-e", `setTimeout(() => process.kill(${pid}, "SIGKILL"), ${ms})`]);
}

if (process.argv[1] === SELF) {
  const [mode, file, log, go] = process.argv.slice(2) as [string, string, string, string];
  if (mode === "hold") {
    const r = hold(file, 0, () => {
      writeSync(1, "held\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // until killed
    });
    if (!r) process.exit(3);
  } else if (mode === "race") {
    while (!existsSync(go)) sleep(5);
    for (let i = 0; i < 3; i++)
      keyLock(
        file,
        () => {
          appendFileSync(log, "+");
          sleep(100);
          appendFileSync(log, "-");
        },
        10_000,
      );
  }
}
