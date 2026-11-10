// Alt's SQLite store, for when Alt is not running, and for a running Alt
// 0.19.0+, whose local API serves no notes (spec 2.2, 4.1).
//
// The live files are never opened: the database and its -wal file are
// copied to a private temp folder first (APFS clones on macOS, so a large
// store copies instantly), and the copy is opened with SQLite writes
// disabled (`PRAGMA query_only`). The copy is opened read-write only so
// SQLite can replay the copied WAL into it; nothing is written back.
// While Alt runs, a copy older than RUNNING_COPY_MAX_AGE_MS is made again
// before a lecture is read, so an import sees what Alt wrote since.
//
// SQLite comes from Node's built-in `node:sqlite` (Node 22.5+; Obsidian
// 1.8+ desktop ships Electron with Node 22). No native module is bundled.
// Before reading, the schema is checked: the tables and columns this source
// needs must exist, otherwise it fails with a clear message.

import { closeSync, copyFileSync, constants, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activeProfileUserId, DbCandidate, dbCandidates } from "./altPaths";
import { bundleFromRows, ComponentRow, detailsFromComponents, FolderRow, NoteRow, toSummary } from "./altRows";
import { AltLocalSource, AltNoteDetails, AltNoteSummary, LectureBundle } from "./types";

/** Schema versions (`migrations.version`) this source was checked against. */
export const KNOWN_SCHEMA_VERSIONS = [40, 41];

/** With Alt running, a copy older than this is made again before a lecture's bundle is read. */
export const RUNNING_COPY_MAX_AGE_MS = 30_000;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  lecture_notes: ["id", "folder_id", "title", "lecture_date", "type", "updated_at", "deleted_at"],
  folders: ["id", "name", "parent_id", "deleted_at"],
  note_components: ["id", "note_id", "component_type", "title", "content_text", "metadata", "display_order", "file_inode", "deleted_at"],
  file_metadata: ["inode", "file_path"],
};

interface Statement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (path: string, options?: Record<string, unknown>) => Database;
}

export class AltDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AltDbError";
  }
}

/** `node:sqlite`, or a clear error when this Obsidian/Node has none. */
export function loadSqlite(): SqliteModule {
  const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  try {
    const mod = proc.getBuiltinModule?.("node:sqlite");
    if (mod) return mod as SqliteModule;
  } catch {
    // fall through to require
  }
  // Electron's renderer (Obsidian) has a global require; plain Node has getBuiltinModule above.
  const req = typeof window === "undefined" ? undefined : (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof req === "function") {
    try {
      return req("node:sqlite") as SqliteModule;
    } catch {
      // fall through
    }
  }
  throw new AltDbError(
    "이 Obsidian에는 내장 SQLite(node:sqlite)가 없어 Alt 데이터베이스를 읽을 수 없습니다. Obsidian 설치 파일을 최신으로 받으세요. Alt 0.18 이하라면 Alt를 실행해 로컬 API로 가져올 수도 있습니다."
  );
}

export interface SchemaInfo {
  version: number | null;
  known: boolean;
}

/** Throws AltDbError when a needed table or column is missing. */
export function checkSchema(db: Database): SchemaInfo {
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set((db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((r) => r.name));
    if (have.size === 0) {
      missing.push(`${table} 테이블`);
      continue;
    }
    for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  let version: number | null = null;
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM migrations").get() as { v: number | null } | undefined;
    version = typeof row?.v === "number" ? row.v : null;
  } catch {
    version = null;
  }
  if (missing.length > 0) {
    throw new AltDbError(
      `알 수 없는 Alt 데이터베이스 스키마입니다 (버전 ${version ?? "?"}, 없는 항목: ${missing.slice(0, 6).join(", ")}). Alt2Obs를 최신 버전으로 업데이트하세요. Alt 0.18 이하라면 Alt를 켜서 로컬 API로 가져올 수도 있습니다.`
    );
  }
  return { version, known: version !== null && KNOWN_SCHEMA_VERSIONS.includes(version) };
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).some((r) => r.name === column);
}

const SCOPE_TABLES = ["channel_members", "channels", "workspace_members", "workspaces", "workspace_access_snapshot", "workspace_access_snapshot_state"];

/**
 * Alt's row filter for what an account sees (its activeContentRowSql):
 * rows without a channel, plus rows of team channels the user belongs to
 * (active, not archived, in a workspace the user is an active member of,
 * and in the workspace access snapshot when there is one). The device
 * store (account null) shows only rows without a channel.
 */
export type ScopeSupport = "full" | "channel-only" | "none";

/**
 * `support`: "full" with channels and the membership tables, "channel-only"
 * when a store has channel_id but lacks a membership table (then only rows
 * without a channel are shown, never unchecked team rows), "none" without
 * channels (pre-sync store).
 */
export function activeContentSql(alias: string, accountId: string | null | undefined, support: ScopeSupport): string {
  const active = `${alias}.deleted_at IS NULL`;
  if (accountId === undefined || support === "none") return active;
  const space = `${alias}.channel_id`;
  if (accountId === null || support === "channel-only") return `${active} AND ${space} IS NULL`;
  const actor = `'${accountId.replace(/'/g, "''")}'`;
  const snapshot = `(NOT EXISTS(SELECT 1 FROM workspace_access_snapshot_state) OR ${space} IN (SELECT id FROM workspace_access_snapshot WHERE kind='team'))`;
  return `${active} AND (${space} IS NULL OR (${snapshot} AND ${space} IN (
    SELECT tm.channel_id FROM channel_members tm JOIN channels t ON t.id=tm.channel_id
    WHERE tm.user_id=${actor} AND t.deleted_at IS NULL AND t.archived_at IS NULL
    AND (t.workspace_id IS NULL OR t.workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id
      WHERE wm.user_id=${actor} AND wm.status='active' AND w.deleted_at IS NULL
    ))
  )))`;
}

/** Private copies older than this are left over from a crash and removed. */
const STALE_COPY_MS = 60 * 60 * 1000;

/** Folder name prefix of the private database copies. */
const COPY_PREFIX = "alt-to-obs-altdb-";
/** The prefix earlier versions (the 2.0.0 betas, plugin and Skill) used: their leftovers are swept too. */
const LEGACY_COPY_PREFIX = "alt2obs-altdb-";

export function sweepStaleCopies(tmpRoot: string, now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.startsWith(COPY_PREFIX) && !n.startsWith(LEGACY_COPY_PREFIX)) continue;
    const p = join(tmpRoot, n);
    try {
      if (now - statSync(p).mtimeMs > STALE_COPY_MS) {
        rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

export interface DbSourceOptions {
  userData: string;
  sqlite?: SqliteModule;
  /** Parent of the private copy folder (default: the OS temp folder). */
  tmpRoot?: string;
  /** Version of the running Alt, when it runs but its local API serves no notes (0.19.0+). Shown in the label. */
  altVersion?: string;
  /** Clock for the copy's age (tests). */
  now?: () => number;
}

/**
 * What changes when Alt checkpoints its store and starts the WAL over: the
 * main file's size and mtime, and the WAL header's checkpoint sequence and
 * salts (bytes 12 to 24), or the WAL's absence or length. Frames appended
 * to the WAL leave it unchanged (a torn tail is dropped by the checksums).
 * The header does not depend on file times, which Windows may not update
 * while Alt keeps the file open.
 */
export function storeStamp(file: string): string {
  const st = statSync(file);
  let wal = "none";
  try {
    const fd = openSync(`${file}-wal`, "r");
    try {
      const head = Buffer.alloc(12);
      const n = readSync(fd, head, 0, 12, 12);
      wal = n === 12 ? head.toString("hex") : `short:${n}`;
    } finally {
      closeSync(fd);
    }
  } catch {
    // no WAL
  }
  return `${st.size}:${st.mtimeMs}:${wal}`;
}

/**
 * Copies the store and its -wal. A checkpoint followed by a WAL restart
 * between the two copies would pair the main file with the wrong WAL, so
 * the copy is made again when the stamp changed; after 3 unsettled tries
 * it fails (the caller says to try again shortly).
 */
function copyStore(file: string, target: string): void {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const before = storeStamp(file);
    copyFileSync(file, target, constants.COPYFILE_FICLONE);
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${target}-wal`, constants.COPYFILE_FICLONE);
    else rmSync(`${target}-wal`, { force: true });
    if (storeStamp(file) === before) return;
  }
  throw new Error("Alt가 데이터베이스를 쓰는 중이라 일관된 사본을 만들지 못했습니다");
}

export class AltLocalDbSource implements AltLocalSource {
  readonly mode = "db" as const;
  schema: SchemaInfo;
  /** Which store file was copied (file name only). */
  readonly storeName: string;
  /** Status detail naming the store when the signed-in account is unknown ("" otherwise). */
  storeDetail = "";
  private accountId: string | null | undefined = undefined;
  private support: ScopeSupport = "none";
  private altVersion: string | null = null;
  /** Set while Alt runs: where a fresh copy comes from. */
  private refreshFrom: { file: string; sqlite: SqliteModule; tmpRoot: string; now: () => number } | null = null;
  private copiedAt = 0;

  private constructor(
    private db: Database,
    private copyDir: string,
    schema: SchemaInfo,
    storeName: string,
    private hasFileRefs: boolean
  ) {
    this.schema = schema;
    this.storeName = storeName;
  }

  /** "Alt 꺼짐 · DB 읽기", or "Alt 실행 중 · DB 읽기 (v0.20.0)" when Alt runs; an unknown schema is noted. */
  get label(): string {
    const v = this.altVersion ?? "";
    const notes = [/^\d/.test(v) ? `v${v}` : v, this.schema.known ? "" : `확인되지 않은 스키마 v${this.schema.version ?? "?"}`].filter(Boolean);
    return `${this.altVersion !== null ? "Alt 실행 중" : "Alt 꺼짐"} · DB 읽기${notes.length ? ` (${notes.join(", ")})` : ""}`;
  }

  private setScope(c: DbCandidate, userKnown: boolean): void {
    this.accountId = c.accountId;
    this.support = this.scopeSupport();
    if (!userKnown) this.storeDetail = `로그인 계정을 알 수 없어 가장 최근 저장소를 읽었습니다: ${this.storeName}`;
  }

  private scopeSupport(): ScopeSupport {
    // Stores without channels (pre-sync) have nothing to scope.
    const channels = ["lecture_notes", "folders", "note_components"].every((t) => hasColumn(this.db, t, "channel_id"));
    return !channels ? "none" : SCOPE_TABLES.every((t) => this.tableExists(t)) ? "full" : "channel-only";
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
  }

  private scope(alias: string): string {
    return activeContentSql(alias, this.accountId, this.support);
  }

  /**
   * Copies the best store (signed-in account first) to a temp folder and
   * opens the copy. A store without notes is skipped when another has some.
   */
  static open(opts: DbSourceOptions): AltLocalDbSource {
    const candidates = dbCandidates(opts.userData);
    if (candidates.length === 0) throw new AltDbError("Alt 데이터베이스를 찾지 못했습니다. Alt가 이 컴퓨터에 설치되어 있는지 확인하세요.");
    const userKnown = activeProfileUserId(opts.userData) !== null;
    sweepStaleCopies(opts.tmpRoot ?? tmpdir());
    const sqlite = opts.sqlite ?? loadSqlite();
    let fallback: AltLocalDbSource | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      const file = candidate.path;
      let source: AltLocalDbSource;
      try {
        source = AltLocalDbSource.openCopy(file, sqlite, opts.tmpRoot ?? tmpdir());
        source.setScope(candidate, userKnown);
        if (opts.altVersion !== undefined) {
          const now = opts.now ?? Date.now;
          source.altVersion = opts.altVersion;
          source.refreshFrom = { file, sqlite, tmpRoot: opts.tmpRoot ?? tmpdir(), now };
          source.copiedAt = now();
        }
      } catch (e) {
        // An unknown schema is fatal: an older store would show stale notes.
        if (e instanceof AltDbError) {
          fallback?.close();
          throw e;
        }
        // The best store failed (for example a copy torn by a checkpoint):
        // say so instead of silently reading an older store.
        if (file === candidates[0].path) {
          throw new AltDbError(`Alt 데이터베이스 사본을 열지 못했습니다 (${basename(file)}): ${e instanceof Error ? e.message : String(e)}. 잠시 뒤 다시 시도하세요.`);
        }
        lastError = e;
        continue;
      }
      let count: number;
      try {
        count = source.noteCount();
      } catch (e) {
        source.close();
        fallback?.close();
        throw new AltDbError(`Alt 데이터베이스 사본을 읽지 못했습니다 (${basename(file)}): ${e instanceof Error ? e.message : String(e)}. 잠시 뒤 다시 시도하세요.`);
      }
      if (count > 0) {
        fallback?.close();
        return source;
      }
      if (!fallback) fallback = source;
      else source.close();
    }
    if (fallback) return fallback;
    throw new AltDbError(`Alt 데이터베이스를 열지 못했습니다: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private static openCopy(file: string, sqlite: SqliteModule, tmpRoot: string): AltLocalDbSource {
    const dir = mkdtempSync(join(tmpRoot, COPY_PREFIX));
    try {
      const target = join(dir, basename(file));
      copyStore(file, target);
      const db = new sqlite.DatabaseSync(target);
      try {
        db.exec("PRAGMA query_only = 1");
        const schema = checkSchema(db);
        return new AltLocalDbSource(db, dir, schema, basename(file), hasColumn(db, "note_components", "file_ref_id"));
      } catch (e) {
        db.close();
        throw e;
      }
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Alt running: replaces a copy older than RUNNING_COPY_MAX_AGE_MS with a
   * fresh one of the same store. The source object stays the same, so a
   * caller in the middle of a scan keeps working (queries are synchronous).
   */
  private refreshIfStale(): void {
    const from = this.refreshFrom;
    if (!from || from.now() - this.copiedAt < RUNNING_COPY_MAX_AGE_MS) return;
    let fresh: AltLocalDbSource;
    try {
      fresh = AltLocalDbSource.openCopy(from.file, from.sqlite, from.tmpRoot);
    } catch (e) {
      // Alt changed its schema while running: say so rather than read old data.
      if (e instanceof AltDbError) throw e;
      // A copy that would not open or settle: the earlier copy is read, the next bundle tries again.
      console.warn("[Alt2Obs] a fresh copy of Alt's database failed, the earlier copy is used:", e);
      return;
    }
    // Swap first, then let the old copy go: a folder that cannot be removed
    // yet (Windows) leaves no closed handle behind; the next sweep removes it.
    const old = { db: this.db, dir: this.copyDir };
    this.db = fresh.db;
    this.copyDir = fresh.copyDir;
    this.hasFileRefs = fresh.hasFileRefs;
    this.schema = fresh.schema;
    this.support = this.scopeSupport();
    this.copiedAt = from.now();
    AltLocalDbSource.release(old.db, old.dir);
  }

  private static release(db: Database, dir: string): void {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.warn("[Alt2Obs] could not remove an old copy of Alt's database yet:", e);
    }
  }

  private noteCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM lecture_notes ln WHERE ${this.scope("ln")}`).get() as { c: number };
    return row.c;
  }

  private folderMap(): Map<string, FolderRow> {
    const rows = this.db.prepare(`SELECT f.id, f.name, f.parent_id FROM folders f WHERE ${this.scope("f")}`).all() as FolderRow[];
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, parent_id: r.parent_id }]));
  }

  async listNotes(): Promise<AltNoteSummary[]> {
    const folders = this.folderMap();
    const rows = this.db
      .prepare(`SELECT ln.id, ln.title, ln.type, ln.lecture_date, ln.folder_id, ln.updated_at FROM lecture_notes ln WHERE ${this.scope("ln")} ORDER BY ln.lecture_date DESC, ln.id DESC`)
      .all() as NoteRow[];
    return rows.map((r) => toSummary(r, folders));
  }

  private components(noteId: string): ComponentRow[] {
    // A file component's path: file_metadata via file_inode, else the synced
    // file (file_ref_id) through file_ref_local_files: its registered file's
    // path, else its cache path. Subqueries with LIMIT 1 keep one row per
    // component even when an inode or a ref has several matches.
    const refPath = this.hasFileRefs
      ? `(SELECT COALESCE(NULLIF(fm2.file_path, ''), NULLIF(fl.local_cache_path, ''))
            FROM file_ref_local_files fl LEFT JOIN file_metadata fm2 ON fm2.inode = fl.file_inode
           WHERE fl.file_ref_id = nc.file_ref_id ORDER BY fl.updated_at DESC LIMIT 1)`
      : "NULL";
    const sql = `SELECT nc.id, nc.note_id, nc.component_type, nc.title, nc.content_text, nc.metadata, nc.display_order,
                        ${this.hasFileRefs ? "nc.file_ref_id" : "NULL"} AS file_ref_id,
                        COALESCE((SELECT NULLIF(fm.file_path, '') FROM file_metadata fm WHERE fm.inode = nc.file_inode LIMIT 1), ${refPath}) AS file_path
                   FROM note_components nc
                  WHERE nc.note_id = ? AND ${this.scope("nc")}
                  ORDER BY nc.display_order, nc.component_type, nc.title, nc.id`;
    try {
      return this.db.prepare(sql).all(noteId) as ComponentRow[];
    } catch (e) {
      // file_ref_local_files missing in an older store: paths from file_metadata only.
      if (!this.hasFileRefs || !/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) throw e;
      this.hasFileRefs = false;
      return this.components(noteId);
    }
  }

  async noteDetails(id: string): Promise<AltNoteDetails> {
    return detailsFromComponents(this.components(id));
  }

  async getBundle(id: string): Promise<LectureBundle> {
    this.refreshIfStale();
    const note = this.db
      .prepare(`SELECT ln.id, ln.title, ln.type, ln.lecture_date, ln.folder_id, ln.updated_at FROM lecture_notes ln WHERE ln.id = ? AND ${this.scope("ln")}`)
      .get(id) as NoteRow | undefined;
    if (!note) throw new AltDbError("Alt 데이터베이스에서 이 노트를 찾지 못했습니다.");
    return bundleFromRows({
      note,
      folders: this.folderMap(),
      components: this.components(id),
      readFile: async (p) => {
        const buf = await readFile(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
    });
  }

  close(): void {
    // A closed source never makes a new copy.
    this.refreshFrom = null;
    try {
      this.db.close();
    } catch {
      // already closed
    }
    rmSync(this.copyDir, { recursive: true, force: true });
  }
}
