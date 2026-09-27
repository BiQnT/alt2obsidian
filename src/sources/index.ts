// Source selection (spec 4.1): the local API when Alt answers, else a copy
// of Alt's database, else none (the URL tab still works).

import { AltLocalApiSource } from "./AltLocalApiSource";
import { AltLocalDbSource, SqliteModule } from "./AltLocalDbSource";
import { AltLocalSource } from "./types";

export * from "./types";
export { altUserDataDir } from "./altPaths";
export { inferSubject } from "./altRows";

export interface ConnectResult {
  source: AltLocalSource | null;
  /** Sidebar status line: "Alt 연결됨 · 로컬 API", "Alt 꺼짐 · DB 읽기", "연결 안 됨". */
  label: string;
  /** Why the better sources were not used ("" when the API is used). */
  detail: string;
}

export async function connectAltLocal(
  userData: string,
  opts: { sqlite?: SqliteModule; tmpRoot?: string; probeTimeoutMs?: number } = {}
): Promise<ConnectResult> {
  const api = await AltLocalApiSource.detect(userData, opts.probeTimeoutMs);
  if (api.source) return { source: api.source, label: api.source.label, detail: "" };
  try {
    const db = AltLocalDbSource.open({ userData, sqlite: opts.sqlite, tmpRoot: opts.tmpRoot });
    return { source: db, label: db.label, detail: api.reason };
  } catch (e) {
    return { source: null, label: "연결 안 됨", detail: `${api.reason} ${e instanceof Error ? e.message : String(e)}`.trim() };
  }
}
