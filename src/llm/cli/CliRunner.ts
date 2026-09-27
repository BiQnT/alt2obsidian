// Process layer shared by the Claude and Codex CLI providers (spec 4.2).
//
// - Binary lookup: settings path, then the cached result of a one-time
//   login-shell `command -v`, then common install folders, then a clear error.
//   Obsidian started from the Dock has neither the shell PATH nor nvm.
// - Processes start with `spawn(bin, args)`; no shell string is ever built
//   from user or prompt text. The prompt goes through stdin.
// - The child leads its own process group (`detached`), so timeout and
//   cancel kill the CLI together with anything it spawned.
// - The child's PATH gets the binary's folder first: `claude` and `codex`
//   are `#!/usr/bin/env node` scripts that need their own node.

import { spawn } from "child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join } from "path";
import type { CliName } from "../../types";

export const DEFAULT_CLI_TIMEOUT_MS = 300_000;
const KILL_GRACE_MS = 3000;
const STDERR_KEEP = 64 * 1024;
const STDOUT_MAX = 64 * 1024 * 1024;

export type CliFailureKind = "not-found" | "spawn" | "timeout" | "aborted" | "exit";

export class CliRunError extends Error {
  constructor(
    public kind: CliFailureKind,
    message: string,
    public stderr = "",
    public stdout = "",
    public exitCode: number | null = null
  ) {
    super(message);
    this.name = "CliRunError";
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof CliRunError && e.kind === "aborted";
}

export interface CliRunRequest {
  bin: string;
  args: string[];
  /** Written to stdin, then stdin is closed. */
  input?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra environment variables on top of process.env. */
  env?: Record<string, string>;
}

export interface CliRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/** PATH for the child: the binary's own folder first, then common folders. */
export function childPath(bin: string, basePath = process.env.PATH ?? ""): string {
  const dirs = [dirname(bin), ...basePath.split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return Array.from(new Set(dirs.filter((d) => d.length > 0))).join(":");
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Run a CLI to completion. Resolves on exit code 0; rejects with a
 * `CliRunError` on spawn failure, timeout, cancel, or a non-zero exit (the
 * error carries stdout and stderr so the caller can read a JSON error body).
 */
export function runCli(req: CliRunRequest): Promise<CliRunOutput> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new CliRunError("aborted", "취소되었습니다"));
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let failure: CliRunError | null = null;

    const child = spawn(req.bin, req.args, {
      cwd: req.cwd,
      env: { ...process.env, ...req.env, PATH: childPath(req.bin, req.env?.PATH ?? process.env.PATH) },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (err: CliRunError) => {
      if (failure || settled) return;
      failure = err;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => terminate(new CliRunError("timeout", `${Math.round(timeoutMs / 1000)}초 안에 응답이 없어 중단했습니다`, stderr, stdout)),
      timeoutMs
    );
    const onAbort = () => terminate(new CliRunError("aborted", "취소되었습니다", stderr, stdout));
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      req.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < STDOUT_MAX) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    // The CLI may exit before reading all of stdin (bad flag); ignore EPIPE.
    child.stdin?.on("error", () => undefined);

    child.on("error", (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          e.code === "ENOENT"
            ? new CliRunError("not-found", `실행 파일을 찾을 수 없습니다: ${req.bin}`)
            : new CliRunError("spawn", `프로세스를 시작하지 못했습니다: ${e.message}`)
        )
      );
    });
    child.on("close", (code) => {
      finish(() => {
        if (failure) {
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        const out = { stdout, stderr, exitCode: code, durationMs: Date.now() - started };
        if (code === 0) resolve(out);
        else
          reject(
            new CliRunError(
              "exit",
              `종료 코드 ${code}: ${lastLine(stderr) || lastLine(stdout) || "출력 없음"}`,
              stderr,
              stdout,
              code
            )
          );
      });
    });

    if (req.input !== undefined) child.stdin?.end(req.input);
    else child.stdin?.end();
  });
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

// ---- binary lookup ----

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveOptions {
  /** Absolute path from settings. "" = not set. */
  configuredPath: string;
  /** Path cached from an earlier lookup. */
  cachedPath?: string;
  /** Login shell used for `command -v` (default $SHELL, then /bin/zsh). */
  shell?: string;
  home?: string;
  shellTimeoutMs?: number;
  /** Replaces the common install folders (tests). */
  extraDirs?: string[];
}

export interface ResolvedCli {
  path: string;
  source: "settings" | "cache" | "login-shell" | "common-path";
}

export function cliNotFoundMessage(name: CliName): string {
  return (
    `${name} CLI를 찾지 못했습니다. 터미널에서 \`command -v ${name}\`로 경로를 확인한 뒤 ` +
    `설정 > LLM 연결에 절대 경로를 입력하거나 '다시 찾기'를 누르세요.`
  );
}

/** Folders where npm, Homebrew, nvm and the native installers put the CLIs. */
export function commonCliDirs(home: string): string[] {
  const dirs: string[] = [];
  const nvm = join(home, ".nvm/versions/node");
  try {
    const versions = readdirSync(nvm).sort((a, b) => compareVersions(b, a));
    for (const v of versions) dirs.push(join(nvm, v, "bin"));
  } catch {
    // no nvm
  }
  dirs.push(
    join(home, ".local/bin"),
    join(home, ".claude/local"),
    join(home, ".npm-global/bin"),
    join(home, ".volta/bin"),
    join(home, ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  );
  return dirs;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** One `command -v <name>` in an interactive login shell (loads .zprofile and .zshrc, where nvm lives). */
export async function lookupInLoginShell(name: CliName, shell: string, timeoutMs: number): Promise<string | null> {
  if (!/^[a-z]+$/.test(name)) return null;
  try {
    const out = await runCli({ bin: shell, args: ["-ilc", `command -v ${name}`], timeoutMs });
    const lines = out.stdout.split("\n").map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      if (isAbsolute(lines[i]) && isExecutable(lines[i])) return lines[i];
    }
  } catch {
    // shell failed or timed out; fall through to the folder scan
  }
  return null;
}

export async function resolveCliBinary(name: CliName, opts: ResolveOptions): Promise<ResolvedCli> {
  const configured = opts.configuredPath.trim();
  if (configured) {
    if (isAbsolute(configured) && isExecutable(configured)) return { path: configured, source: "settings" };
    throw new CliRunError("not-found", `설정한 ${name} 경로에서 실행 파일을 찾지 못했습니다: ${configured}`);
  }
  if (opts.cachedPath && isExecutable(opts.cachedPath)) return { path: opts.cachedPath, source: "cache" };

  const shell = opts.shell ?? (process.env.SHELL || "/bin/zsh");
  const fromShell = await lookupInLoginShell(name, shell, opts.shellTimeoutMs ?? 10_000);
  if (fromShell) return { path: fromShell, source: "login-shell" };

  for (const dir of opts.extraDirs ?? commonCliDirs(opts.home ?? homedir())) {
    const candidate = join(dir, name);
    if (existsSync(candidate) && isExecutable(candidate)) return { path: candidate, source: "common-path" };
  }
  throw new CliRunError("not-found", cliNotFoundMessage(name));
}

/** First line of `<bin> --version`, e.g. "2.1.283 (Claude Code)". */
export async function readCliVersion(bin: string, timeoutMs = 15_000): Promise<string> {
  const out = await runCli({ bin, args: ["--version"], timeoutMs });
  return out.stdout.trim().split("\n")[0] ?? "";
}

// ---- per-job work folder (spec 4.2 rule 3) ----

/**
 * Temp folder outside the vault used as the CLI's working directory, so no
 * project CLAUDE.md / AGENTS.md is picked up. Real path (macOS /var is a
 * symlink) so tool path checks agree with what we pass on the command line.
 */
export function createJobDir(prefix = "alt2obs-job-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function removeJobDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
