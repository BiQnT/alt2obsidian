// Where Alt keeps its local data (read only; spec 2.2, 4.1).
//
//   <userData>/http-server-token              Bearer token of the local API (0600)
//   <userData>/storage-httpServer.json         {"enabled", "port", ...}
//   <userData>/storage-desktopSync.json        {"activeProfileUserId", ...}
//   <userData>/data/database/
//     powersync-store.account-<sha256(userId)[:16]>.db   signed-in data (desktop sync on)
//     powersync-store.db                                device store
//     lecture_notes.db                                  pre-sync store (schema v12 to v40)
//
// Alt switched its data backing to the PowerSync store (same tables) when
// desktop sync became the default; lecture_notes.db then stops changing.
// userData follows Electron: ~/Library/Application Support/alt (macOS),
// %APPDATA%\alt (Windows), $XDG_CONFIG_HOME/alt or ~/.config/alt (Linux).

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ALT_DEFAULT_PORT = 45623;
/** Alt tries the configured port and the next 9 when one is taken. */
export const ALT_PORT_TRIES = 10;

export function altUserDataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "alt");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "alt");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "alt");
}

export function tokenFilePath(userData: string): string {
  return join(userData, "http-server-token");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Port and enabled flag of Alt's local HTTP server. The same file holds the
 * token: only these two fields are taken from it.
 */
export function readHttpServerConfig(userData: string): { port: number; enabled: boolean | null } {
  const json = readJson(join(userData, "storage-httpServer.json"));
  const port = typeof json?.port === "number" && json.port > 0 && json.port < 65536 ? json.port : ALT_DEFAULT_PORT;
  const enabled = typeof json?.enabled === "boolean" ? json.enabled : null;
  return { port, enabled };
}

/** Database files to try, best first. Only existing files are returned. */
export function dbCandidates(userData: string): string[] {
  const dir = join(userData, "data", "database");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const active = readJson(join(userData, "storage-desktopSync.json"))?.activeProfileUserId;
  if (typeof active === "string" && active) {
    const digest = createHash("sha256").update(active).digest("hex").slice(0, 16);
    out.push(join(dir, `powersync-store.account-${digest}.db`));
  }
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    names = [];
  }
  const accounts = names
    .filter((n) => /^powersync-store\.account-[0-9a-f]+\.db$/.test(n))
    .map((n) => join(dir, n))
    .sort((a, b) => mtime(b) - mtime(a));
  out.push(...accounts, join(dir, "powersync-store.db"), join(dir, "lecture_notes.db"));
  return Array.from(new Set(out)).filter((p) => existsSync(p));
}

function mtime(path: string): number {
  try {
    const wal = `${path}-wal`;
    return Math.max(statSync(path).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0);
  } catch {
    return 0;
  }
}
