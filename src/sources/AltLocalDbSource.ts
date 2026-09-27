// Alt's SQLite store, for when Alt is not running (spec 2.2, 4.1).
//
// The live files are never opened: the database and its -wal file are
// copied to a private temp folder first (APFS clones on macOS, so a large
// store copies instantly), and the copy is opened with SQLite writes
// disabled (`PRAGMA query_only`). The copy is opened read-write only so
// SQLite can replay the copied WAL into it; nothing is written back.
//
// SQLite comes from Node's built-in `node:sqlite` (Node 22.5+; Obsidian
// 1.8+ desktop ships Electron with Node 22). No native module is bundled.
// Before reading, the schema is checked: the tables and columns this source
// needs must exist, otherwise it fails with a clear message.

import { copyFileSync, constants, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { activeProfileUserId, DbCandidate, dbCandidates } from "./altPaths";
import { bundleFromRows, ComponentRow, detailsFromComponents, FolderRow, NoteRow, toSummary } from "./altRows";
import { AltLocalSource, AltNoteDetails, AltNoteSummary, LectureBundle } from "./types";

/** Schema versions (`migrations.version`) this source was checked against. */
export const KNOWN_SCHEMA_VERSIONS = [40];

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
  const req = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof req === "function") {
    try {
      return req("node:sqlite") as SqliteModule;
    } catch {
      // fall through
    }
  }
  throw new AltDbError(
    "이 Obsidian에는 내장 SQLite(node:sqlite)가 없어 Alt 데이터베이스를 읽을 수 없습니다. Obsidian 설치 파일을 최신으로 받거나, Alt를 실행해 로컬 API로 가져오세요."
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
      `알 수 없는 Alt 데이터베이스 스키마입니다 (버전 ${version ?? "?"}, 없는 항목: ${missing.slice(0, 6).join(", ")}). Alt를 실행해 로컬 API로 가져오세요.`
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
export function activeContentSql(alias: string, accountId: string | null | undefined, canScope: boolean): string {
  const active = `${alias}.deleted_at IS NULL`;
  if (accountId === undefined || !canScope) return active;
  const space = `${alias}.channel_id`;
  if (accountId === null) return `${active} AND ${space} IS NULL`;
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

export function sweepStaleCopies(tmpRoot: string, now = Date.now()): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (!n.startsWith("alt2obs-altdb-")) continue;
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
}

export class AltLocalDbSource implements AltLocalSource {
  readonly mode = "db" as const;
  readonly label: string;
  readonly schema: SchemaInfo;
  /** Which store file was copied (file name only). */
  readonly storeName: string;
  /** Status detail naming the store when the signed-in account is unknown ("" otherwise). */
  storeDetail = "";
  private accountId: string | null | undefined = undefined;
  private canScope = false;

  private constructor(
    private db: Database,
    private copyDir: string,
    schema: SchemaInfo,
    storeName: string,
    private hasFileRefs: boolean
  ) {
    this.schema = schema;
    this.storeName = storeName;
    this.label = `Alt 꺼짐 · DB 읽기${schema.known ? "" : ` (확인되지 않은 스키마 v${schema.version ?? "?"})`}`;
  }

  private setScope(c: DbCandidate, userKnown: boolean): void {
    this.accountId = c.accountId;
    // Stores without channels (pre-sync) have nothing to scope.
    this.canScope =
      ["lecture_notes", "folders", "note_components"].every((t) => hasColumn(this.db, t, "channel_id")) && SCOPE_TABLES.every((t) => this.tableExists(t));
    if (!userKnown) this.storeDetail = `로그인 계정을 알 수 없어 가장 최근 저장소를 읽었습니다: ${this.storeName}`;
  }

  private tableExists(name: string): boolean {
    return !!this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
  }

  private scope(alias: string): string {
    return activeContentSql(alias, this.accountId, this.canScope);
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
    const dir = mkdtempSync(join(tmpRoot, "alt2obs-altdb-"));
    try {
      const target = join(dir, basename(file));
      copyFileSync(file, target, constants.COPYFILE_FICLONE);
      if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${target}-wal`, constants.COPYFILE_FICLONE);
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
      if (!this.hasFileRefs) throw e;
      this.hasFileRefs = false;
      return this.components(noteId);
    }
  }

  async noteDetails(id: string): Promise<AltNoteDetails> {
    return detailsFromComponents(this.components(id));
  }

  async getBundle(id: string): Promise<LectureBundle> {
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
    try {
      this.db.close();
    } catch {
      // already closed
    }
    rmSync(this.copyDir, { recursive: true, force: true });
  }
}
