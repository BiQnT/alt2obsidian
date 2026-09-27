// Process layer shared by the Claude and Codex CLI providers (spec 4.2).
//
// - Binary lookup: settings path, then the cached result of a one-time
//   lookup (macOS/Linux: login-shell `command -v`; Windows: `where`), then
//   common install folders, then a clear error. Obsidian started from the
//   Dock or the Start menu does not have the terminal's PATH.
// - Processes start with `spawn(command, args)`; no shell is used on any
//   platform and no shell string is built from user or prompt text. The
//   prompt goes through stdin.
// - Windows: npm installs `claude.cmd` / `codex.cmd` shims, which Node can
//   only run through cmd.exe. Instead the shim is read and its JavaScript
//   entry is run with node.exe directly (`node <script> ...args`). `.exe`
//   installs (Claude's native installer) run as they are. Windows get
//   `windowsHide`, and cancel kills the process tree with `taskkill /T /F`.
// - macOS/Linux: the child leads its own process group (`detached`), so
//   timeout and cancel kill the CLI together with anything it spawned.
// - The child's PATH gets the binary's folder first: `claude` and `codex`
//   are node scripts that need their own node.

import { spawn } from "child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import * as path from "path";
import type { CliName } from "../../types";

export const DEFAULT_CLI_TIMEOUT_MS = 300_000;
/** Wait after SIGTERM before SIGKILL; twice this, the run is rejected even without `close`. */
export const KILL_GRACE_MS = 3000;
const STDERR_KEEP = 64 * 1024;
const STDOUT_MAX = 64 * 1024 * 1024;

export type CliFailureKind = "not-found" | "spawn" | "timeout" | "aborted" | "exit";

export class CliRunError extends Error {
  /** Error text from the CLI's own error field (result event, turn.failed), never model output. */
  cliError = "";

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

/** `spawn` signature used here; replaced in tests to check the Windows path. */
export type SpawnFn = typeof spawn;

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
  /** Defaults: process.platform and child_process.spawn (tests override both). */
  platform?: NodeJS.Platform;
  spawnFn?: SpawnFn;
}

export interface CliRunOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

function pathLib(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/** PATH for the child: the binary's own folder first, then common folders. */
export function childPath(bin: string, basePath = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string {
  const P = pathLib(platform);
  const sep = platform === "win32" ? ";" : ":";
  const extra = platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const dirs = [P.dirname(bin), ...basePath.split(sep), ...extra];
  return Array.from(new Set(dirs.filter((d) => d.length > 0))).join(sep);
}

/** Environment with PATH replaced, keeping Windows' own spelling of the key ("Path"). */
function childEnv(req: CliRunRequest, platform: NodeJS.Platform): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...req.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[key] = childPath(req.bin, env[key] ?? "", platform);
  return env;
}

// ---- Windows shims ----

export interface SpawnTarget {
  command: string;
  /** Arguments placed before the caller's (the shim's script). */
  prefixArgs: string[];
}

/**
 * Windows join that keeps the folder's own separator style, so a path given
 * with forward slashes (also valid on Windows) stays usable as is.
 */
function winJoin(dir: string, ...parts: string[]): string {
  const joined = path.win32.join(dir, ...parts);
  return dir.includes("/") && !dir.includes("\\") ? joined.replace(/\\/g, "/") : joined;
}

/** The JavaScript entry of an npm `.cmd` shim, e.g. `"%dp0%\node_modules\@openai\codex\bin\codex.js" %*`. */
export function parseNpmCmdShim(content: string, shimDir: string): string | null {
  const m = content.match(/"%~?dp0%?\\?([^"%]+\.(?:js|mjs|cjs))"/i);
  return m ? winJoin(shimDir, m[1]) : null;
}

/** node.exe next to the shim, else the first node.exe on PATH. */
function findWindowsNode(shimDir: string, pathValue: string): string | null {
  for (const dir of [shimDir, ...pathValue.split(";")]) {
    if (!dir) continue;
    const candidate = winJoin(dir, "node.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * What to actually spawn for `bin`. POSIX: the binary itself. Windows:
 * `.exe` directly; `.cmd`/`.bat`/`.ps1`/extensionless npm shims resolved to
 * `node.exe <script>`. Throws (no shell fallback) when a shim cannot be read.
 */
export function resolveSpawnTarget(bin: string, platform: NodeJS.Platform = process.platform, pathValue = process.env.PATH ?? process.env.Path ?? ""): SpawnTarget {
  if (platform !== "win32") return { command: bin, prefixArgs: [] };
  const P = path.win32;
  const ext = P.extname(bin).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { command: bin, prefixArgs: [] };
  const base = ext ? bin.slice(0, -ext.length) : bin;
  if (!ext || ext === ".ps1") {
    if (existsSync(`${base}.exe`)) return { command: `${base}.exe`, prefixArgs: [] };
    if (existsSync(`${base}.cmd`)) return resolveSpawnTarget(`${base}.cmd`, platform, pathValue);
    throw new CliRunError("not-found", `실행할 수 있는 파일을 찾지 못했습니다: ${bin} (.exe 또는 .cmd가 필요합니다)`);
  }
  if (ext === ".cmd" || ext === ".bat") {
    let content = "";
    try {
      content = readFileSync(bin, "utf8");
    } catch {
      throw new CliRunError("not-found", `실행 파일을 찾을 수 없습니다: ${bin}`);
    }
    const script = parseNpmCmdShim(content, P.dirname(bin));
    if (!script) {
      throw new CliRunError("spawn", `npm 실행 스크립트(${bin})를 해석하지 못했습니다. 설정에 .exe 경로를 넣어 주세요.`);
    }
    const node = findWindowsNode(P.dirname(bin), pathValue);
    if (!node) throw new CliRunError("not-found", "node.exe를 찾지 못했습니다. Node.js가 설치되어 PATH에 있어야 합니다.");
    return { command: node, prefixArgs: [script] };
  }
  throw new CliRunError("spawn", `지원하지 않는 실행 파일 형식입니다: ${bin}`);
}

/**
 * Kill the CLI and its children. Windows: `taskkill /T /F`; when taskkill
 * cannot start or exits non-zero, `child.kill()` ends at least the direct
 * child. POSIX: signal to the process group.
 */
function killTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, platform: NodeJS.Platform, spawnFn: SpawnFn, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === "win32") {
    const fallback = () => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    try {
      const tk = spawnFn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", fallback);
      tk.on("close", (code: number | null) => {
        if (code !== 0) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }
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
  const platform = req.platform ?? process.platform;
  const spawnFn = req.spawnFn ?? spawn;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new CliRunError("aborted", "취소되었습니다"));
      return;
    }
    let target: SpawnTarget;
    const env = childEnv(req, platform);
    try {
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      target = resolveSpawnTarget(req.bin, platform, env[pathKey] ?? "");
    } catch (e) {
      reject(e);
      return;
    }
    let settled = false;
    let stdout = "";
    let stderr = "";
    let failure: CliRunError | null = null;

    const child = spawnFn(target.command, [...target.prefixArgs, ...req.args], {
      cwd: req.cwd,
      env,
      detached: platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = (err: CliRunError) => {
      if (failure || settled) return;
      failure = err;
      killTree(child, platform, spawnFn, "SIGTERM");
      if (platform !== "win32") killTimer = setTimeout(() => killTree(child, platform, spawnFn, "SIGKILL"), KILL_GRACE_MS);
      // Reject even if the process never reports `close` (a stuck kill).
      giveUpTimer = setTimeout(() => {
        const f = failure!;
        finish(() => {
          f.stdout = stdout;
          f.stderr = stderr;
          reject(f);
        });
      }, KILL_GRACE_MS * 2);
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
      if (giveUpTimer) clearTimeout(giveUpTimer);
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
    child.on("close", (code: number | null) => {
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

export function isExecutable(file: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return existsSync(file);
  try {
    accessSync(file, constants.X_OK);
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
  /** Login shell used for `command -v` (default $SHELL, then /bin/zsh). Not used on Windows. */
  shell?: string;
  home?: string;
  shellTimeoutMs?: number;
  /** Replaces the common install folders (tests). */
  extraDirs?: string[];
  platform?: NodeJS.Platform;
  /** Spawn used for the lookup commands (tests). */
  spawnFn?: SpawnFn;
  /** Environment for the Windows folders (%APPDATA% ...). Default process.env. */
  env?: Record<string, string | undefined>;
}

export interface ResolvedCli {
  path: string;
  source: "settings" | "cache" | "login-shell" | "where" | "common-path";
}

export function cliNotFoundMessage(name: CliName, platform: NodeJS.Platform = process.platform): string {
  const how = platform === "win32" ? `명령 프롬프트에서 \`where ${name}\`` : `터미널에서 \`command -v ${name}\``;
  return `${name} CLI를 찾지 못했습니다. ${how}로 경로를 확인한 뒤 설정 > LLM 연결에 절대 경로를 입력하거나 '다시 찾기'를 누르세요.`;
}

/** Folders where npm, Homebrew, nvm and the native installers put the CLIs. */
export function commonCliDirs(home: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string[] {
  if (platform === "win32") {
    const dirs: string[] = [];
    if (env.APPDATA) dirs.push(winJoin(env.APPDATA, "npm"));
    dirs.push(winJoin(home, ".local", "bin"));
    if (env.LOCALAPPDATA) dirs.push(winJoin(env.LOCALAPPDATA, "Programs", "claude"), winJoin(env.LOCALAPPDATA, "npm"));
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
    if (env.ProgramFiles) dirs.push(winJoin(env.ProgramFiles, "nodejs"));
    return dirs;
  }
  const dirs: string[] = [];
  const nvm = path.posix.join(home, ".nvm/versions/node");
  try {
    const versions = readdirSync(nvm).sort((a, b) => compareVersions(b, a));
    for (const v of versions) dirs.push(path.posix.join(nvm, v, "bin"));
  } catch {
    // no nvm
  }
  dirs.push(
    path.posix.join(home, ".local/bin"),
    path.posix.join(home, ".claude/local"),
    path.posix.join(home, ".npm-global/bin"),
    path.posix.join(home, ".volta/bin"),
    path.posix.join(home, ".bun/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  );
  return dirs;
}

/** File names a CLI can have in a folder: `.exe` before the npm `.cmd` shim on Windows. */
function candidateNames(name: CliName, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
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
export async function lookupInLoginShell(name: CliName, shell: string, timeoutMs: number, spawnFn?: SpawnFn): Promise<string | null> {
  if (!/^[a-z]+$/.test(name)) return null;
  try {
    const out = await runCli({ bin: shell, args: ["-ilc", `command -v ${name}`], timeoutMs, spawnFn });
    const lines = out.stdout.split("\n").map((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      if (path.posix.isAbsolute(lines[i]) && isExecutable(lines[i])) return lines[i];
    }
  } catch {
    // shell failed or timed out; fall through to the folder scan
  }
  return null;
}

/**
 * `where <name>` on Windows: `.exe` hits first, then `.cmd` shims.
 * Limitation: where.exe prints paths in the console code page, and Node
 * reads them as UTF-8, so a path with non-ASCII characters (a Korean user
 * name) can come back garbled. Such hits fail `existsSync` and are skipped;
 * the folder scan below builds the same paths from environment variables,
 * which Node decodes correctly. No shell or `chcp` is used to change this.
 */
export async function lookupWithWhere(name: CliName, timeoutMs: number, spawnFn?: SpawnFn): Promise<string | null> {
  if (!/^[a-z]+$/.test(name)) return null;
  try {
    const out = await runCli({ bin: "where.exe", args: [name], timeoutMs, platform: "win32", spawnFn });
    const hits = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    return hits.find((h) => /\.exe$/i.test(h)) ?? hits.find((h) => /\.cmd$/i.test(h)) ?? null;
  } catch {
    return null;
  }
}

export async function resolveCliBinary(name: CliName, opts: ResolveOptions): Promise<ResolvedCli> {
  const platform = opts.platform ?? process.platform;
  const P = pathLib(platform);
  const configured = opts.configuredPath.trim();
  if (configured) {
    if (P.isAbsolute(configured) && isExecutable(configured, platform)) return { path: configured, source: "settings" };
    throw new CliRunError("not-found", `설정한 ${name} 경로에서 실행 파일을 찾지 못했습니다: ${configured}`);
  }
  if (opts.cachedPath && isExecutable(opts.cachedPath, platform)) return { path: opts.cachedPath, source: "cache" };

  if (platform === "win32") {
    const found = await lookupWithWhere(name, opts.shellTimeoutMs ?? 10_000, opts.spawnFn);
    if (found) return { path: found, source: "where" };
  } else {
    const shell = opts.shell ?? (process.env.SHELL || "/bin/zsh");
    const fromShell = await lookupInLoginShell(name, shell, opts.shellTimeoutMs ?? 10_000, opts.spawnFn);
    if (fromShell) return { path: fromShell, source: "login-shell" };
  }

  for (const dir of opts.extraDirs ?? commonCliDirs(opts.home ?? homedir(), platform, opts.env)) {
    for (const file of candidateNames(name, platform)) {
      const candidate = platform === "win32" ? winJoin(dir, file) : P.join(dir, file);
      if (existsSync(candidate) && isExecutable(candidate, platform)) return { path: candidate, source: "common-path" };
    }
  }
  throw new CliRunError("not-found", cliNotFoundMessage(name, platform));
}

/** First line of `<bin> --version`, e.g. "2.1.283 (Claude Code)". */
export async function readCliVersion(bin: string, timeoutMs = 15_000): Promise<string> {
  const out = await runCli({ bin, args: ["--version"], timeoutMs });
  return out.stdout.trim().split("\n")[0] ?? "";
}

/**
 * Free login check, no model call (review H2): `claude auth status` prints
 * JSON with `loggedIn`; `codex login status` exits 0 when logged in.
 */
export async function probeCliLogin(name: CliName, bin: string, timeoutMs = 20_000): Promise<boolean> {
  try {
    if (name === "claude") {
      const out = await runCli({ bin, args: ["auth", "status", "--json"], timeoutMs });
      return JSON.parse(out.stdout).loggedIn === true;
    }
    // runCli resolves only on exit code 0; the message must also start a line with "Logged in".
    const out = await runCli({ bin, args: ["login", "status"], timeoutMs });
    return /^Logged in\b/m.test(`${out.stdout}\n${out.stderr}`);
  } catch {
    return false;
  }
}

// ---- per-job work folder (spec 4.2 rule 3) ----

/**
 * Temp folder outside the vault used as the CLI's working directory, so no
 * project CLAUDE.md / AGENTS.md is picked up. Real path (macOS /var is a
 * symlink) so paths agree with what we pass on the command line.
 */
export function createJobDir(prefix = "alt2obs-job-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeJobDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
