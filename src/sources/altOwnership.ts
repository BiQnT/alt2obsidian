// Who listens on a local port (spec 8, token handling): the Alt API token
// is only sent to a socket that belongs to Alt, run by this user. Anything
// else on 127.0.0.1 (another program squatting Alt's port or a fallback
// port) never sees the token.
//
// macOS:   lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fpcu, then ps -o comm= for
//          the executable path (must be inside an Alt.app bundle).
// Linux:   /proc/net/tcp{,6} for the listening socket inode, the /proc/<pid>/fd
//          entry that holds it, /proc/<pid>/status for the uid, and
//          /proc/<pid>/exe for the executable.
// Windows: %SystemRoot%\System32\netstat.exe -ano -p TCP for the pid, then
//          tasklist.exe /V for the image name (Alt.exe) and the user name
//          (must be this user; "N/A" means not verified).
// Every tool runs with an argument array, never through a shell.

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

export interface Owner {
  pid: number;
  uid: number | null;
  /** Executable path (macOS, Linux) or image name (Windows). */
  exe: string;
  /** Windows: the process's user name from tasklist ("DOMAIN\\user" or "N/A"). */
  user?: string;
}

export interface OwnerCheck {
  ok: boolean;
  reason: string;
  /** The listener's pid when known. */
  pid?: number;
}

export type OwnerVerifier = (port: number) => Promise<OwnerCheck>;

function run(bin: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // lsof exits 1 when nothing matches; its (empty) output is still the answer.
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

/** `lsof -F pcu` output: one record per process (p = pid, c = command, u = uid). */
export function parseLsof(out: string): Array<{ pid: number; uid: number | null; command: string }> {
  const res: Array<{ pid: number; uid: number | null; command: string }> = [];
  let cur: { pid: number; uid: number | null; command: string } | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const val = line.slice(1).trim();
    if (tag === "p") {
      cur = { pid: Number(val), uid: null, command: "" };
      res.push(cur);
    } else if (cur && tag === "u") cur.uid = Number(val);
    else if (cur && tag === "c") cur.command = val;
  }
  return res.filter((r) => Number.isInteger(r.pid) && r.pid > 0);
}

/** Inodes of sockets listening on 127.0.0.1 / any address at `port` in /proc/net/tcp{,6}. */
export function parseProcNetTcp(table: string, port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [, local, , state] = f;
    // State 0A = LISTEN.
    if (state === "0A" && local.toUpperCase().endsWith(`:${hexPort}`)) inodes.push(f[9]);
  }
  return inodes;
}

/** PID listening on 127.0.0.1:<port> (or any address) in `netstat -ano -p TCP` output. */
export function parseNetstat(out: string, port: number): number | null {
  for (const line of out.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0].toUpperCase() !== "TCP") continue;
    const local = f[1];
    if (!/^(127\.0\.0\.1|0\.0\.0\.0):\d+$/.test(local) || Number(local.split(":")[1]) !== port) continue;
    if (f[3].toUpperCase() !== "LISTENING") continue;
    const pid = Number(f[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** `tasklist /V /FO CSV /NH`: image name (field 1) and user name (field 7). */
export function parseTasklist(out: string): { image: string; user: string } | null {
  const line = out.trim().split(/\r?\n/)[0] ?? "";
  const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  if (fields.length < 7) return null;
  return { image: fields[0], user: fields[6] };
}

/** A tasklist user name ("DOMAIN\\user") matches this account; "N/A" never does. */
export function isSameWindowsUser(user: string, me: string): boolean {
  if (!user || /^n\/a$/i.test(user.trim())) return false;
  const name = user.split("\\").pop() ?? "";
  return name.toLowerCase() === me.toLowerCase();
}

/** Alt's executable: inside an Alt.app bundle (macOS), Alt.exe (Windows), or an alt binary (Linux). */
export function isAltExecutable(exe: string, platform: NodeJS.Platform): boolean {
  if (platform === "darwin") return /\/Alt\.app\/Contents\//.test(exe);
  if (platform === "win32") return /^alt\.exe$/i.test(exe.split(/[\\/]/).pop() ?? "");
  const base = exe.split("/").pop() ?? "";
  return /^alt$/i.test(base) || /\/alt\//i.test(exe);
}

async function ownerDarwin(port: number): Promise<Owner | null> {
  const out = await run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"]);
  const procs = parseLsof(out);
  if (procs.length !== 1) return null;
  const exe = (await run("/bin/ps", ["-p", String(procs[0].pid), "-o", "comm="])).trim();
  return { pid: procs[0].pid, uid: procs[0].uid, exe };
}

function ownerLinux(port: number): Owner | null {
  const inodes = new Set<string>();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      for (const i of parseProcNetTcp(readFileSync(f, "utf8"), port)) inodes.add(i);
    } catch {
      // no IPv6 table
    }
  }
  if (inodes.size === 0) return null;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target = "";
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = target.match(/^socket:\[(\d+)\]$/);
      if (!m || !inodes.has(m[1])) continue;
      const uidLine = readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m);
      return { pid: Number(pid), uid: uidLine ? Number(uidLine[1]) : null, exe: readlinkSync(`/proc/${pid}/exe`) };
    }
  }
  return null;
}

function system32(exe: string): string {
  return join(process.env.SystemRoot || "C:\\Windows", "System32", exe);
}

async function ownerWindows(port: number): Promise<Owner | null> {
  const pid = parseNetstat(await run(system32("netstat.exe"), ["-ano", "-p", "TCP"]), port);
  if (pid === null) return null;
  const task = parseTasklist(await run(system32("tasklist.exe"), ["/V", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]));
  return task ? { pid, uid: null, exe: task.image, user: task.user } : null;
}

export async function portOwner(port: number, platform: NodeJS.Platform = process.platform): Promise<Owner | null> {
  if (platform === "darwin") return ownerDarwin(port);
  if (platform === "win32") return ownerWindows(port);
  return ownerLinux(port);
}

/** The default verifier: the port's listener is Alt, run by this user. */
export function systemOwnerVerifier(platform: NodeJS.Platform = process.platform): OwnerVerifier {
  return async (port) => {
    let owner: Owner | null;
    try {
      owner = await portOwner(port, platform);
    } catch (e) {
      return { ok: false, reason: `포트 ${port}의 프로그램을 확인하지 못했습니다 (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!owner) return { ok: false, reason: `포트 ${port}를 연 프로그램을 확인하지 못했습니다` };
    if (platform === "win32") {
      if (!isSameWindowsUser(owner.user ?? "", userInfo().username)) return { ok: false, reason: `포트 ${port}의 프로그램이 이 사용자로 실행됐는지 확인하지 못했습니다` };
    } else {
      // An unknown uid is not a match.
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (owner.uid === null || myUid === null || owner.uid !== myUid) return { ok: false, reason: `포트 ${port}의 프로그램이 이 사용자로 실행됐는지 확인하지 못했습니다` };
    }
    if (!isAltExecutable(owner.exe, platform)) return { ok: false, reason: `포트 ${port}의 프로그램이 Alt가 아닙니다 (${owner.exe.split(/[\\/]/).pop()})`, pid: owner.pid };
    return { ok: true, reason: "", pid: owner.pid };
  };
}
