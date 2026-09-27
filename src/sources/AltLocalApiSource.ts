// Alt's local HTTP API (spec 2.2): 127.0.0.1:<port>, `Authorization: Bearer
// <token>`, responses `{ok, data}`. `/api/status` needs no token. Read-only
// use: GET routes only.
//
// The token is read from Alt's token file when a source is created and kept
// in memory only. It is never logged, stored or put in an error message.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { ALT_PORT_TRIES, readHttpServerConfig, tokenFilePath } from "./altPaths";
import { OwnerVerifier, systemOwnerVerifier } from "./altOwnership";
import { bundleFromRows, ComponentRow, detailsFromComponents, FolderRow, NoteRow, pickSlides, toSummary } from "./altRows";
import { AltLocalSource, AltNoteDetails, AltNoteSummary, LectureBundle } from "./types";

const HOST = "127.0.0.1";

export class AltApiError extends Error {
  constructor(message: string, public status: number | null) {
    super(message);
    this.name = "AltApiError";
  }
}

interface RawResponse {
  status: number;
  body: string;
}

function request(port: number, path: string, token: string | null, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ host: HOST, port, path, method: "GET", headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Alt's /api/status answer, or null when nothing (or something else) answers. */
export async function probeAltStatus(port: number, timeoutMs = 800): Promise<{ version: string } | null> {
  try {
    const res = await request(port, "/api/status", null, timeoutMs);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.body);
    const data = json?.data;
    if (json?.ok === true && data && data.ok === true && typeof data.version === "string") return { version: data.version };
    return null;
  } catch {
    return null;
  }
}

function flattenFolders(tree: unknown, out: Map<string, FolderRow>): void {
  if (!Array.isArray(tree)) return;
  for (const f of tree as Array<Record<string, unknown>>) {
    if (!f || typeof f.id !== "string") continue;
    out.set(f.id, { id: f.id, name: String(f.name ?? ""), parent_id: typeof f.parent_id === "string" ? f.parent_id : null });
    flattenFolders(f.children, out);
  }
}

function componentFromApi(raw: Record<string, unknown>): ComponentRow {
  const file = raw.file as { file_path?: unknown } | undefined;
  return {
    id: String(raw.id),
    note_id: String(raw.note_id),
    component_type: String(raw.component_type ?? ""),
    title: typeof raw.title === "string" ? raw.title : null,
    content_text: typeof raw.content_text === "string" ? raw.content_text : null,
    metadata: typeof raw.metadata === "string" ? raw.metadata : raw.metadata ? JSON.stringify(raw.metadata) : null,
    display_order: typeof raw.display_order === "number" ? raw.display_order : null,
    file_path: typeof file?.file_path === "string" ? file.file_path : null,
    file_ref_id: typeof raw.file_ref_id === "string" ? raw.file_ref_id : null,
  };
}

export interface ApiSourceOptions {
  port: number;
  token: string;
  version?: string;
  timeoutMs?: number;
  /**
   * Opens a copy of Alt's database for the local path of a synced slides
   * file the API gives no path for (the components route joins
   * file_metadata by inode only). Opened once, on first need, and closed
   * with this source.
   */
  openPathDb?: () => AltLocalSource;
  /** Re-checks who listens on the port (see `verifyOwner` in DetectOptions). */
  verifyOwner?: OwnerVerifier;
  /** The pid approved by the first check. */
  ownerPid?: number | null;
  /** Clock for the re-check interval (tests). */
  now?: () => number;
}

/**
 * The owner is checked again before every note list and bundle request, and
 * before a details request when the last check is older than this (the
 * sidebar asks for details note by note).
 */
export const OWNER_RECHECK_MS = 3000;

export interface DetectOptions {
  probeTimeoutMs?: number;
  /** Who listens on the port; the token is sent only when this says Alt. */
  verifyOwner?: OwnerVerifier;
  openPathDb?: () => AltLocalSource;
  now?: () => number;
}

export class AltLocalApiSource implements AltLocalSource {
  readonly mode = "api" as const;
  readonly label: string;
  private readonly port: number;
  private readonly token: string;
  private readonly timeoutMs: number;
  private folders: Map<string, FolderRow> | null = null;
  private readonly openPathDb?: () => AltLocalSource;
  private pathDb: AltLocalSource | null = null;
  private readonly pathMemo = new Map<string, string | null>();
  private readonly verifyOwner?: OwnerVerifier;
  private readonly ownerPid: number | null;
  private readonly now: () => number;
  private lastOwnerCheck: number;
  /** Set on a connection or ownership failure: the caller should connect again. */
  failed = false;

  constructor(opts: ApiSourceOptions) {
    this.openPathDb = opts.openPathDb;
    this.verifyOwner = opts.verifyOwner;
    this.ownerPid = opts.ownerPid ?? null;
    this.now = opts.now ?? Date.now;
    this.lastOwnerCheck = this.now();
    this.port = opts.port;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.label = `Alt 연결됨 · 로컬 API${opts.version ? ` (v${opts.version})` : ""}`;
  }

  /**
   * Finds a running Alt: /api/status on the configured port and the next
   * ones Alt falls back to. Null when Alt does not answer or the token file
   * cannot be read; `reason` says why.
   */
  static async detect(userData: string, opts: DetectOptions = {}): Promise<{ source: AltLocalApiSource | null; reason: string }> {
    const { port, enabled } = readHttpServerConfig(userData);
    const verify = opts.verifyOwner ?? systemOwnerVerifier();
    // The configured port first, then the ones Alt falls back to. The token
    // goes only to a listener verified as Alt run by this user; an
    // unverified port is skipped and never sees the token.
    let refused = "";
    for (let p = port; p < port + ALT_PORT_TRIES; p++) {
      const status = await probeAltStatus(p, opts.probeTimeoutMs ?? 800);
      if (!status) continue;
      const owner = await verify(p);
      if (!owner.ok) {
        refused = refused || owner.reason;
        continue;
      }
      let token: string;
      try {
        token = readFileSync(tokenFilePath(userData), "utf8").trim();
      } catch {
        return { source: null, reason: "Alt는 실행 중이지만 로컬 API 토큰 파일을 읽지 못했습니다." };
      }
      if (!token) return { source: null, reason: "Alt 로컬 API 토큰 파일이 비어 있습니다." };
      return {
        source: new AltLocalApiSource({ port: p, token, version: status.version, openPathDb: opts.openPathDb, verifyOwner: verify, ownerPid: owner.pid ?? null, now: opts.now }),
        reason: "",
      };
    }
    if (refused) return { source: null, reason: `로컬 API가 Alt인지 확인하지 못해 토큰을 보내지 않았습니다: ${refused}` };
    return {
      source: null,
      reason: enabled === false ? "Alt 설정에서 로컬 HTTP 서버가 꺼져 있습니다." : "Alt가 실행 중이 아니거나 로컬 API가 응답하지 않습니다.",
    };
  }

  /**
   * Before a request batch: when the last owner check is `maxAgeMs` old or
   * older, check again, and require the same pid as approved. On failure
   * nothing is sent and the source is marked failed.
   */
  private async ensureOwner(maxAgeMs: number): Promise<void> {
    if (this.failed) throw new AltApiError("Alt 로컬 API 연결이 끊겼습니다. 다시 연결하세요.", null);
    if (!this.verifyOwner || this.now() - this.lastOwnerCheck < maxAgeMs) return;
    const check = await this.verifyOwner(this.port);
    const samePid = this.ownerPid === null || check.pid === undefined || check.pid === this.ownerPid;
    if (!check.ok || !samePid) {
      this.failed = true;
      throw new AltApiError(`로컬 API 포트의 프로그램이 바뀌어 토큰을 보내지 않았습니다${check.ok ? "" : `: ${check.reason}`}`, null);
    }
    this.lastOwnerCheck = this.now();
  }

  private async get<T>(path: string): Promise<T> {
    let res: RawResponse;
    try {
      res = await request(this.port, path, this.token, this.timeoutMs);
    } catch (e) {
      this.failed = true;
      throw new AltApiError(`Alt 로컬 API에 연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, null);
    }
    if (res.status === 401) throw new AltApiError("Alt 로컬 API가 토큰을 거부했습니다. Alt를 다시 시작한 뒤 새로고침하세요.", 401);
    let json: { ok?: boolean; data?: unknown; error?: unknown };
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new AltApiError(`Alt 로컬 API 응답을 읽지 못했습니다 (HTTP ${res.status})`, res.status);
    }
    if (res.status !== 200 || json.ok !== true) {
      throw new AltApiError(`Alt 로컬 API 오류 (HTTP ${res.status}): ${typeof json.error === "string" ? json.error : "알 수 없음"}`, res.status);
    }
    return json.data as T;
  }

  private async folderMap(refresh = false): Promise<Map<string, FolderRow>> {
    if (this.folders && !refresh) return this.folders;
    const map = new Map<string, FolderRow>();
    flattenFolders(await this.get<unknown>("/api/folders/tree"), map);
    this.folders = map;
    return map;
  }

  async listNotes(): Promise<AltNoteSummary[]> {
    await this.ensureOwner(0);
    const [rows, folders] = await Promise.all([this.get<NoteRow[]>("/api/lectureNotes"), this.folderMap(true)]);
    if (!Array.isArray(rows)) throw new AltApiError("Alt 로컬 API의 노트 목록 형식이 예상과 다릅니다.", 200);
    return rows.filter((r) => r && typeof r.id === "string").map((r) => toSummary(r, folders));
  }

  private async components(id: string): Promise<ComponentRow[]> {
    const raw = await this.get<Array<Record<string, unknown>>>(`/api/noteComponents/note/${encodeURIComponent(id)}`);
    if (!Array.isArray(raw)) throw new AltApiError("Alt 로컬 API의 컴포넌트 형식이 예상과 다릅니다.", 200);
    return raw.map(componentFromApi);
  }

  /** Components, with the slides path filled in from the database for synced files. */
  private async componentsWithPaths(id: string): Promise<ComponentRow[]> {
    const components = await this.components(id);
    const slides = pickSlides(components);
    if (slides && !slides.file_path && slides.file_ref_id && this.openPathDb) {
      if (!this.pathMemo.has(id)) {
        let path: string | null = null;
        try {
          this.pathDb ??= this.openPathDb();
          path = (await this.pathDb.noteDetails(id)).pdfPath;
        } catch (e) {
          console.warn("[Alt2Obsidian] slides path lookup in the database failed:", e);
        }
        this.pathMemo.set(id, path);
      }
      slides.file_path = this.pathMemo.get(id) ?? null;
    }
    return components;
  }

  async noteDetails(id: string): Promise<AltNoteDetails> {
    await this.ensureOwner(OWNER_RECHECK_MS);
    return detailsFromComponents(await this.componentsWithPaths(id));
  }

  close(): void {
    this.pathDb?.close?.();
    this.pathDb = null;
  }

  async getBundle(id: string): Promise<LectureBundle> {
    await this.ensureOwner(0);
    const note = await this.get<NoteRow | null>(`/api/lectureNotes/${encodeURIComponent(id)}`);
    if (!note || typeof note.id !== "string") throw new AltApiError("Alt에서 이 노트를 찾지 못했습니다.", 404);
    const [folders, components] = await Promise.all([this.folderMap(), this.componentsWithPaths(id)]);
    return bundleFromRows({
      note,
      folders,
      components,
      readFile: async (p) => {
        const buf = await readFile(p);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      },
    });
  }
}
