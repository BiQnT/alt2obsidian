/**
 * Test: Alt local sources (spec 4.1) against fakes only: a fake Alt HTTP
 * server with a fake token, and synthetic SQLite stores built here (schema
 * shaped like Alt's v40 store, synthetic text). Also the plate-json
 * converter, transcript parsing, subject inference, the note status used by
 * the sidebar, and the alt-local.mjs Skill CLI. The real Alt app, its token
 * and its data are never touched.
 * Run: node test/test-sources.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";
import { FIXTURE_PATH } from "./helpers/synthetic-pdf.mjs";

const m = await importTs("test/helpers/sources-entry.ts");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const root = mkdtempSync(join(tmpdir(), "alt2obs-sources-"));
const FAKE_TOKEN = "fake-token-for-tests-0123456789";

// ---- plate-json to markdown ----
{
  const doc = [
    { type: "h1", children: [{ text: "캐시 개요" }] },
    { type: "p", children: [{ text: "캐시는 " }, { text: "빠른", bold: true }, { text: " 메모리이고 " }, { text: "SRAM", code: true }, { text: "으로 만든다." }] },
    { type: "p", listStyleType: "disc", indent: 1, children: [{ text: "시간 지역성", italic: true }] },
    { type: "p", listStyleType: "disc", indent: 2, children: [{ text: "반복문 변수" }] },
    { type: "p", listStyleType: "decimal", indent: 1, listStart: 1, children: [{ text: "첫째" }] },
    { type: "p", listStyleType: "decimal", indent: 1, children: [{ text: "둘째" }] },
    { type: "p", children: [{ text: "링크: " }, { type: "a", url: "https://example.com", children: [{ text: "예시" }] }, { text: " 참고" }] },
    { type: "blockquote", children: [{ text: "인용문" }] },
    { type: "code_block", lang: "c", children: [{ type: "code_line", children: [{ text: "int x = 1;" }] }, { type: "code_line", children: [{ text: "x++;" }] }] },
    { type: "hr", children: [{ text: "" }] },
    { type: "table", children: [
      { type: "tr", children: [{ type: "th", children: [{ type: "p", children: [{ text: "항목" }] }] }, { type: "th", children: [{ type: "p", children: [{ text: "값|값" }] }] }] },
      { type: "tr", children: [{ type: "td", children: [{ type: "p", children: [{ text: "hit" }] }] }, { type: "td", children: [{ type: "p", children: [{ text: "1 cycle" }] }] }] },
    ] },
    { type: "p", children: [{ text: "수식 " }, { type: "inline_equation", texExpression: "a^2", children: [{ text: "" }] }, { text: " 시각 " }, { type: "recording_timestamp", ms: 125000, children: [{ text: "" }] }] },
    { type: "equation", texExpression: "E=mc^2", children: [{ text: "" }] },
    { type: "strange_block", children: [{ text: "알 수 없는 블록의 글" }] },
  ];
  const md = m.plateToMarkdown(doc);
  assert.equal(
    md,
    [
      "# 캐시 개요",
      "",
      "캐시는 **빠른** 메모리이고 `SRAM`으로 만든다.",
      "",
      "- *시간 지역성*",
      "  - 반복문 변수",
      "1. 첫째",
      "2. 둘째",
      "",
      "링크: [예시](https://example.com) 참고",
      "",
      "> 인용문",
      "",
      "```c",
      "int x = 1;",
      "x++;",
      "```",
      "",
      "---",
      "",
      "| 항목 | 값\\|값 |",
      "| --- | --- |",
      "| hit | 1 cycle |",
      "",
      "수식 $a^2$ 시각 [02:05]",
      "",
      "$$",
      "E=mc^2",
      "$$",
      "",
      "알 수 없는 블록의 글",
    ].join("\n")
  );
  assert.equal(m.componentTextToMarkdown(JSON.stringify([{ type: "p", children: [{ text: "a*b" }] }]), '{"contentFormat":"plate-json"}'), "a\\*b");
  assert.equal(m.componentTextToMarkdown("plain memo", null), "plain memo");
  assert.equal(m.componentTextToMarkdown("[{broken", '{"contentFormat":"plate-json"}'), "[{broken");
  assert.equal(m.componentTextToMarkdown(null, null), "");
  // Containers, todos, and the raw-text fallback.
  const nested = [
    { type: "toggle", children: [{ type: "p", children: [{ text: "접힌 제목" }] }, { type: "p", children: [{ text: "접힌 내용" }] }] },
    { type: "callout", children: [{ type: "p", children: [{ text: "주의" }] }, { type: "p", children: [{ text: "시험 범위" }] }] },
    { type: "column_group", children: [{ type: "column", children: [{ type: "p", children: [{ text: "왼쪽" }] }] }, { type: "column", children: [{ type: "p", children: [{ text: "오른쪽" }] }] }] },
    { type: "p", listStyleType: "todo", indent: 1, checked: true, children: [{ text: "복습" }] },
    { type: "p", listStyleType: "todo", indent: 1, children: [{ text: "과제" }] },
    { type: "action_item", checked: false, children: [{ text: "질문하기" }] },
  ];
  assert.equal(
    m.plateToMarkdown(nested),
    ["접힌 제목", "", "접힌 내용", "", "> 주의", ">", "> 시험 범위", "", "왼쪽", "", "오른쪽", "", "- [x] 복습", "- [ ] 과제", "- [ ] 질문하기"].join("\n")
  );
  assert.equal(m.componentTextToMarkdown(JSON.stringify({ root: { children: [{ text: "다른 형식" }] } }), '{"contentFormat":"plate-json"}'), "다른 형식", "unknown shape: raw text kept");
  console.log("PASS: plate-json to markdown (headings, marks, indent lists, todos, links, quote, code, hr, table, equations, timestamps, containers, unknown blocks, raw-text fallback)");
}

// ---- transcript parsing and subject inference ----
{
  const raw = JSON.stringify([
    { createdAt: 1, relativeStart: 0, segments: [{ start: 0, end: 4000, text: " hello ", speaker: "" }, { start: 4000, end: 9000, text: "", speaker: "" }] },
    { createdAt: 2, relativeStart: 9000, segments: [{ start: 9000, end: 12000, text: "world", speaker: "A" }] },
    { createdAt: 3, relativeStart: 20000, originalText: "entry without segments" },
    { createdAt: 4, relativeStart: 26000, segments: [{ start: 26000, end: 30000, text: "last" }] },
  ]);
  assert.deepEqual(m.parseTranscript(raw), [
    { startMs: 0, endMs: 4000, text: "hello", speaker: "" },
    { startMs: 9000, endMs: 12000, text: "world", speaker: "A" },
    { startMs: 20000, endMs: 26000, text: "entry without segments", speaker: "" },
    { startMs: 26000, endMs: 30000, text: "last", speaker: "" },
  ]);
  assert.deepEqual(m.parseTranscript("not json"), []);
  assert.deepEqual(m.parseTranscript('{"a":1}'), []);
  assert.equal(m.inferSubject(["CSED311 컴퓨터구조"], "lec13"), "CSED311");
  assert.equal(m.inferSubject(["CSED 341"], "x"), "CSED341");
  assert.equal(m.inferSubject(["CSED312:OS", "Lectures"], "x"), "CSED312");
  assert.equal(m.inferSubject(["CSED5: 고급확률이론"], "x"), "CSED5");
  assert.equal(m.inferSubject(["데이터베이스"], "4강"), "데이터베이스");
  assert.equal(m.inferSubject([], "EECS 482 Lecture 3"), "EECS482");
  assert.equal(m.inferSubject([], "6강"), "미분류");
  assert.deepEqual(m.untimedSegments("a\n\n b \nc"), [
    { startMs: null, endMs: null, text: "a", speaker: "" },
    { startMs: null, endMs: null, text: "b", speaker: "" },
    { startMs: null, endMs: null, text: "c", speaker: "" },
  ]);
  console.log("PASS: transcript JSON to timed segments (segment times are recording-relative), subject from the Alt folder");
}

// ---- note status (sidebar chips, link candidates) ----
{
  assert.equal(m.slideChangeCount(["a", "b", "c"], ["a", "b", "c"]), 0);
  assert.equal(m.slideChangeCount(["a", "x", "c"], ["a", "b", "c"]), 1, "one changed slide");
  assert.equal(m.slideChangeCount(["a", "b", "c", "d"], ["a", "b", "c"]), 1, "one new slide");
  assert.equal(m.slideChangeCount(["a", "c"], ["a", "b", "c"]), 1, "one deleted slide");
  assert.equal(m.slideChangeCount(["d", "d"], ["d"]), 1, "duplicates are counted per copy");
  const note = { title: "CSED311 Lec13 MemoryHierarchy", lectureDate: "2026-04-21" };
  const v1 = { path: "A/CSED311/CSED311 Lec13 MemoryHierarchy.md", title: "CSED311 Lec13 MemoryHierarchy", altId: "pub1", altCreated: "2026-04-21T23:30:00Z" };
  assert.equal(m.isLinkCandidate(v1, note), true);
  assert.equal(m.isLinkCandidate({ ...v1, altCreated: "2026-05-02T00:00:00Z" }, note), false, "different date");
  assert.equal(m.isLinkCandidate({ ...v1, altCreated: undefined }, note), true, "no date: title decides");
  assert.equal(m.isLinkCandidate({ ...v1, altLocalId: "x" }, note), false, "already linked");
  assert.equal(m.isLinkCandidate({ ...v1, altId: undefined }, note), false, "not an Alt import");
  assert.equal(m.isLinkCandidate({ ...v1, title: "csed311 lec13-memoryhierarchy" }, { title: "lec13", lectureDate: "2026-04-21" }, "CSED311 Lec13-MemoryHierarchy.pdf"), true, "slides file name matches");
  assert.deepEqual(m.statusChip({ kind: "new" }), { text: "새 노트", cls: "is-new" });
  assert.deepEqual(m.statusChip({ kind: "imported", path: "p", changed: 3 }), { text: "슬라이드 3장 변경", cls: "is-changed" });
  assert.deepEqual(m.statusChip({ kind: "imported", path: "p", changed: 0 }), { text: "가져옴", cls: "is-imported" });
  assert.deepEqual(m.statusChip({ kind: "imported", path: "p", changed: null }), { text: "가져옴", cls: "is-imported" });
  assert.equal(m.statusChip({ kind: "link", candidates: [] }).text, "기존 노트와 연결?");
  console.log("PASS: note status: slide change count by text hash, link candidates by title and date, chips");
}

// ---- synthetic Alt store ----
const SCHEMA = `
CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT, channel_id TEXT, name TEXT, parent_id TEXT, path TEXT, color_hue INTEGER, created_at DATETIME, updated_at DATETIME, updated_hlc TEXT, deleted_at TEXT, schema_version INTEGER);
CREATE TABLE lecture_notes (id TEXT PRIMARY KEY, user_id TEXT, channel_id TEXT, folder_id TEXT, title TEXT, lecture_date DATE, status TEXT, type TEXT, is_favorite INTEGER, calendar_event_id TEXT, calendar_event_start TEXT, calendar_event_end TEXT, created_at DATETIME, updated_at DATETIME, updated_hlc TEXT, deleted_at TEXT, schema_version INTEGER);
CREATE TABLE note_components (id TEXT PRIMARY KEY, user_id TEXT, channel_id TEXT, note_id TEXT, component_type TEXT, title TEXT, file_inode BIGINT, content_text TEXT, metadata TEXT, display_order INTEGER, file_ref_id TEXT, created_at DATETIME, updated_at DATETIME, updated_hlc TEXT, deleted_at TEXT, schema_version INTEGER);
CREATE TABLE file_metadata (inode BIGINT PRIMARY KEY, file_path TEXT, file_name TEXT, file_size BIGINT, mime_type TEXT, hash_sha256 TEXT, created_at DATETIME, last_verified DATETIME);
CREATE TABLE file_ref_local_files (file_ref_id TEXT PRIMARY KEY, file_inode BIGINT, local_cache_path TEXT, created_at DATETIME, updated_at DATETIME);
CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at DATETIME);
CREATE TABLE channels (id TEXT PRIMARY KEY, workspace_id TEXT, deleted_at TEXT, archived_at TEXT);
CREATE TABLE channel_members (channel_id TEXT, user_id TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, deleted_at TEXT);
CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, status TEXT);
CREATE TABLE workspace_access_snapshot (kind TEXT, id TEXT);
CREATE TABLE workspace_access_snapshot_state (x INTEGER);
`;
const TRANSCRIPT = JSON.stringify([
  { createdAt: 1, relativeStart: 0, segments: [
    { start: 0, end: 5000, text: "today we start with an introduction to caches", speaker: "" },
    { start: 5000, end: 10000, text: "alpha is the first topic, caches are small and fast", speaker: "" },
  ] },
  { createdAt: 2, relativeStart: 10000, segments: [
    { start: 10000, end: 15000, text: "cache coherence keeps copies consistent", speaker: "" },
    { start: 15000, end: 20000, text: "the MESI protocol has four states for coherence", speaker: "" },
    { start: 20000, end: 25000, text: "beta slide shows MESI again", speaker: "" },
  ] },
  { createdAt: 3, relativeStart: 25000, segments: [
    { start: 25000, end: 30000, text: "in summary gamma, any questions about the summary", speaker: "" },
  ] },
]);
const plate = (text) => JSON.stringify([{ type: "h2", children: [{ text: "요약" }] }, { type: "p", children: [{ text }] }]);
const PLATE_META = '{"contentFormat":"plate-json","plateSchemaVersion":1}';

function buildStore(path, { version = 40, dropColumn = null, pdfPath, extraNote = null } = {}) {
  const db = new DatabaseSync(path);
  let schema = SCHEMA;
  if (dropColumn) schema = schema.replace(`, ${dropColumn} TEXT`, "");
  db.exec(schema);
  db.prepare("INSERT INTO migrations VALUES (?, '2026-09-14')").run(version);
  const f = db.prepare("INSERT INTO folders (id, name, parent_id, path) VALUES (?, ?, ?, ?)");
  f.run("f1", "CSED311 컴퓨터구조", null, "/");
  f.run("f2", "Lectures", "f1", "/CSED311 컴퓨터구조");
  const n = db.prepare("INSERT INTO lecture_notes (id, folder_id, title, lecture_date, type, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  n.run("n1", "f2", "Lec13 Caches", "2026-04-21", "slide", "2026-04-21 10:00:00", null);
  n.run("n2", null, "6강", "2026-09-23", "note", "2026-09-23 10:00:00", null);
  n.run("n3", "f1", "deleted note", "2026-01-01", "slide", null, "2026-02-01T00:00:00Z");
  n.run("n4", "f1", "Synced deck", "2026-05-01", "slide", null, null);
  if (extraNote) n.run(extraNote, "f1", "extra", "2026-06-01", "slide", null, null);
  // Team channels: the user is in "team-ok" (active workspace), not in "team-other".
  if (!dropColumn) {
    db.exec(`INSERT INTO workspaces VALUES ('w1', NULL);
      INSERT INTO workspace_members VALUES ('w1', 'user-123', 'active');
      INSERT INTO channels VALUES ('team-ok', 'w1', NULL, NULL), ('team-other', 'w1', NULL, NULL);
      INSERT INTO channel_members VALUES ('team-ok', 'user-123'), ('team-other', 'someone-else');`);
    const t = db.prepare("INSERT INTO lecture_notes (id, channel_id, folder_id, title, lecture_date, type) VALUES (?, ?, ?, ?, ?, 'slide')");
    t.run("n6", "team-ok", null, "Team lecture", "2026-06-10");
    t.run("n7", "team-other", null, "Not my team", "2026-06-11");
  }
  if (!dropColumn) {
    const c = db.prepare("INSERT INTO note_components (id, note_id, component_type, title, file_inode, content_text, metadata, display_order, file_ref_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    c.run("c1", "n1", "slides", "Lec13-Caches", 101, "Alpha Introduction to Caches", null, 0, null, null);
    c.run("c2", "n1", "transcript", "Transcript", null, TRANSCRIPT, '{"recordingSessionId":"s"}', 1, null, null);
    // A second (older) transcript and summary Alt does not display: ignored.
    c.run("c2b", "n1", "transcript", "Transcript", null, JSON.stringify([{ createdAt: 9, relativeStart: 0, segments: [{ start: 0, end: 3000, text: "an older recording", speaker: "" }] }]), null, 7, null, null);
    c.run("c3b", "n1", "summary", "Summary", null, plate("다른 요약"), PLATE_META, null, null, null);
    c.run("c3", "n1", "summary", "Summary", null, plate("캐시와 일관성"), PLATE_META, 2, null, null);
    c.run("c4", "n1", "slide_memo", "Slide 2", null, plate("MESI 외우기"), '{"slideIndex":2,"contentFormat":"plate-json"}', 3, null, null);
    c.run("c5", "n1", "memo", "메모", null, JSON.stringify([{ type: "p", children: [{ text: "" }] }]), PLATE_META, 4, null, null);
    c.run("c6", "n1", "summary", "old", null, plate("삭제된 요약"), PLATE_META, 5, null, "2026-05-01T00:00:00Z");
    c.run("c7", "n2", "transcript", "Transcript", null, JSON.stringify([{ createdAt: 1, relativeStart: 0, segments: [{ start: 0, end: 61000, text: "memo only lecture", speaker: "" }] }]), null, 0, null, null);
    c.run("c8", "n4", "slides", "Synced", null, null, null, 0, "ref-1", null);
    db.prepare("INSERT INTO file_metadata (inode, file_path, file_name) VALUES (101, ?, 'deck.pdf')").run(pdfPath);
    // Synced file: its registered file (inode 202) holds the path, the cache path is empty.
    db.prepare("INSERT INTO file_metadata (inode, file_path, file_name) VALUES (202, ?, 'deck.pdf')").run(pdfPath);
    db.prepare("INSERT INTO file_ref_local_files (file_ref_id, file_inode, local_cache_path, updated_at) VALUES ('ref-1', 202, '', '2026-05-01')").run();
  }
  return db;
}

function makeUserData(name, opts = {}) {
  const ud = join(root, name);
  const dbDir = join(ud, "data", "database");
  mkdirSync(dbDir, { recursive: true });
  const pdfPath = join(ud, "deck.pdf");
  copyFileSync(FIXTURE_PATH, pdfPath);
  const userId = "user-123";
  writeFileSync(join(ud, "storage-desktopSync.json"), JSON.stringify({ activeProfileUserId: userId, claim: {} }));
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  const store = join(dbDir, `powersync-store.account-${digest}.db`);
  const db = buildStore(store, { ...opts, pdfPath });
  if (opts.dropTable) db.exec(`DROP TABLE ${opts.dropTable}`);
  db.close();
  // Another account's store on this computer: never read while the signed-in user is known.
  const other = new DatabaseSync(join(dbDir, "powersync-store.account-ffffffffffffffff.db"));
  other.exec(SCHEMA);
  other.prepare("INSERT INTO lecture_notes (id, title, type) VALUES ('x1', 'other account', 'slide')").run();
  other.close();
  // A stale pre-sync store with other content: must not be preferred.
  const legacy = new DatabaseSync(join(dbDir, "lecture_notes.db"));
  legacy.exec(SCHEMA);
  legacy.prepare("INSERT INTO lecture_notes (id, title, type) VALUES ('old', 'stale', 'legacy')").run();
  legacy.close();
  return { ud, store, pdfPath };
}

const fileHash = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

try {
  // ---- database source ----
  {
    const { ud, store, pdfPath } = makeUserData("db-ok");
    // A write still in the WAL (Alt running and not checkpointed yet).
    const writer = new DatabaseSync(store);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.prepare("INSERT INTO lecture_notes (id, folder_id, title, lecture_date, type) VALUES ('n5', 'f1', 'only in the WAL', '2026-06-02', 'slide')").run();
    const before = { db: fileHash(store), wal: fileHash(`${store}-wal`), mtime: statSync(store).mtimeMs };
    assert.deepEqual(
      m.dbCandidates(ud).map((c) => [c.path.split("/").pop(), c.accountId]),
      [[store.split("/").pop(), "user-123"], ["lecture_notes.db", undefined]],
      "only the signed-in account's store, then the pre-sync store"
    );

    const src = m.AltLocalDbSource.open({ userData: ud, tmpRoot: root });
    assert.equal(src.mode, "db");
    assert.equal(src.label, "Alt 꺼짐 · DB 읽기");
    assert.deepEqual(src.schema, { version: 40, known: true });
    const notes = await src.listNotes();
    assert.deepEqual(notes.map((n) => n.id).sort(), ["n1", "n2", "n4", "n5", "n6"], "deleted note and other team's note hidden, WAL row visible, account store used");
    assert.equal(src.storeDetail, "", "known account: no store note");
    const n1 = notes.find((n) => n.id === "n1");
    assert.deepEqual(n1.folderPath, ["CSED311 컴퓨터구조", "Lectures"]);
    assert.equal(n1.lectureDate, "2026-04-21");
    assert.deepEqual(await src.noteDetails("n1"), { hasSlides: true, slidesTitle: "Lec13-Caches", pdfPath, transcriptMinutes: 1, timestamps: true });
    assert.equal((await src.noteDetails("n4")).pdfPath, pdfPath, "synced file path via file_ref_local_files");
    assert.equal((await src.noteDetails("n2")).hasSlides, false);

    const b = await src.getBundle("n1");
    assert.equal(b.sourceKind, "alt-local");
    assert.equal(b.sourceId, "n1");
    assert.equal(b.pdf.byteLength, statSync(FIXTURE_PATH).size);
    assert.equal(b.pdfPath, pdfPath);
    assert.equal(b.transcript.length, 6);
    assert.deepEqual(b.transcript[2], { startMs: 10000, endMs: 15000, text: "cache coherence keeps copies consistent", speaker: "" });
    assert.equal(b.summaryMarkdown, "## 요약\n\n캐시와 일관성", "deleted component skipped");
    assert.equal(b.memoMarkdown, "### 슬라이드 2 메모\n\n## 요약\n\nMESI 외우기", "empty memo skipped, slide memo kept");
    assert.deepEqual(b.warnings, []);
    await assert.rejects(src.getBundle("n3"), /찾지 못했습니다/);

    // The live files were only read.
    assert.deepEqual({ db: fileHash(store), wal: fileHash(`${store}-wal`), mtime: statSync(store).mtimeMs }, before, "store and WAL unchanged");
    src.close();
    writer.close();

    // Missing PDF file: the bundle says so and has no PDF.
    rmSync(pdfPath);
    const src2 = m.AltLocalDbSource.open({ userData: ud, tmpRoot: root });
    const b2 = await src2.getBundle("n1");
    assert.equal(b2.pdf, null);
    assert.match(b2.warnings[0], /슬라이드 PDF를 읽지 못했습니다/);
    src2.close();
    console.log("PASS: DB source: private copy with WAL replay, account store first, deleted rows hidden, folders, bundle, live files untouched");
  }
  {
    const { ud } = makeUserData("db-bad", { dropColumn: "content_text" });
    assert.throws(() => m.AltLocalDbSource.open({ userData: ud, tmpRoot: root }), (e) => e instanceof m.AltDbError && /알 수 없는 Alt 데이터베이스 스키마/.test(e.message) && /note_components\.content_text/.test(e.message));
    const { ud: ud2 } = makeUserData("db-newer", { version: 41 });
    const src = m.AltLocalDbSource.open({ userData: ud2, tmpRoot: root });
    assert.equal(src.label, "Alt 꺼짐 · DB 읽기 (확인되지 않은 스키마 v41)");
    assert.equal((await src.listNotes()).length, 4);
    src.close();
    assert.throws(() => m.AltLocalDbSource.open({ userData: join(root, "nothing"), tmpRoot: root }), /찾지 못했습니다/);
    assert.throws(() => m.AltLocalDbSource.open({ userData: ud2, tmpRoot: root, sqlite: { DatabaseSync: class { constructor() { throw new Error("boom"); } } } }), /사본을 열지 못했습니다 \(.*\): boom/);
    console.log("PASS: DB source fails clearly on an unknown schema, labels an unverified schema version");

    // Signed-in account unknown: newest account store, named in the status detail, no team filter possible.
    const { ud: ud3 } = makeUserData("db-unknown");
    rmSync(join(ud3, "storage-desktopSync.json"));
    const cands = m.dbCandidates(ud3).map((c) => c.accountId);
    assert.ok(cands.every((a) => a !== "user-123"), "no account id guessed");
    const src3 = m.AltLocalDbSource.open({ userData: ud3, tmpRoot: root });
    assert.match(src3.storeDetail, /로그인 계정을 알 수 없어 가장 최근 저장소를 읽었습니다: powersync-store\.account-/);
    src3.close();
    const c3 = await m.connectAltLocal(ud3, { tmpRoot: root, probeTimeoutMs: 200, verifyOwner: async () => ({ ok: true, reason: "" }) });
    assert.match(c3.detail, /가장 최근 저장소/);
    c3.source?.close();

    // Leftover private copies older than an hour are swept on the next open.
    const stale = join(root, "alt2obs-altdb-stale");
    mkdirSync(stale);
    const old = (Date.now() - 2 * 3600 * 1000) / 1000;
    utimesSync(stale, old, old);
    const fresh = join(root, "alt2obs-altdb-fresh");
    mkdirSync(fresh);
    m.AltLocalDbSource.open({ userData: ud2, tmpRoot: root }).close();
    assert.ok(!existsSync(stale) && existsSync(fresh), "stale copy removed, recent one kept");
    rmSync(fresh, { recursive: true });
    // A store with channels but a missing membership table: only rows without a channel.
    const { ud: ud4 } = makeUserData("db-partial-scope", { dropTable: "workspace_members" });
    const src4 = m.AltLocalDbSource.open({ userData: ud4, tmpRoot: root });
    assert.deepEqual((await src4.listNotes()).map((n) => n.id).sort(), ["n1", "n2", "n4"], "no team rows without the membership tables");
    src4.close();
    console.log("PASS: DB source account scoping: channel-only fallback, unknown account named in the status; stale private copies swept");
  }

  // ---- HTTP API source (fake Alt) ----
  const { ud: apiUd, pdfPath: apiPdf } = makeUserData("api");
  const requests = [];
  const folderTree = [{ id: "f1", name: "CSED311 컴퓨터구조", parent_id: null, children: [{ id: "f2", name: "Lectures", parent_id: "f1", children: [] }] }];
  const noteRows = [
    { id: "n1", title: "Lec13 Caches", type: "slide", lecture_date: "2026-04-21", folder_id: "f2", updated_at: "x", folder_name: "Lectures", folder_path: "/CSED311 컴퓨터구조" },
    { id: "n2", title: "6강", type: "note", lecture_date: "2026-09-23", folder_id: null, updated_at: "y", folder_name: "루트", folder_path: "/" },
  ];
  const components = [
    { id: "c1", note_id: "n1", component_type: "slides", title: "Lec13-Caches", file_inode: 101, content_text: "Alpha", metadata: null, display_order: 0, file: { inode: 101, file_path: apiPdf } },
    { id: "c2", note_id: "n1", component_type: "transcript", title: "Transcript", file_inode: null, content_text: TRANSCRIPT, metadata: null, display_order: 1 },
    { id: "c3", note_id: "n1", component_type: "summary", title: "Summary", file_inode: null, content_text: plate("캐시와 일관성"), metadata: PLATE_META, display_order: 2 },
  ];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/api/status") return send(200, { ok: true, data: { ok: true, version: "0.12.0", platform: "darwin", uptime: 1 } });
    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(401, { ok: false, error: "Unauthorized" });
    if (req.url === "/api/lectureNotes") return send(200, { ok: true, data: noteRows });
    if (req.url === "/api/folders/tree") return send(200, { ok: true, data: folderTree });
    if (req.url === "/api/lectureNotes/n1") return send(200, { ok: true, data: noteRows[0] });
    if (req.url === "/api/lectureNotes/nope") return send(200, { ok: true, data: null });
    if (req.url === "/api/noteComponents/note/n1") return send(200, { ok: true, data: components });
    if (req.url === "/api/noteComponents/note/n2") return send(200, { ok: true, data: [] });
    if (req.url === "/api/noteComponents/note/n4") return send(200, { ok: true, data: [{ id: "c8", note_id: "n4", component_type: "slides", title: "Synced", file_inode: null, file_ref_id: "ref-1", content_text: null, metadata: null, display_order: 0 }] });
    return send(404, { ok: false, error: `Not found: ${req.method} ${req.url}` });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // Alt keeps the token in this file too; only port and enabled are read from it.
  writeFileSync(join(apiUd, "storage-httpServer.json"), JSON.stringify({ enabled: true, port, token: "not-the-file-token" }));
  writeFileSync(m.tokenFilePath(apiUd), FAKE_TOKEN + "\n", { mode: 0o600 });
  try {
    assert.deepEqual(m.readHttpServerConfig(apiUd), { port, enabled: true });
    // Ownership checks, pure parsers first.
    assert.deepEqual(m.parseLsof("p4242\ncAlt\nu501\nf12\n"), [{ pid: 4242, uid: 501, command: "Alt" }]);
    assert.deepEqual(m.parseProcNetTcp("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:B3AF 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 98765 1\n   1: 0100007F:B3B0 00000000:0000 01 0 0 0 1000 0 11111 1\n", 45999), ["98765"]);
    assert.equal(m.parseNetstat("  TCP    127.0.0.1:45623        0.0.0.0:0              LISTENING       7788\r\n  TCP    127.0.0.1:45623        127.0.0.1:50000        ESTABLISHED     7788\r\n", 45623), 7788);
    assert.equal(m.parseNetstat("  TCP    127.0.0.1:45624  0.0.0.0:0  LISTENING  1", 45623), null);
    assert.deepEqual(m.parseTasklist('"Alt.exe","7788","Console","1","250,000 K","Running","PC\\kim","0:00:10","Alt"'), { image: "Alt.exe", user: "PC\\kim" });
    assert.equal(m.parseTasklist('"Alt.exe","7788","Console"'), null);
    assert.equal(m.isSameWindowsUser("PC\\Kim", "kim"), true);
    assert.equal(m.isSameWindowsUser("N/A", "kim"), false, "N/A is not verified");
    assert.equal(m.isSameWindowsUser("PC\\other", "kim"), false);
    assert.equal(m.isAltExecutable("/Applications/Alt.app/Contents/MacOS/Alt", "darwin"), true);
    assert.equal(m.isAltExecutable("/opt/homebrew/bin/node", "darwin"), false);
    assert.equal(m.isAltExecutable("/tmp/Alt.app.fake/node", "darwin"), false);
    assert.equal(m.isAltExecutable("Alt.exe", "win32"), true);
    assert.equal(m.isAltExecutable("node.exe", "win32"), false);
    assert.equal(m.isAltExecutable("/opt/alt/alt", "linux"), true);

    // Impostor: something that answers /api/status like Alt (this test's own
    // server, owned by node) never receives the token; the database is used.
    const verdict = await m.systemOwnerVerifier()(port);
    assert.equal(verdict.ok, false, "a node process is not Alt");
    const impostor = await m.connectAltLocal(apiUd, { tmpRoot: root });
    assert.equal(impostor.source.mode, "db");
    assert.match(impostor.detail, /토큰을 보내지 않았습니다/);
    impostor.source.close();
    assert.ok(requests.length > 0 && requests.every((r) => r.auth === null && r.url === "/api/status"), "only the unauthenticated status probe reached it");

    // A verified owner gets the token.
    const alt = async () => ({ ok: true, reason: "" });
    const det = await m.AltLocalApiSource.detect(apiUd, { verifyOwner: alt });
    assert.ok(det.source, det.reason);
    const api = det.source;
    assert.equal(api.label, "Alt 연결됨 · 로컬 API (v0.12.0)");
    const notes = await api.listNotes();
    assert.deepEqual(notes.map((n) => [n.id, n.folderPath.join("/")]), [["n1", "CSED311 컴퓨터구조/Lectures"], ["n2", ""]]);
    assert.equal((await api.noteDetails("n1")).pdfPath, apiPdf);
    const b = await api.getBundle("n1");
    assert.equal(b.title, "Lec13 Caches");
    assert.equal(b.pdf.byteLength, statSync(FIXTURE_PATH).size);
    assert.equal(b.transcript.length, 6);
    assert.equal(b.summaryMarkdown, "## 요약\n\n캐시와 일관성");
    await assert.rejects(api.getBundle("nope"), /찾지 못했습니다/);
    assert.ok(requests.every((r) => r.method === "GET"), "GET only");
    assert.ok(requests.filter((r) => r.url !== "/api/status").every((r) => r.auth === `Bearer ${FAKE_TOKEN}`), "token from the token file");
    assert.ok(requests.filter((r) => r.url === "/api/status").every((r) => r.auth === null), "status without a token");

    // Wrong token: a clear error that does not contain any token.
    const bad = new m.AltLocalApiSource({ port, token: "wrong-token" });
    await assert.rejects(bad.listNotes(), (e) => /토큰을 거부했습니다/.test(e.message) && !e.message.includes("wrong-token") && !e.message.includes(FAKE_TOKEN));

    // connectAltLocal prefers the API.
    const c = await m.connectAltLocal(apiUd, { tmpRoot: root, verifyOwner: alt });
    assert.equal(c.source.mode, "api");
    // A synced slides file (file_ref_id, no file in the API answer): its path comes from a DB copy.
    // One DB copy per connection, however many synced paths are looked up; closed with the source.
    const copies = () => readdirSync(root).filter((d) => d.startsWith("alt2obs-altdb-")).length;
    const before0 = copies();
    assert.equal((await c.source.noteDetails("n4")).pdfPath, apiPdf);
    assert.equal((await c.source.noteDetails("n4")).pdfPath, apiPdf);
    assert.equal(copies() - before0, 1, "one DB copy for path lookups");
    c.source.close();
    assert.equal(copies(), before0, "closed with the source");

    // Owner re-check: after 30 s the owner is checked again before a request
    // batch; a different pid means the token is not sent and the source fails.
    let clock = 1000000;
    let ownerPid = 111;
    const checker = async () => ({ ok: true, reason: "", pid: ownerPid });
    const guarded = (await m.AltLocalApiSource.detect(apiUd, { verifyOwner: checker, now: () => clock })).source;
    await guarded.listNotes();
    clock += 10000;
    ownerPid = 222;
    await guarded.noteDetails("n1");
    const sentBefore = requests.filter((r) => r.auth).length;
    clock += 31000;
    await assert.rejects(guarded.noteDetails("n1"), /프로그램이 바뀌어 토큰을 보내지 않았습니다/);
    assert.equal(requests.filter((r) => r.auth).length, sentBefore, "no token after the owner changed");
    assert.equal(guarded.failed, true);
    await assert.rejects(guarded.listNotes(), /다시 연결하세요/);
    assert.equal(requests.filter((r) => r.auth).length, sentBefore);
    assert.equal(c.label, "Alt 연결됨 · 로컬 API (v0.12.0)");
    console.log("PASS: API source: token only to a listener verified as Alt (impostor refused), status probe, folders tree, one DB copy for synced paths, owner re-check after 30 s (changed pid: no token), GET only, token never in errors");

    // Skill CLI (alt-local.mjs, same src/sources code) against the same
    // impostor: it refuses to send the token and reads the database copy.
    // Run asynchronously: the fake server lives in this process.
    const before = requests.length;
    const run = async (args) => (await promisify(execFile)("node", [join(repo, "scripts/phase2/alt-local.mjs"), ...args, "--alt-dir", apiUd], { encoding: "utf8" })).stdout;
    const cli = async (args) => JSON.parse(await run(args));
    const st = await cli(["status"]);
    assert.equal(st.mode, "db");
    assert.match(st.detail, /토큰을 보내지 않았습니다/);
    const listed = await cli(["list"]);
    assert.deepEqual(listed.notes.map((n) => [n.id, n.subject]).sort(), [["n1", "CSED311"], ["n2", "미분류"], ["n4", "CSED311"], ["n6", "미분류"]]);
    const exp = await cli(["export", "n1"]);
    assert.ok(exp.dir.startsWith(join(tmpdir(), "alt2obs-export-")), "private temp folder by default");
    assert.equal(statSync(exp.dir).mode & 0o777, 0o700);
    assert.equal(statSync(exp.bundle).mode & 0o777, 0o600);
    assert.equal(exp.pdfPath, apiPdf);
    assert.equal(exp.segments, 6);
    assert.equal(exp.timestamps, true);
    const bundleJson = JSON.parse(readFileSync(exp.bundle, "utf8"));
    assert.equal(bundleJson.subject, "CSED311");
    assert.equal(bundleJson.pdf, undefined, "no PDF bytes in bundle.json");
    assert.equal(bundleJson.transcript[3].startMs, 15000);
    assert.equal(readFileSync(join(exp.dir, "transcript.txt"), "utf8").split("\n").length, 6);
    rmSync(exp.dir, { recursive: true, force: true });
    const out = join(root, "export");
    const exp2 = JSON.parse((await promisify(execFile)("node", [join(repo, "scripts/phase2/alt-local.mjs"), "--source", "db", "--alt-dir", apiUd, "export", "n1", out], { encoding: "utf8" })).stdout);
    assert.ok(exp2.dir.startsWith(join(out, "alt2obs-export-")), "a new private folder inside the given one");
    assert.equal(statSync(exp2.dir).mode & 0o777, 0o700);
    const allOut = JSON.stringify(st) + (await run(["list"])) + readFileSync(exp2.bundle, "utf8");
    assert.ok(!allOut.includes(FAKE_TOKEN), "the CLI never prints the token");
    assert.ok(requests.slice(before).every((r) => r.auth === null), "the CLI never sent the token to the impostor");
    console.log("PASS: alt-local.mjs refuses the impostor, lists and exports from the DB copy into a private folder, token never printed");
  } finally {
    await new Promise((r) => server.close(r));
  }

  // An unverified port is skipped (never sent the token); the next verified one is used.
  {
    const seen = [];
    const make = (label) =>
      http.createServer((req, res) => {
        seen.push({ label, url: req.url, auth: req.headers.authorization ?? null });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/api/status") return res.end(JSON.stringify({ ok: true, data: { ok: true, version: "0.12.0" } }));
        res.end(JSON.stringify({ ok: true, data: [] }));
      });
    let a;
    let b;
    let p0 = 0;
    for (let tries = 0; tries < 20 && !b; tries++) {
      a = make("impostor");
      await new Promise((r) => a.listen(0, "127.0.0.1", r));
      p0 = a.address().port;
      b = make("alt");
      const okListen = await new Promise((r) => {
        b.once("error", () => r(false));
        b.listen(p0 + 1, "127.0.0.1", () => r(true));
      });
      if (!okListen) {
        a.close();
        b = null;
      }
    }
    assert.ok(b, "two adjacent ports");
    const ud5 = join(root, "api-next");
    mkdirSync(ud5, { recursive: true });
    writeFileSync(join(ud5, "storage-httpServer.json"), JSON.stringify({ enabled: true, port: p0 }));
    writeFileSync(m.tokenFilePath(ud5), FAKE_TOKEN);
    const det = await m.AltLocalApiSource.detect(ud5, { verifyOwner: async (port) => (port === p0 + 1 ? { ok: true, reason: "", pid: 5 } : { ok: false, reason: "not Alt" }) });
    assert.ok(det.source, det.reason);
    await det.source.listNotes();
    assert.ok(seen.filter((x) => x.label === "impostor").every((x) => x.auth === null), "the unverified port never got the token");
    assert.ok(seen.some((x) => x.label === "alt" && x.auth === `Bearer ${FAKE_TOKEN}`));
    // A connection error marks the source failed, so the plugin connects again.
    await new Promise((r) => b.close(r));
    await assert.rejects(det.source.listNotes(), /연결하지 못했습니다/);
    assert.equal(det.source.failed, true);
    await new Promise((r) => a.close(r));
    console.log("PASS: detect skips an unverified port and uses the next verified one; a connection error marks the source failed");
  }

  // Alt not running: the database copy is used; neither: "연결 안 됨".
  {
    const free = await new Promise((r) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => r(p));
      });
    });
    writeFileSync(join(apiUd, "storage-httpServer.json"), JSON.stringify({ enabled: true, port: free }));
    const c = await m.connectAltLocal(apiUd, { tmpRoot: root, probeTimeoutMs: 300 });
    assert.equal(c.source.mode, "db");
    assert.equal(c.label, "Alt 꺼짐 · DB 읽기");
    assert.match(c.detail, /실행 중이 아니거나/);
    c.source.close();
    writeFileSync(join(apiUd, "storage-httpServer.json"), JSON.stringify({ enabled: false, port: free }));
    const none = await m.connectAltLocal(join(root, "empty"), { tmpRoot: root, probeTimeoutMs: 300 });
    assert.equal(none.source, null);
    assert.equal(none.label, "연결 안 됨");
    const off = await m.AltLocalApiSource.detect(apiUd, { probeTimeoutMs: 300 });
    assert.match(off.reason, /로컬 HTTP 서버가 꺼져/);
    console.log("PASS: source selection: API, else database copy, else none, with the reason");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
