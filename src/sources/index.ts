// Source selection (spec 4.1): the local API when Alt answers, else a copy
// of Alt's database, else none (the URL tab still works).

import { AltLocalApiSource } from "./AltLocalApiSource";
import { AltLocalDbSource, SqliteModule } from "./AltLocalDbSource";
import { OwnerVerifier } from "./altOwnership";
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
  opts: { sqlite?: SqliteModule; tmpRoot?: string; probeTimeoutMs?: number; verifyOwner?: OwnerVerifier } = {}
): Promise<ConnectResult> {
  const dbOpts = { userData, sqlite: opts.sqlite, tmpRoot: opts.tmpRoot };
  const api = await AltLocalApiSource.detect(userData, {
    probeTimeoutMs: opts.probeTimeoutMs,
    verifyOwner: opts.verifyOwner,
    // Synced slides: the API has no path for them; one DB copy per connect does.
    openPathDb: () => AltLocalDbSource.open(dbOpts),
  });
  if (api.source) return { source: api.source, label: api.source.label, detail: "" };
  try {
    const db = AltLocalDbSource.open(dbOpts);
    return { source: db, label: db.label, detail: [api.reason, db.storeDetail].filter(Boolean).join(" ") };
  } catch (e) {
    return { source: null, label: "연결 안 됨", detail: `${api.reason} ${e instanceof Error ? e.message : String(e)}`.trim() };
  }
}
