/**
 * DOM test: the question panel (src/ui/ChatView.ts, 2.1.0 spec 5) and its
 * open/close controller (src/ui/chatPanel.ts) in a real headless Chromium,
 * with the plugin's styles.css, a fake workspace and a fake plugin whose
 * answer streams in pieces (test/helpers/dom-chat-entry.ts):
 * opening and closing restore the right sidebar's collapsed state, a panel
 * restored at startup is detached, the "강의 없음" card starts a lecture
 * with a slide range, the panel follows the viewer's slide (and 📌 stops
 * it), chips turn material on and off, Enter does not send while a Korean
 * syllable is composed, the answer streams as text and then renders as
 * Markdown with grounding chips (none inside code), a slide change puts a
 * divider in the thread, a stopped answer stays marked and is not sent
 * again, the error cards, the per-question cap asked in the panel, and the
 * brief cards (missing, edited and stale).
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

const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-dom-chat-"));
writeFileSync(join(dir, "styles.css"), readFileSync(join(repo, "styles.css")));
writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{margin:0;width:420px}#host{height:800px}</style></head>' +
    '<body><div id="host"></div><pre id="out">pending</pre><script type="module" src="./bundle.js"></script></body></html>'
);
await esbuild.build({
  entryPoints: [join(repo, "test/helpers/dom-chat-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(dir, "bundle.js"),
  loader: { ".md": "text", ".css": "text" },
  logLevel: "error",
  plugins: [{ name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(repo, "test/helpers/obsidian-browser-stub.js") })) }],
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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
const steps = JSON.parse(out);
const at = (name) => {
  const s = steps.find((x) => x.step === name);
  assert.ok(s, `step ${name}`);
  return s;
};

// Open and close (spec 5.1).
assert.deepEqual(at("opened (sidebar was collapsed)"), { step: "opened (sidebar was collapsed)", open: true, collapsed: false, events: [true] });
assert.deepEqual(at("toggled closed"), { step: "toggled closed", open: false, collapsed: true, collapses: 1, events: [true, false] }, "closing collapses the sidebar again");
assert.deepEqual(at("tab closed (sidebar was open)"), { step: "tab closed (sidebar was open)", open: false, collapsed: false, collapses: 1 }, "closing the tab itself: the open sidebar stays open");
assert.deepEqual(at("restored and detached"), { step: "restored and detached", open: false, collapsed: false, collapses: 1, readBeforeReady: 0 }, "a restored panel reads nothing before the layout is ready, is detached, the sidebar left as it is");
assert.deepEqual(at("deferred restored"), { step: "deferred restored", open: false, events: [false] }, "a restored tab that never showed its view still turns the buttons off");
assert.deepEqual(at("double open"), { step: "double open", panels: 1, events: [true] }, "a double click opens one panel");
console.log("PASS: question panel opens on demand in the right sidebar (once on a double click), closing (button, tab, ×) restores the sidebar's collapsed state, a restored panel reads nothing before the layout is ready and is detached then");

// No lecture, then a lecture picked with a slide range (spec 5.6).
const none = at("no lecture");
assert.equal(none.card, "열린 강의 노트가 없습니다");
assert.equal(none.composerShown, false, "no input without a lecture");
assert.deepEqual(none.lectures, ["L4", "L5"]);
const started = at("started with a range");
assert.ok(started.chips.some((c) => c.startsWith("📄 슬라이드 14")) && !started.chips.some((c) => c.startsWith("📄 슬라이드 14 · 따라가는 중")), `slide 14 pinned (${started.chips})`);
assert.ok(started.chips.some((c) => c.startsWith("📄 슬라이드 15 ×")), "slide 15 added, removable");
assert.ok(started.notices.some((n) => n.includes("99")), "a number past the deck is left out and said");
assert.equal(started.pinned, true);
console.log("PASS: the 강의 없음 card lists the vault's lectures; starting with 14-15, 99 pins slide 14, adds 15 and leaves out 99 with a notice");

// Following the viewer, chips (spec 5.2, 5.3).
const following = at("following 17");
assert.equal(following.head, "CSED423 · L5");
for (const prefix of ["📘 브리프", "📄 슬라이드 17 · 따라가는 중", "🎙 전사 29:06-35:56", "✏️ 내 메모"]) {
  assert.ok(following.chips.some((c) => c.startsWith(prefix) && c.endsWith("|is-on")), `${prefix} on (${following.chips})`);
}
assert.ok(following.chips.every((c) => !c.startsWith("📄 슬라이드 15")), "the added slide was removed with ×");
assert.match(following.chips.find((c) => c.startsWith("📘")), /k\|is-on$/, "a chip shows its tokens");
assert.equal(following.title, "## 개요\n부동소수점 덧셈을 다룬다.", "the chip's tooltip: what it sends");
assert.match(following.estimate, /^이번 질문 예상: 입력 약 \d+\.\dk · 출력 약 0\.6k$/);
assert.match(at("note edited").memo, /^✏️ 비어 있음\|is-disabled$/, "the note's memo emptied: its chip is read again");
assert.match(at("chip toggles").off, /^🎙 전사.*\|is-off$/);
assert.match(at("chip toggles").on, /^🎙 전사.*\|is-on$/);
console.log("PASS: the panel follows the viewer's lecture and slide; brief, slide, transcript and memo chips with tokens and tooltips, toggled by a click and read again when the note changes");

// Enter and the Korean composition (spec 5.3).
assert.deepEqual(at("composing"), { step: "composing", runs: 0, value: "왜 작은 수부터 더해?" }, "Enter while composing (isComposing or keyCode 229) and Shift+Enter do not send");
const streaming = at("streaming");
assert.equal(streaming.runs, 1, "two Enters and a quick question while sending: one question");
assert.equal(streaming.turns, 1);
assert.equal(streaming.disabledWhileSending, true, "the input is disabled at once");
assert.equal(streaming.streaming, true);
assert.ok(streaming.partial.length > 0 && "부동소수점 덧셈은 작은 수부터 더한다 [슬라이드 17]. ".startsWith(streaming.partial.slice(0, 10)), `plain text while streaming (${streaming.partial})`);
assert.equal(streaming.sendButton, "중지", "the send button stops while answering");
assert.equal(streaming.cleared, "");
const answered = at("answered");
assert.deepEqual(answered.cites, ["is-slide:슬라이드 17", "is-time:▶ 29:10", "is-slide:슬라이드 16~18", "is-outside:강의 자료 밖"], "grounding marks as chips");
assert.equal(answered.code, "[슬라이드 17]", "inline code keeps its text");
assert.equal(answered.codeCites, 0, "no chip inside code");
assert.equal(answered.plainMissing, true, "a slide past the deck stays text");
assert.equal(answered.usage, "Sonnet 5.5 · low · 입력 5.1k (캐시 3.0k) · 출력 0.4k");
assert.equal(answered.label, "슬라이드 17 기준");
assert.equal(answered.system, "[강의 브리프: CSED423 · L5 (앞 강의: L4, 다음 강의: L6)]\n## 개요\n부동소수점 덧셈을 다룬다.", "the brief after the instructions in the system prompt");
assert.deepEqual(answered.userHead, ["[이번 자료]", "## L5 · 슬라이드 17 [29:06~35:56]"]);
assert.equal(answered.memoSent, true);
assert.equal(answered.memoText, "시험 범위, 오늘 고친 메모", "the memo is read again at the send");
assert.equal(answered.transcriptSent, true);
assert.deepEqual(answered.task, { provider: "claude-cli", model: "sonnet", effort: "low" }, "the chat task's model");
console.log("PASS: Enter sends (not while composing, not with Shift); the answer streams as text, then renders as Markdown with slide, time and outside chips (not in code); the usage line names the model");

// The chips go where they point (spec 5.5).
const nav = at("chips navigate");
assert.deepEqual(nav.gone, ["slide:17", `time:${29 * 60_000 + 10_000}`, "slide:16"], "a slide chip to its slide (a range to its first), a time chip to its time; the outside badge goes nowhere");
assert.deepEqual([nav.role, nav.outsideRole], ["button", null]);
console.log("PASS: grounding chips navigate: slide chips to the slide, time chips to the transcript time");

// A run outlives the panel (spec 5.4).
const outlived = at("outlived the panel");
assert.equal(outlived.aborted, false, "closing the panel does not stop the answer");
assert.deepEqual(outlived.status, ["done", "done"]);
assert.equal(outlived.answers[1], "닫아도 계속 쓴다 슬라", "the panel opened again shows the whole answer, rendered with its chips");
console.log("PASS: closing the panel while answering leaves the run going in the thread; the panel opened again shows the finished answer");

// Divider, stop (spec 5.2, 5.4).
const moved = at("moved");
assert.deepEqual(moved.dividers, ["슬라이드 18으로 이동"]);
assert.match(moved.chip, /^📄 슬라이드 18 · 따라가는 중/);
const stopped = at("stopped");
assert.equal(stopped.answers[2], "받은 부분", "the partial answer stays");
assert.equal(stopped.hasStopped, false, "a stopped turn is not in the earlier conversation");
assert.match(stopped.history, /^\[이전 대화\]\nQ \(슬라이드 17 기준\): 왜 작은 수부터 더해\?\nA: 부동소수점 덧셈은/);
console.log("PASS: a followed slide change puts a divider in the thread; a stopped answer stays as (중지됨) and is left out of the next question's history");

// One run per thread, also while a question is being prepared; the input keeps its focus.
const prep = at("regenerate while sending");
assert.equal(prep.runs, 1, "다시 생성 during the preparation of a question starts nothing");
assert.equal(prep.last, "준비 중에 다시 생성?");
assert.equal(prep.focused, true, "the input has its focus back after the send");
console.log("PASS: 다시 생성 while a question is being prepared starts no second run; the input gets its focus back after a send");

// Error cards (spec 5.6).
const errors = at("errors");
const card = (kind) => errors.cards.find((c) => c.kind === kind);
assert.equal(card("auth").title, "로그인이 필요합니다");
assert.match(card("auth").fix, /터미널에서 `claude`\(또는 `codex login`\)를 한 번 실행해 로그인한 뒤 다시 보내세요/);
assert.equal(card("limit").fix, "Claude usage limit reached. Your limit resets at 5pm.", "the CLI's own sentence");
assert.match(card("missing").fix, /설정 > LLM 연결/);
assert.equal(card("timeout").title, "응답이 없어 중단했습니다");
assert.equal(card("other").fix, "boom");
for (const c of errors.cards) assert.deepEqual(c.buttons, ["다시 보내기", "Codex로 보내기", "설정 열기"], `${c.kind}: buttons`);
assert.deepEqual(errors.retried, { provider: "codex-cli", model: "", effort: "low" }, "the other provider with its chat defaults");
assert.equal(errors.settingsOpened, true);
console.log("PASS: error cards for login, usage limit, missing CLI, timeout and others, with retry, the other provider and the settings");

// The brief unreadable now: the last state stays (review M4).
assert.match(at("brief unreadable").chip, /^📘 브리프\d/);
assert.equal(at("brief unreadable").sentBrief, true, "the last brief that could be read is sent");

// The cap (spec 5.4).
const cap = at("over the cap");
assert.ok(cap.liveBeforeClear > 0 && cap.liveAfterClear === 0, `새 대화 unloads every answer's render component (${cap.liveBeforeClear} to ${cap.liveAfterClear})`);
assert.equal(cap.threadGone, true, "새 대화 drops the thread");
assert.equal(cap.runs, 0, "nothing sent past the cap");
assert.match(cap.cap, /질문당 상한\(2\.0k\)을 넘습니다그래도 보내기취소/);
console.log("PASS: a question past 질문당 토큰 상한 is confirmed in the panel (그래도 보내기 / 취소) before it is sent");

// Brief cards (spec 5.6).
const missing = at("brief missing");
assert.equal(missing.card, "이 강의에는 브리프가 아직 없습니다");
assert.match(missing.chip, /^📘 브리프 없음/);
assert.equal(missing.head, "CSED423 · L4", "the other lecture's own thread");
assert.equal(missing.thread, 0);
assert.deepEqual(missing.built, { build: "Alt2Obsidian/CSED423/Lectures/L4.md", force: false }, "노트로 바로 만들기: the script part, no tokens");
assert.deepEqual(missing.buttons, ["노트로 바로 만들기 · 토큰 0", "강조점까지 만들기 · 약 2.4k"], "with a transcript: 강조점까지 만들기 and its estimate");
assert.match(missing.chipAfter, /^📘 브리프\d/);
const stale = at("brief stale");
assert.match(stale.chip, /^📘 브리프 오래됨/);
assert.deepEqual(stale.buttons, ["내 수정 유지", "새로 만들기"]);
assert.deepEqual(stale.confirm, ["덮어쓰기", "취소"], "새로 만들기 asks first");
assert.deepEqual(stale.rebuilt, { build: "Alt2Obsidian/CSED423/Lectures/L5.md", force: true });
assert.equal(stale.thread, 1, "back on L5: its thread is still there");
assert.deepEqual(at("menu").items, ["브리프 열기", "브리프 다시 만들기", "설정 열기"]);
const closed = at("closed with ×");
assert.deepEqual([closed.open, closed.threadKept, closed.events], [false, true, [false]], "× closes the panel; the threads stay in the plugin");
console.log("PASS: brief cards: missing (노트로 바로 만들기 · 토큰 0) and edited then stale (내 수정 유지 / 새로 만들기 with confirmation); the menu; × keeps the threads");

// 모든 강의 브리프 만들기 (spec 4.6).
const all = at("all briefs");
assert.equal(all.planText, "브리프가 없거나 노트보다 오래된 강의 2개, 직접 고친 브리프 1개는 건너뜁니다.");
assert.deepEqual(all.planButtons, ["스크립트만 (토큰 0)", "강조점 포함 (예상 호출 1회 · 입력 약 2.4k · 출력 약 624)", "취소"]);
assert.deepEqual(all.withAi, [true]);
assert.equal(all.summary, "만든 브리프 2개, 건너뜀 1개, 실패 0개.");
console.log("PASS: 모든 강의 브리프 만들기: counts (to build, edited to skip), script only or with the emphasis estimate, progress and the summary");
