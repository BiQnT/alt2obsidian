// Paths and env for the fake `claude` / `codex` in test/fixtures/bin.
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./bundle-ts.mjs";

export const FAKE_BIN = join(repo, "test/fixtures/bin");
export const FAKE_CLAUDE = join(FAKE_BIN, "claude");
export const FAKE_CODEX = join(FAKE_BIN, "codex");
export const FAKE_SHELL = join(FAKE_BIN, "fake-login-shell");

/** Fresh log/state files; sets the FAKE_CLI_* env for the child processes. */
export function fakeSession(mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "fake-cli-"));
  process.env.FAKE_CLI_LOG = join(dir, "log.jsonl");
  process.env.FAKE_CLI_STATE = join(dir, "state.json");
  process.env.FAKE_CLI_PIDFILE = join(dir, "pids");
  process.env.FAKE_CLI_MODE = mode;
  return {
    dir,
    calls: () =>
      existsSync(process.env.FAKE_CLI_LOG)
        ? readFileSync(process.env.FAKE_CLI_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    pids: () => (existsSync(process.env.FAKE_CLI_PIDFILE) ? readFileSync(process.env.FAKE_CLI_PIDFILE, "utf8").split(" ").map(Number) : []),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
