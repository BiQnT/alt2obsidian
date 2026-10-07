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
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
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

/**
 * A store to try and the account whose notes it shows: a user id (signed-in
 * account store), null (device store, notes without a channel), or
 * undefined (unknown owner, or the pre-sync store: no account filter).
 */
export interface DbCandidate {
  path: string;
  accountId: string | null | undefined;
}

export function activeProfileUserId(userData: string): string | null {
  const active = readJson(join(userData, "storage-desktopSync.json"))?.activeProfileUserId;
  return typeof active === "string" && active ? active : null;
}

/**
 * Stores to try, best first; only existing files. With a known signed-in
 * user: that account's store, then the device and pre-sync stores, never
 * another account's store. Unknown user: account stores by recency.
 */
export function dbCandidates(userData: string): DbCandidate[] {
  const dir = join(userData, "data", "database");
  if (!existsSync(dir)) return [];
  const out: DbCandidate[] = [];
  const active = activeProfileUserId(userData);
  if (active) {
    const digest = createHash("sha256").update(active).digest("hex").slice(0, 16);
    out.push({ path: join(dir, `powersync-store.account-${digest}.db`), accountId: active });
  } else {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    names
      .filter((n) => /^powersync-store\.account-[0-9a-f]+\.db$/.test(n))
      .map((n) => join(dir, n))
      .sort((x, y) => mtime(y) - mtime(x))
      .forEach((path) => out.push({ path, accountId: undefined }));
  }
  out.push({ path: join(dir, "powersync-store.db"), accountId: null }, { path: join(dir, "lecture_notes.db"), accountId: undefined });
  return out.filter((c) => existsSync(c.path));
}

function mtime(path: string): number {
  try {
    const wal = `${path}-wal`;
    return Math.max(statSync(path).mtimeMs, existsSync(wal) ? statSync(wal).mtimeMs : 0);
  } catch {
    return 0;
  }
}

/**
 * The plugin's own cache folder outside any vault: ~/Library/Caches
 * (macOS), %LOCALAPPDATA% (Windows), $XDG_CACHE_HOME or ~/.cache (Linux).
 * Still named "alt2obsidian" after the rename to Alt2Obs (2.0.0), so the
 * transcripts and Notion pages cached before stay in use.
 */
export function pluginCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (platform === "darwin") return join(home, "Library", "Caches", "alt2obsidian");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "alt2obsidian", "Cache");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "alt2obsidian");
}
