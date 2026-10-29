/**
 * DOM test: the Synced Viewer (src/ui/SyncedViewerView.ts) in a real
 * headless Chromium, with a synthetic 30-page PDF and a note in the 2.0
 * layout (overview with a "### 슬라이드 2~3 정리" subheading, alt2obs
 * marker comments). A reader scrolls each pane, edits the note elsewhere
 * (refresh) and re-imports the same pair; neither pane may jump, and the
 * overview subheading must not count as slide 2. Then a viewer is restored
 * as at startup, before the metadata cache has the note: the alignment
 * label and the transcript button come once the note's "changed" event
 * does, and the title bar (written by Obsidian only when the view loads)
 * names the note like the tab.
 *
 * Needs a Chromium binary, so it is not part of `npm test`:
 *   npm run test:dom                 (finds Playwright's headless shell or Google Chrome)
 *   ALT2OBS_CHROME=/path/to/chrome npm run test:dom
 * Fails (does not skip) when no browser is found.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import esbuild from "esbuild";
import { repo } from "./helpers/bundle-ts.mjs";
import { inlinePdfWorker } from "../scripts/inline-pdf-worker.mjs";
import { writeSyntheticPdf } from "./helpers/synthetic-pdf.mjs";

function findChrome() {
  if (process.env.ALT2OBS_CHROME) return process.env.ALT2OBS_CHROME;
  const pw = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(pw, d))) {
        const bin = join(pw, d, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : null;
}

const chrome = findChrome();
assert.ok(chrome, "no Chromium found: set ALT2OBS_CHROME");

const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-dom-"));
const PAGES = 30;
writeSyntheticPdf(join(dir, "deck.pdf"), Array.from({ length: PAGES }, (_, i) => `Slide ${i + 1}  Topic ${i + 1}`));
const para = (n) => `해설 ${n}. ` + "스케줄러는 티켓 비율에 맞춰 CPU를 나눕니다. ".repeat(6);
const sections = Array.from({ length: PAGES }, (_, i) => {
  const n = i + 1;
  return [
    `## 📚 슬라이드 ${n}`,
    "",
    `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "0")} start -->`,
    para(n),
    "",
    para(n),
    "",
    `<!-- alt2obs:meta img:none gist:"요지 ${n}" -->`,
    `<!-- alt2obs:slide:${n} hash:${String(n).padStart(8, "0")} end -->`,
    "",
    "> [!note] 내 메모",
    "> ",
    "",
  ].join("\n");
});
const note = [
  "---",
  'title: "Lec"',
  "---",
  "# Lec",
  "",
  "## 📋 전체 요약",
  "",
  "<!-- alt2obs:overview start -->",
  "### 슬라이드 2~3 정리",
  "- 티켓 비율 (슬라이드 2~3)",
  "",
  "### 슬라이드 4 이후",
  "- 구현 (슬라이드 4~30)",
  "<!-- alt2obs:overview end -->",
  "",
  ...sections,
].join("\n");
writeFileSync(join(dir, "note.md"), note);
// The viewer's layout comes from the plugin's styles.css, as in Obsidian.
writeFileSync(join(dir, "styles.css"), readFileSync(join(repo, "styles.css")));
writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{margin:0;width:1400px}#host{height:800px}</style></head>' +
    '<body><div id="host"></div><pre id="out">pending</pre><script type="module" src="./bundle.js"></script></body></html>'
);
await esbuild.build({
  entryPoints: [join(repo, "test/helpers/dom-viewer-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(dir, "bundle.js"),
  loader: { ".md": "text", ".css": "text" },
  logLevel: "error",
  plugins: [inlinePdfWorker, { name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(repo, "test/helpers/obsidian-browser-stub.js") })) }],
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".md": "text/plain; charset=utf-8", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const file = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless", `--remote-debugging-port=${port}`, "--window-size=1400,900", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let out = "pending";
try {
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
    else if (d.method === "Runtime.exceptionThrown") console.error("page exception:", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 240 && out === "pending"; i++) {
    await sleep(250);
    const r = await send("Runtime.evaluate", { expression: "document.getElementById('out')?.textContent ?? 'pending'" });
    out = r.result?.result?.value ?? "pending";
  }
  ws.close();
} finally {
  proc.kill();
  server.close();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}

assert.ok(!out.startsWith("ERROR") && out !== "pending", out);
const [info, ...steps] = JSON.parse(out);
const at = (name) => steps.find((s) => s.step === name);
assert.equal(info.pages, PAGES);
assert.deepEqual(info.headings, Array.from({ length: PAGES }, (_, i) => i + 1), "only the 📚 h2 headings, the overview subheadings are not slides");
for (const [name, n] of [["pdf to 12", 12], ["md to 20", 20], ["edit refresh", 20], ["re-import", 20], ["after load", 25], ["pdf jump 27", 27]]) {
  const s = at(name);
  assert.deepEqual([s.current, s.pdf, s.md], [n, n, n], `${name}: both panes on slide ${n} (${JSON.stringify(s)})`);
}
assert.ok(Math.abs(at("edit refresh").mdTop - at("md to 20").mdTop) < 5, "an edit refresh keeps the note's position");
assert.ok(Math.abs(at("re-import").pdfTop - at("edit refresh").pdfTop) < 5 && Math.abs(at("re-import").mdTop - at("edit refresh").mdTop) < 5, `a re-import keeps both positions (${JSON.stringify(steps)})`);
assert.equal(at("closed").current, 27, "a scroll queued at close is dropped");
const during = at("during load");
assert.equal(during.loading, true, "the note was still loading");
assert.equal(during.pdf, 25, "the PDF moved during the load");
assert.ok(Math.abs(during.mdTop - at("re-import").mdTop) < 5, `the loading note pane was not scrolled (${JSON.stringify(during)})`);
assert.deepEqual([at("after load").current, at("after load").pdf, at("after load").md], [25, 25, 25], "after the load the note follows the PDF");
console.log("PASS: Synced Viewer in Chromium: PDF and note follow each other, an edit refresh and a re-import keep both panes, overview subheadings are not slides, close cancels pending work");

// Restored at startup before the metadata cache has the note.
const ui = (name) => {
  const { step, ...rest } = at(name);
  return rest;
};
assert.deepEqual(ui("restored, not indexed"), { label: false, transcriptButton: false, titleBar: "L5 (Synced)", tab: "L5 (Synced)" }, "no frontmatter yet: no alignment controls; the title bar names the note too, not just the tab");
assert.deepEqual(ui("other note indexed"), ui("restored, not indexed"), "another note's metadata is not this note's");
assert.deepEqual(ui("note indexed"), { label: true, transcriptButton: true, titleBar: "L5 (Synced)", tab: "L5 (Synced)" }, "the note's metadata arrives: alignment label and transcript button");
assert.match(at("transcript").text, /슬라이드 1 구간.*00:00 - 00:30.*\[00:01\]첫 문장/, "the transcript panel uses the alignment read late");
console.log("PASS: Synced Viewer restored before the note is indexed: the alignment label and transcript button come with the note's metadata, the title bar and the tab name the note");

// 2.1.0: the question panel button and the page event (spec 5.1, 5.2).
const chat = at("chat");
assert.deepEqual(chat.buttons.slice(-2), ["전사 패널", "💬 질문"], "💬 질문 right after 전사 패널");
assert.deepEqual(chat.beforePair, { slide: null, events: 0 }, "no slide and no event before a PDF is shown");
assert.ok(chat.events.every(([name, info]) => name === "alt2obsidian:slide-change" && info.mdPath === "note.md" && info.pdfPath === "deck.pdf"), "the event names the pair");
const pages = chat.events.map(([, info]) => info.page);
assert.equal(pages[0], 1, "page 1 once the PDF is shown");
assert.equal(pages[pages.length - 1], 5, "then the page gone to");
assert.ok(pages.every((p, i) => i === 0 || p !== pages[i - 1]), `one event per page change, never the same page twice in a row (${pages})`);
assert.equal(chat.slide, 5, "getCurrentSlide()");
assert.equal(chat.toggles, 1, "the button toggles the panel");
assert.deepEqual([chat.activeWhenOpen, chat.activeAfter], [true, false], "is-active while the panel is open");
console.log("PASS: Synced Viewer's 💬 질문 button toggles the question panel and shows it open (is-active); each page change is announced once with the pair; getCurrentSlide()");

// 2.1.0: the question panel's chips (spec 5.5).
assert.deepEqual(at("time chip"), { step: "time chip", page: 2, panelOpen: true, flashed: "[00:41]슬라이드 2 둘째 줄", ms: "41000" }, "a time goes to its aligned slide, the transcript panel opens on its line and highlights it");
assert.deepEqual(at("slide chip"), { step: "slide chip", page: 3 });
const sel = at("selection");
assert.ok(sel.picked.length > 0 && sel.picked === sel.heading, "the note pane's selection");
assert.equal(sel.keptOnPanelClick, sel.picked, "kept when the click lands outside the pane (the question panel)");
assert.deepEqual([sel.clearedByOther, sel.clearedInPane], ["", ""], "cleared by a selection elsewhere or a click in the pane");
const right = at("right-click");
assert.deepEqual(right.onPage, { items: ["이 슬라이드에 질문"], prevented: true }, "a page's right-click menu");
assert.deepEqual(right.noSelection, { items: null, prevented: false }, "no selection in the note: the default menu");
assert.deepEqual(right.withSelection, { items: ["선택한 내용으로 질문"], prevented: true });
assert.deepEqual(right.asked, [["slide", "note.md", 2], ["selection", "note.md", right.current, sel.heading]], "the panel is asked with the note, the slide and the text");
console.log("PASS: Synced Viewer's showTranscriptAt(ms) and gotoSlide(n) for the question panel's chips; the note pane's selection for 노트에서 선택한 글; right-click: 이 슬라이드에 질문 on a page, 선택한 내용으로 질문 on a selection");
