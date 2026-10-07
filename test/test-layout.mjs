/**
 * Test: the 2.0 vault layout (spec 4.5, D3) and "Migrate 1.x vault layout":
 * paths, the dry-run plan (lecture notes and their PDFs move to Lectures/,
 * Concepts and Exam untouched, other notes left, collisions skipped), the
 * apply step through app.fileManager.renameFile on an in-memory vault
 * (links rewritten by the rename, nothing deleted or overwritten), and a
 * second run moving nothing.
 * Run: node test/test-layout.mjs
 */

import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const L = await importTs("src/vault/layout.ts");
const M = await importTs("src/vault/layoutMigration.ts");

// ---- paths ----
assert.equal(L.lecturePath("Alt2Obsidian", "CSED311", "Lec7: Caches?"), "Alt2Obsidian/CSED311/Lectures/Lec7 Caches.md");
assert.equal(L.verificationPath("Alt2Obsidian", "CSED311", "Lec7 Caches"), "Alt2Obsidian/CSED311/Verification/Lec7 Caches verification.md");
assert.equal(L.attachmentPath("Alt2Obsidian", "CSED311", "Lec7 Caches", 12), "Alt2Obsidian/CSED311/Attachments/Lec7 Caches-12.png");
assert.equal(L.conceptsFolder("Alt2Obsidian/", "CSED311"), "Alt2Obsidian/CSED311/Concepts");
assert.equal(L.verificationPathForNote("A/S/Lectures/lec 1.md"), "A/S/Verification/lec 1 verification.md");
assert.equal(L.verificationPathForNote("A/S/lec 1.md"), "A/S/Verification/lec 1 verification.md", "1.x note: sibling folders of its own folder");
assert.equal(L.attachmentPathForNote("A/S/Lectures/lec 1.md", 3), "A/S/Attachments/lec 1-3.png");
assert.equal(L.attachmentPathForNote("A/S/Lectures/[OS] 3강 #2.md", 5), "A/S/Attachments/OS 3강 2-5.png", "no [ ] # ^ | in an embed target");
console.log("PASS: layout paths (Lectures, Concepts, Verification, Attachments)");

// ---- plan ----
const files = [
  { path: "Alt2Obsidian/CSED311/Lec1.md", isLectureNote: true },
  { path: "Alt2Obsidian/CSED311/Lec1.pdf" },
  { path: "Alt2Obsidian/CSED311/Lec2.md", isLectureNote: true },
  { path: "Alt2Obsidian/CSED311/Lectures/Lec2.md", isLectureNote: true },
  { path: "Alt2Obsidian/CSED311/Lec2.pdf" },
  { path: "Alt2Obsidian/CSED311/Lec3.md", isLectureNote: true },
  { path: "Alt2Obsidian/CSED311/Lec3.pdf" },
  { path: "Alt2Obsidian/CSED311/Lectures/lec3.PDF" },
  { path: "Alt2Obsidian/CSED311/my own note.md", isLectureNote: false },
  { path: "Alt2Obsidian/CSED311/Concepts/캐시.md", isLectureNote: false },
  { path: "Alt2Obsidian/Exam/CSED311 시험요약.md", isLectureNote: false },
  { path: "Alt2Obsidian/EE201/회로 1강.md", isLectureNote: true },
  { path: "Alt2Obsidian/EE201/회로 1강.PDF" },
  { path: "Other/Lec9.md", isLectureNote: true },
];
const plan = M.planLayoutMigration("Alt2Obsidian", files);
assert.deepEqual(plan.moves, [
  { from: "Alt2Obsidian/CSED311/Lec1.md", to: "Alt2Obsidian/CSED311/Lectures/Lec1.md", kind: "note" },
  { from: "Alt2Obsidian/CSED311/Lec1.pdf", to: "Alt2Obsidian/CSED311/Lectures/Lec1.pdf", kind: "pdf" },
  { from: "Alt2Obsidian/EE201/회로 1강.md", to: "Alt2Obsidian/EE201/Lectures/회로 1강.md", kind: "note" },
  { from: "Alt2Obsidian/EE201/회로 1강.PDF", to: "Alt2Obsidian/EE201/Lectures/회로 1강.PDF", kind: "pdf" },
]);
assert.deepEqual(
  plan.skipped.map((s) => [s.from, s.reason]),
  [
    ["Alt2Obsidian/CSED311/Lec2.md", M.COLLISION_REASON],
    ["Alt2Obsidian/CSED311/Lec2.pdf", M.NOTE_SKIPPED_REASON],
    ["Alt2Obsidian/CSED311/Lec3.md", M.PDF_TAKEN_REASON],
    ["Alt2Obsidian/CSED311/Lec3.pdf", M.COLLISION_REASON],
  ],
  "collisions (case-insensitive) are skipped, never overwritten; a note and its PDF stay together"
);
assert.deepEqual(plan.units.map((u) => [u.note.from, u.pdf?.from ?? null]), [
  ["Alt2Obsidian/CSED311/Lec1.md", "Alt2Obsidian/CSED311/Lec1.pdf"],
  ["Alt2Obsidian/EE201/회로 1강.md", "Alt2Obsidian/EE201/회로 1강.PDF"],
]);
assert.deepEqual(plan.otherNotes, ["Alt2Obsidian/CSED311/my own note.md"]);
assert.equal(plan.examFiles, 1);
console.log("PASS: dry run moves lecture notes and PDFs, leaves Concepts, Exam and other notes, skips collisions");

// ---- apply on an in-memory vault through fileManager.renameFile ----
const quiet = { log: console.log, warn: console.warn };
console.log = console.warn = () => {};
const { default: Plugin, TFile } = await importTs("test/helpers/plugin-entry.ts");
Object.assign(console, quiet);

function makeVault(initial) {
  const store = new Map(Object.entries(initial));
  const renames = [];
  const tfile = (path) => Object.assign(new TFile(), { path, extension: path.split(".").pop(), basename: path.split("/").pop().replace(/\.[^.]+$/, "") });
  const frontmatter = (text) => {
    const m = typeof text === "string" && text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    return Object.fromEntries(m[1].split("\n").map((l) => l.match(/^(\w+): "?(.*?)"?$/)).filter(Boolean).map((x) => [x[1], x[2]]));
  };
  const app = {
    vault: {
      on: () => ({}),
      getFiles: () => [...store.keys()].map(tfile),
      getMarkdownFiles: () => [...store.keys()].filter((p) => p.endsWith(".md")).map(tfile),
      getAbstractFileByPath: (p) => (store.has(p) ? tfile(p) : null),
      createFolder: async () => {},
      adapter: {},
    },
    metadataCache: {
      on: () => ({}),
      getFileCache: (f) => {
        const fm = frontmatter(store.get(f.path));
        return fm ? { frontmatter: fm } : null;
      },
    },
    fileManager: {
      // Obsidian's renameFile: moves the file and rewrites links to it in other notes.
      renameFile: async (f, to) => {
        renames.push([f.path, to]);
        const fromLink = f.path.replace(/\.md$/, "");
        const toLink = to.replace(/\.md$/, "");
        store.set(to, store.get(f.path));
        store.delete(f.path);
        for (const [p, c] of store) if (typeof c === "string") store.set(p, c.split(`[[${fromLink}`).join(`[[${toLink}`));
      },
    },
    workspace: { onLayoutReady: () => {} },
  };
  return { app, store, renames };
}

const lec = (id) => `---\ntitle: "x"\nsource: "alt2obsidian"\nalt_id: "${id}"\n---\n# x\n`;
const { app, store, renames } = makeVault({
  "Alt2Obsidian/CSED311/Lec1.md": lec("a"),
  "Alt2Obsidian/CSED311/Lec1.pdf": "<pdf>",
  "Alt2Obsidian/CSED311/Lec2.md": lec("b"),
  "Alt2Obsidian/CSED311/Lectures/Lec2.md": lec("b2"),
  "Alt2Obsidian/CSED311/Concepts/캐시.md": "---\ntags: [concept]\n---\n**관련 강의:** [[Lec1]], [[Alt2Obsidian/CSED311/Lec1]]\n",
  "Alt2Obsidian/CSED311/Skill 노트.md": `---\nsource: "alt2obsidian-cc-skill"\n---\n`,
  "Alt2Obsidian/CSED311/내 정리.md": "---\ntags: [mine]\n---\n[[Alt2Obsidian/CSED311/Lec1|1강]]\n",
  "Alt2Obsidian/Exam/CSED311 시험요약.md": "---\ntags: [exam-summary]\n---\n",
});
const plugin = new Plugin();
let saved = { recentImports: [{ url: "", title: "x", subject: "CSED311", path: "Alt2Obsidian/CSED311/Lec1.md", pdfPath: "Alt2Obsidian/CSED311/Lec1.pdf", date: "2026-09-01", parseQuality: "full" }] };
Object.assign(plugin, {
  app,
  manifest: { dir: ".obsidian/plugins/alt2obs" },
  loadData: async () => saved,
  saveData: async (d) => void (saved = JSON.parse(JSON.stringify(d))),
  registerView: () => {},
  registerEvent: () => {},
  addRibbonIcon: () => {},
  addCommand: () => {},
  addSettingTab: () => {},
  registerEditorExtension: () => {},
});
await plugin.onload();
const before = new Set(store.keys());
const dry = plugin.planVaultMigration();
assert.deepEqual(new Set(store.keys()), before, "dry run changes nothing");
assert.deepEqual(dry.moves.map((m) => m.to), [
  "Alt2Obsidian/CSED311/Lectures/Lec1.md",
  "Alt2Obsidian/CSED311/Lectures/Lec1.pdf",
  "Alt2Obsidian/CSED311/Lectures/Skill 노트.md",
]);
const result = await plugin.applyVaultMigration(dry);
assert.deepEqual(
  renames,
  dry.units.flatMap((u) => (u.pdf ? [[u.pdf.from, u.pdf.to], [u.note.from, u.note.to]] : [[u.note.from, u.note.to]])),
  "every move goes through fileManager.renameFile, the PDF before its note"
);
assert.equal(result.moved.length, 3);
assert.deepEqual(result.skipped.map((s) => s.from), ["Alt2Obsidian/CSED311/Lec2.md"]);
assert.equal(store.get("Alt2Obsidian/CSED311/Lec2.md"), lec("b"), "the colliding note is left as it was");
assert.equal(store.get("Alt2Obsidian/CSED311/Lectures/Lec2.md"), lec("b2"), "and the existing target is not overwritten");
assert.equal(store.size, before.size, "nothing deleted");
assert.match(store.get("Alt2Obsidian/CSED311/내 정리.md"), /\[\[Alt2Obsidian\/CSED311\/Lectures\/Lec1\|1강\]\]/, "path links rewritten by the rename");
assert.match(store.get("Alt2Obsidian/CSED311/Concepts/캐시.md"), /\[\[Lec1\]\], \[\[Alt2Obsidian\/CSED311\/Lectures\/Lec1\]\]/);
assert.ok(store.has("Alt2Obsidian/Exam/CSED311 시험요약.md"), "Exam untouched");
assert.equal(saved.recentImports[0].path, "Alt2Obsidian/CSED311/Lectures/Lec1.md");
assert.equal(saved.recentImports[0].pdfPath, "Alt2Obsidian/CSED311/Lectures/Lec1.pdf");

// A target taken between the dry run and the apply is skipped too.
const stale = M.planLayoutMigration("Alt2Obsidian", [{ path: "Alt2Obsidian/S/n.md", isLectureNote: true }]);
const raced = await M.applyLayoutMigration(stale, { exists: (p) => p.endsWith("Lectures/n.md") || p.endsWith("S/n.md"), ensureFolder: async () => {}, rename: async () => assert.fail("must not rename onto an existing file") });
assert.deepEqual(raced.skipped.map((s) => s.reason), [M.COLLISION_REASON]);

// A note that cannot move takes its PDF back: they never end up apart.
{
  const unitPlan = M.planLayoutMigration("B", [{ path: "B/S/n.md", isLectureNote: true }, { path: "B/S/n.pdf" }]);
  const where = new Set(["B/S/n.md", "B/S/n.pdf"]);
  const calls = [];
  const io = {
    exists: (p) => where.has(p),
    ensureFolder: async () => {},
    rename: async (from, to) => {
      calls.push([from, to]);
      if (from.endsWith(".md")) throw new Error("locked");
      where.delete(from);
      where.add(to);
    },
  };
  const res = await M.applyLayoutMigration(unitPlan, io);
  assert.deepEqual(calls, [["B/S/n.pdf", "B/S/Lectures/n.pdf"], ["B/S/n.md", "B/S/Lectures/n.md"], ["B/S/Lectures/n.pdf", "B/S/n.pdf"]]);
  assert.deepEqual([...where].sort(), ["B/S/n.md", "B/S/n.pdf"], "both where they were");
  assert.equal(res.moved.length, 0);
  assert.deepEqual(res.skipped.map((x) => x.from), ["B/S/n.md", "B/S/n.pdf"]);
  // The PDF cannot be moved back either: the result says where it is.
  const where2 = new Set(["B/S/n.md", "B/S/n.pdf"]);
  const stuck = await M.applyLayoutMigration(M.planLayoutMigration("B", [{ path: "B/S/n.md", isLectureNote: true }, { path: "B/S/n.pdf" }]), {
    exists: (p) => where2.has(p),
    ensureFolder: async () => {},
    rename: async (from, to) => {
      if (from.endsWith(".md") || from.startsWith("B/S/Lectures/")) throw new Error("locked");
      where2.delete(from);
      where2.add(to);
    },
  });
  assert.deepEqual(stuck.moved.map((x) => x.to), ["B/S/Lectures/n.pdf"], "the PDF that stayed moved is reported as moved");
  assert.match(stuck.skipped.find((x) => x.from === "B/S/n.md").reason, /PDF는 B\/S\/Lectures\/n\.pdf에 있고 되돌리지 못했습니다/);
  // A PDF target taken after the dry run: the whole unit stays.
  where.add("B/S/Lectures/n.pdf");
  calls.length = 0;
  const res2 = await M.applyLayoutMigration(unitPlan, io);
  assert.equal(calls.length, 0);
  assert.deepEqual(res2.skipped.map((x) => x.reason), [M.PDF_TAKEN_REASON, M.COLLISION_REASON]);
}

// Second run: nothing left to move (idempotent).
const again = plugin.planVaultMigration();
assert.equal(again.moves.length, 0);
assert.deepEqual(again.skipped.map((s) => s.from), ["Alt2Obsidian/CSED311/Lec2.md"]);
console.log("PASS: apply moves through renameFile (links updated), skips collisions, deletes nothing, updates recent imports; a second run moves nothing");
