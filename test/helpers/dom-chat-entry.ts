// Browser entry for test/dom-chat.mjs: the real question panel
// (src/ui/ChatView.ts) and its open/close controller (src/ui/chatPanel.ts)
// against the obsidian stub, a fake workspace (right sidebar, leaves,
// events) and a fake plugin (ChatHost) whose CLI answer streams in pieces.
// Results go to <pre id="out"> as JSON.
import { ChatView } from "../../src/ui/ChatView";
import { ChatPanelController, SLIDE_CHANGE_EVENT, VIEW_TYPE_CHAT } from "../../src/ui/chatPanel";
import { BriefsModal } from "../../src/ui/BriefsModal";
import { ThreadStore, turnsOf } from "../../src/chat/threads";
import { DEFAULT_SETTINGS } from "../../src/types";
import { estimateTextTokens } from "../../src/core/budget/estimate";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { Component, Menu, TFile } from "obsidian";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (ok()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${what} ${(window as any).debugState?.() ?? ""}`);
}

const L5 = "Alt2Obsidian/CSED423/Lectures/L5.md";
const L4 = "Alt2Obsidian/CSED423/Lectures/L4.md";
/** A summary note (no slides, spec 9): three transcript sections. */
const L9 = "Alt2Obsidian/CSED423/Lectures/L9.md";
const SECTIONS: Record<number, [number, number]> = { 1: [0, 723_000], 2: [723_000, 1_440_000], 3: [1_440_000, 2_160_000] };
const SUBJECT_BODY = "- L4 (2026-09-23, 슬라이드 20장): 렉서를 다룬다.\n- L5 (2026-09-30, 슬라이드 30장): 부동소수점 덧셈을 다룬다.";

/** A workspace with a right sidebar, leaves and events, enough for the panel and its controller. */
function makeWorkspace() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const leaves: any[] = [];
  const ws: any = {
    rightSplit: { collapsed: true, collapses: 0, collapse() { this.collapsed = true; this.collapses++; }, expand() { this.collapsed = false; } },
    layoutReady: true,
    mostRecent: null as any,
    leaves,
    factory: null as any,
    on(name: string, cb: (...a: unknown[]) => void) { (handlers[name] ??= []).push(cb); return { name }; },
    trigger(name: string, ...args: unknown[]) { for (const cb of handlers[name] ?? []) cb(...args); },
    getMostRecentLeaf() { return this.mostRecent; },
    getLeavesOfType(type: string) { return leaves.filter((l) => l.type === type); },
    getRightLeaf() { return makeLeaf(ws); },
    async revealLeaf() { ws.rightSplit.expand(); },
  };
  return ws;
}

function makeLeaf(ws: any): any {
  const leaf: any = {
    type: null as string | null,
    view: null as any,
    async setViewState(state: { type: string }) {
      leaf.type = state.type;
      ws.leaves.push(leaf);
      // A slow view load, as a real one can be: a second open must wait for this one.
      await sleep(20);
      leaf.view = ws.factory(leaf);
      document.getElementById("host")!.replaceChildren(leaf.view.containerEl);
      await leaf.view.onOpen();
    },
    detach() {
      ws.leaves.splice(ws.leaves.indexOf(leaf), 1);
      void leaf.view?.onClose();
    },
  };
  return leaf;
}

async function main() {
  const log: any[] = [];
  const ws = makeWorkspace();
  const vaultHandlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const app: any = { workspace: ws, vault: { on: (name: string, cb: (...a: unknown[]) => void) => ((vaultHandlers[name] ??= []).push(cb), { name }) }, metadataCache: {} };
  let memo17 = "시험 범위";
  let selection = "";
  let materialDelay = 0;
  let slideListDelay = 0;
  const calls: any[] = [];
  const settings = structuredClone(DEFAULT_SETTINGS);
  const segments = [
    { startMs: 29 * 60_000 + 10_000, endMs: 29 * 60_000 + 20_000, text: "작은 수를 먼저 더합니다." },
    { startMs: 29 * 60_000 + 41_000, endMs: 29 * 60_000 + 50_000, text: "큰 수에 더하면 사라집니다." },
  ];
  let briefStatus = "ok";
  let answer = { pieces: ["부동소수점 ", "덧셈은 작은 수부터 더한다 [슬라이드 17]. ", "시각 [29:10], 범위 [슬라이드 16~18], 없는 [슬라이드 99].\n\n", "`[슬라이드 17]` 은 코드다 (강의 자료 밖)"], mode: "ok" as string, error: "" };
  let release: (() => void) | null = null;
  const host: any = {
    data: { settings, cliDetection: { claude: { path: "/x/claude" }, codex: { path: "/x/codex" } } },
    chatThreads: new ThreadStore(),
    modelCatalog: () => ({ claude: [], codex: { models: [], efforts: {} }, resolved: { "claude-cli:sonnet": { id: "claude-sonnet-5-5", at: "2026-10-29" } } }),
    saveTaskDefault: async () => {},
    chatLecture: async (path: string) =>
      (calls.push({ lecture: path }), path === L5 || path === L4)
        ? { notePath: path, name: path === L5 ? "L5" : "L4", subject: "CSED423", kind: "slides", pdfPath: path.replace(/\.md$/, ".pdf"), slideCount: 30, sectionCount: 0, lengthMs: 60 * 60_000, neighbours: { prev: "L4", next: "L6" } }
        : path === L9
          ? { notePath: L9, name: "L9", subject: "CSED423", kind: "transcript", pdfPath: null, slideCount: 0, sectionCount: 3, lengthMs: 36 * 60_000, neighbours: { prev: "L8", next: null } }
          : null,
    chatBrief: async (path: string) => {
      calls.push({ briefRead: path });
      if (briefStatus === "broken") throw new Error("brief unreadable");
      return { status: briefStatus, body: briefStatus === "missing" ? null : "## 개요\n부동소수점 덧셈을 다룬다.", path: path.replace("/Lectures/", "/Briefs/").replace(/\.md$/, " brief.md"), sourceHash: "abcd1234" };
    },
    buildChatBrief: async (path: string, force: boolean, withAi?: boolean) => {
      calls.push({ build: path, force, ...(withAi ? { withAi } : {}) });
      briefStatus = "ok";
    },
    briefAiEstimate: async (path: string) => (path === L4 ? 2400 : null),
    rebuildBrief: async () => true,
    chatMaterial: async (l: any, slide: number) => (materialDelay && (await sleep(materialDelay)), l.kind === "transcript" ? {
      // A section of the summary note: its summary, memo and the transcript of its range.
      slideText: "",
      image: null,
      commentary: `구간 ${slide} 요약: 캐시를 다룬다.`,
      memo: slide === 2 ? "구간 메모" : "",
      segments: slide === 2 ? [{ startMs: 13 * 60_000, endMs: 13 * 60_000 + 10_000, text: "캐시는 가까운 저장소입니다." }] : [],
      spans: [{ slide, startMs: SECTIONS[slide][0], endMs: SECTIONS[slide][1], low: false }],
      transcriptEndMs: null,
    } : {
      slideText: `Slide ${slide} floating point addition`,
      image: null,
      commentary: `해설 ${slide}: 작은 수끼리 먼저 더한다.`,
      memo: slide === 17 ? memo17 : "",
      segments: slide === 17 ? segments : [],
      spans: slide === 17 ? [{ slide: 17, startMs: 29 * 60_000 + 6_000, endMs: 35 * 60_000 + 56_000, low: false }] : [],
      transcriptEndMs: null,
    }),
    runChat: async (req: any) => {
      calls.push({ run: req });
      if (answer.mode === "error") throw new Error(answer.error);
      if (answer.mode === "whole") {
        // Codex: no piece, the whole answer at the end.
        await sleep(2300);
        req.onDelta(answer.pieces.join(""));
        return { text: answer.pieces.join(""), usage: { calls: 1, inputTokens: 17000, cachedInputTokens: 0, outputTokens: 400, imagesSent: 0, costUsd: 0 }, model: "" };
      }
      if (answer.mode === "hang") {
        req.onDelta("받은 부분");
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          req.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      for (const p of answer.pieces) {
        req.onDelta(p);
        await sleep(120);
      }
      return { text: answer.pieces.join(""), usage: { calls: 1, inputTokens: 5100, cachedInputTokens: 3000, outputTokens: 400, imagesSent: 0, costUsd: 0 }, model: "claude-sonnet-5-5" };
    },
    chatErrorInfo: (e: Error) => ({ kind: e.message.split(":")[0], message: e.message.split(":").slice(1).join(":").trim() || e.message }),
    chatSlideList: async (l: any) => {
      calls.push({ slideList: l.name });
      if (slideListDelay) await sleep(slideListDelay);
      return Array.from({ length: 30 }, (_, i) => ({ num: i + 1, gist: `요지 ${i + 1}`, range: i === 14 ? "[26:26~28:38]" : i === 15 ? "[28:38~28:59?]" : "", tokens: { slideText: 100, commentary: 200, transcript: 300, memo: 0 } }));
    },
    chatOtherBrief: async (l: any) => (calls.push({ otherBrief: l.name }), "## 개요\nL4 브리프 본문"),
    chatSlideImage: async (l: any, n: number) => (calls.push({ image: `${l.name}:${n}` }), { pageNum: n, mimeType: "image/jpeg", base64: "AAAA" }),
    noteSelection: () => selection,
    chatSubjectBrief: async (path: string) => (calls.push({ subjectBrief: path }), { subject: "CSED423", body: SUBJECT_BODY }),
    chatSlideCorpus: async (l: any) => (
      calls.push({ corpus: l.name }),
      [
        { num: 5, gist: "캐시", text: "캐시 메모리 계층" },
        { num: 16, gist: "큰 수에 더하면 사라진다", text: "작은 수부터 큰 수에 더하면 정밀도가 사라진다" },
        { num: 17, gist: "작은 수부터 더한다", text: "작은 수부터 더해 정밀도를 지킨다. 작은 수부터 더해야 한다" },
        { num: 20, gist: "작은 수끼리 먼저 더해 정밀도를 지킨다", text: "작은 수부터 더해 큰 수의 정밀도를 지킨다" },
      ]
    ),
    saveChatNote: async (thread: any, l: any) => {
      calls.push({ chatNote: { note: l.notePath, turns: turnsOf(thread).map((t) => [t.question, t.material]) } });
      return `Alt2Obsidian/CSED423/Chats/2026-10-30 ${l.name} ${turnsOf(thread)[0].question}.md`;
    },
    saveChatMemo: async (target: any, question: string, answer: string, shorten: boolean) => {
      calls.push({ memo: { target, question, answer: answer.slice(0, 9), shorten } });
      if (shorten) throw new Error("브리프 모델이 없습니다");
    },
    lectureChoices: () => [
      { path: L4, name: "L4", subject: "CSED423" },
      { path: L5, name: "L5", subject: "CSED423" },
    ],
    openSettings: () => calls.push({ settings: true }),
    openLectureViewer: async (p: string) => void calls.push({ viewer: p }),
    gotoSlide: async (l: any, n: number) => void calls.push({ go: "slide", note: l.notePath, n }),
    gotoTime: async (l: any, ms: number) => void calls.push({ go: "time", note: l.notePath, ms }),
    gotoSection: async (l: any, n: number) => void calls.push({ go: "section", note: l.notePath, n }),
    openVaultFile: async () => {},
    closeChatPanel: () => controller.close(),
    chatPanelClosed: (leaf: unknown) => controller.closed(leaf as any),
  };
  const opened: boolean[] = [];
  const controller = new ChatPanelController(ws, (open) => opened.push(open));
  ws.factory = (leaf: any) => {
    const view: any = new (ChatView as any)(leaf, host);
    view.app = app;
    return view;
  };
  const view = () => controller.isOpen() ? ws.getLeavesOfType(VIEW_TYPE_CHAT)[0].view : null;
  const root = () => view()!.containerEl as HTMLElement;
  const text = (sel: string) => Array.from(root().querySelectorAll(sel)).map((e) => (e as HTMLElement).textContent);
  // On a timeout the error carries the panel's state.
  (window as any).debugState = () => JSON.stringify({ a: text(".alt-to-obs-chat-a"), send: root().querySelector(".alt-to-obs-chat-send")?.textContent, runs: calls.filter((c) => c.run).length, status: host.chatThreads.peek(L5)?.items.map((i: any) => i.kind === "turn" ? i.turn.status : i.kind), input: (root().querySelector(".alt-to-obs-chat-input") as any)?.value, notices: (window as any).__notices });
  const button = (label: string, scope: ParentNode = root()) => Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label || b.textContent!.startsWith(label)) as HTMLButtonElement;

  // ---- open and close: the right sidebar comes back as it was (spec 5.1) ----
  await controller.open();
  log.push({ step: "opened (sidebar was collapsed)", open: controller.isOpen(), collapsed: ws.rightSplit.collapsed, events: [...opened] });
  await controller.toggle();
  log.push({ step: "toggled closed", open: controller.isOpen(), collapsed: ws.rightSplit.collapsed, collapses: ws.rightSplit.collapses, events: [...opened] });
  ws.rightSplit.expand();
  await controller.open();
  ws.getLeavesOfType(VIEW_TYPE_CHAT)[0].detach(); // the user closes the tab itself
  log.push({ step: "tab closed (sidebar was open)", open: controller.isOpen(), collapsed: ws.rightSplit.collapsed, collapses: ws.rightSplit.collapses });
  // Restored with the layout at startup, before the layout is ready: it reads nothing (no lecture, no brief), then it is detached and the sidebar left alone.
  ws.layoutReady = false;
  ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L5, pdfPath: "L5.pdf" }), getCurrentSlide: () => 3 } };
  const restored = makeLeaf(ws);
  await restored.setViewState({ type: VIEW_TYPE_CHAT });
  ws.trigger("active-leaf-change");
  await sleep(50);
  const readBeforeReady = calls.filter((c) => c.lecture || c.briefRead).length;
  controller.detachRestored();
  ws.layoutReady = true;
  log.push({ step: "restored and detached", open: controller.isOpen(), collapsed: ws.rightSplit.collapsed, collapses: ws.rightSplit.collapses, readBeforeReady });
  // A restored tab whose view was never shown (deferred): detaching it still turns the viewer buttons off.
  opened.length = 0;
  ws.leaves.push({ type: VIEW_TYPE_CHAT, view: null, detach() { ws.leaves.splice(ws.leaves.indexOf(this), 1); } });
  controller.detachRestored();
  log.push({ step: "deferred restored", open: controller.isOpen(), events: [...opened] });
  // A double click opens one panel.
  opened.length = 0;
  await Promise.all([controller.open(), controller.toggle(), controller.open()]);
  log.push({ step: "double open", panels: ws.getLeavesOfType(VIEW_TYPE_CHAT).length, events: [...opened] });
  controller.close();

  // ---- no lecture: the picker card (spec 5.6) ----
  ws.mostRecent = { view: { getViewType: () => "markdown", file: { path: "notes/shopping.md", extension: "md" }, editor: { getCursor: () => ({ line: 0 }), getValue: () => "# shopping" } } };
  await controller.open();
  await until("the no-lecture card", () => !!root().querySelector(".alt-to-obs-chat-card.is-empty"));
  log.push({ step: "no lecture", card: text(".alt-to-obs-chat-card.is-empty strong")[0], composerShown: (root().querySelector(".alt-to-obs-chat-composer") as HTMLElement).style.display !== "none", lectures: Array.from(root().querySelectorAll(".alt-to-obs-chat-pick select")[1].querySelectorAll("option")).map((o) => o.textContent) });
  (root().querySelectorAll(".alt-to-obs-chat-pick select")[1] as HTMLSelectElement).value = L5;
  (root().querySelector(".alt-to-obs-chat-pick input") as HTMLInputElement).value = "14-15, 99";
  button("이 강의로 시작").click();
  await until("the lecture", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📄 슬라이드 14")));
  log.push({ step: "started with a range", chips: text(".alt-to-obs-chat-chip"), notices: [...((window as any).__notices ?? [])], pinned: root().querySelector(".alt-to-obs-chat-pin")!.classList.contains("is-active") });

  // ---- the viewer's lecture and slide, following ----
  ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L5, pdfPath: "L5.pdf" }), getCurrentSlide: () => 17 } };
  ws.trigger("active-leaf-change");
  await sleep(50);
  // Same lecture: the pinned range stays; unpin to follow the viewer.
  root().querySelector<HTMLButtonElement>(".alt-to-obs-chat-pin")!.click();
  await until("slide 17 followed", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📄 슬라이드 17 · 따라가는 중")));
  await until("slide 17 material", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("🎙 전사")));
  // The added slide 15 goes with ×.
  button("📄 슬라이드 15").click();
  const chipState = () => Array.from(root().querySelectorAll(".alt-to-obs-chat-chip")).map((c) => `${c.textContent}|${c.className.replace("alt-to-obs-chat-chip", "").trim()}`);
  log.push({ step: "following 17", chips: chipState(), title: root().querySelector(".alt-to-obs-chat-chip")!.getAttribute("title"), estimate: text(".alt-to-obs-chat-estimate")[0], head: text(".alt-to-obs-chat-lecture")[0] });
  // The note is edited (the memo emptied): the chips are read again once it settles.
  memo17 = "";
  for (const cb of vaultHandlers.modify ?? []) cb(new (TFile as any)(L5));
  await until("the memo chip read again", () => chipState().some((c) => c.startsWith("✏️ 비어 있음")));
  log.push({ step: "note edited", memo: chipState().find((c) => c.startsWith("✏️")) });
  memo17 = "시험 범위";
  for (const cb of vaultHandlers.modify ?? []) cb(new (TFile as any)(L5));
  await until("the memo back", () => chipState().some((c) => c.startsWith("✏️ 내 메모")));
  // A chip click turns its material off and on.
  button("🎙 전사").click();
  const transcriptOff = chipState().find((c) => c.startsWith("🎙"));
  button("🎙 전사").click();
  log.push({ step: "chip toggles", off: transcriptOff, on: chipState().find((c) => c.startsWith("🎙")) });

  // ---- Enter sends, but not while a Korean syllable is composed (spec 5.3) ----
  let input = root().querySelector(".alt-to-obs-chat-input") as HTMLTextAreaElement;
  const runs = () => calls.filter((c) => c.run).length;
  input.value = "왜 작은 수부터 더해?";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(100);
  log.push({ step: "composing", runs: runs(), value: input.value });
  // The memo changed after the chips were read: the send reads it again (spec 6.2). Two Enters: one question.
  memo17 = "시험 범위, 오늘 고친 메모";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const disabledWhileSending = input.disabled;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  button("더 쉽게").click();
  await until("streaming", () => !!root().querySelector(".alt-to-obs-chat-a.is-streaming")?.textContent);
  const during = root().querySelector(".alt-to-obs-chat-a")!;
  log.push({ step: "streaming", runs: runs(), streaming: during.classList.contains("is-streaming"), partial: during.textContent, sendButton: (root().querySelector(".alt-to-obs-chat-send") as HTMLElement).textContent, cleared: input.value, disabledWhileSending, turns: text(".alt-to-obs-chat-turn").length });
  await until("the answer", () => !root().querySelector(".alt-to-obs-chat-a.is-streaming") && !!root().querySelector(".alt-to-obs-chat-usage"));
  const a = root().querySelector(".alt-to-obs-chat-a")!;
  const req = calls.filter((c) => c.run).pop().run;
  log.push({
    step: "answered",
    cites: Array.from(a.querySelectorAll(".alt-to-obs-chat-cite")).map((c) => `${c.className.replace("alt-to-obs-chat-cite", "").trim()}:${c.textContent}`),
    code: a.querySelector("code")?.textContent,
    codeCites: a.querySelectorAll("code .alt-to-obs-chat-cite").length,
    plainMissing: a.textContent!.includes("[슬라이드 99]"),
    usage: text(".alt-to-obs-chat-usage")[0],
    label: text(".alt-to-obs-chat-q-meta")[0],
    system: req.system.split("\n\n").slice(-1)[0],
    userHead: req.user.split("\n").slice(0, 2),
    memoSent: req.user.includes("### 내 메모"),
    memoText: req.user.split("### 내 메모\n")[1]?.split("\n")[0] ?? null,
    transcriptSent: req.user.includes("[29:10] 작은 수를 먼저 더합니다."),
    task: req.task,
  });

  // ---- related slides under the answer (spec 5.11): the current slide left out; a click adds one for the next question ----
  {
    const turnEl = a.closest(".alt-to-obs-chat-turn")!;
    const rows = () => Array.from(turnEl.querySelectorAll(".alt-to-obs-chat-related-item")).map((r) => `${r.querySelector(".alt-to-obs-chat-related-text")!.textContent}|${r.querySelector("button")!.textContent}`);
    const before = rows();
    const runsBefore = runs();
    (turnEl.querySelector(".alt-to-obs-chat-related-item button") as HTMLButtonElement).click();
    await until("the related slide added", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📄 슬라이드 20 ×")));
    const after = rows();
    const disabled = (turnEl.querySelector(".alt-to-obs-chat-related-item button") as HTMLButtonElement).disabled;
    button("📄 슬라이드 20").click();
    log.push({ step: "related slides", before, after, disabled, sentNothing: runs() === runsBefore, corpus: calls.filter((c) => c.corpus).map((c) => c.corpus), removed: !text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📄 슬라이드 20")) });
  }

  // ---- the grounding chips go where they point (spec 5.5) ----
  (a.querySelector(".alt-to-obs-chat-cite.is-slide") as HTMLElement).click();
  (a.querySelector(".alt-to-obs-chat-cite.is-time") as HTMLElement).click();
  (Array.from(a.querySelectorAll(".alt-to-obs-chat-cite.is-slide"))[1] as HTMLElement).click();
  (a.querySelector(".alt-to-obs-chat-cite.is-outside") as HTMLElement).click();
  await sleep(50);
  const gone = calls.filter((c) => c.go).map((c) => `${c.go}:${c.n ?? c.ms}`);
  // From the keyboard: Enter and Space go, another key does nothing.
  const key = (sel: string, k: string) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    a.querySelector(sel)!.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const prevented = [key(".alt-to-obs-chat-cite.is-time", "Enter"), key(".alt-to-obs-chat-cite.is-slide", " "), key(".alt-to-obs-chat-cite.is-slide", "a")];
  await sleep(50);
  const keyed = calls.filter((c) => c.go).map((c) => `${c.go}:${c.n ?? c.ms}`).slice(gone.length);
  log.push({ step: "chips navigate", gone, keyed, prevented, role: a.querySelector(".alt-to-obs-chat-cite.is-slide")!.getAttribute("role"), outsideRole: a.querySelector(".alt-to-obs-chat-cite.is-outside")!.getAttribute("role") });

  // ---- copying from an answer leaves out the sanitizer's zero-width spaces (a selection, a code block's copy button) ----
  {
    const zw = "\u200B";
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    const pre = a.createEl("pre");
    // A rendered code block's text ends in a newline.
    pre.createEl("code", { text: `#include <${zw}stdio.h>\nvector<${zw}int> v;\n` });
    let obsidianCopied = false;
    pre.createEl("button", { cls: "copy-code-button", text: "Copy" }).addEventListener("click", () => (obsidianCopied = true));
    const copyOf = (node: Node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      document.getSelection()!.removeAllRanges();
      document.getSelection()!.addRange(range);
      const e = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      (node instanceof Element ? node : node.parentElement!).dispatchEvent(e);
      return { text: e.clipboardData!.getData("text/plain"), prevented: e.defaultPrevented };
    };
    const selection = copyOf(pre.querySelector("code")!);
    const plain = copyOf(a.querySelector("p")!);
    (pre.querySelector(".copy-code-button") as HTMLElement).click();
    await sleep(20);
    pre.remove();
    delete (navigator as any).clipboard;
    document.getSelection()!.removeAllRanges();
    log.push({ step: "copy without zero-width spaces", selection, plain, button: copied, obsidianCopied });
  }

  // ---- 메모에 저장 (spec 5.9): the question's first focus slide, as it is or cut to three lines ----
  const noticesBeforeMemo = ((window as any).__notices ?? []).length;
  button("메모에 저장", a.closest(".alt-to-obs-chat-turn")!).click();
  const memoMenu = (Menu as any).shown;
  memoMenu.items[0].click();
  memoMenu.items[1].click();
  await until("both memo saves", () => calls.filter((c) => c.memo).length === 2 && ((window as any).__notices ?? []).length >= noticesBeforeMemo + 3);
  log.push({ step: "memo", items: memoMenu.items.map((i: any) => i.title), saved: calls.filter((c) => c.memo).map((c) => c.memo), notices: ((window as any).__notices ?? []).slice(noticesBeforeMemo) });

  // ---- 대화 노트로 저장 (spec 5.9): the thread with what each turn sent ----
  const noticesBeforeNote = ((window as any).__notices ?? []).length;
  button("메모에 저장", a.closest(".alt-to-obs-chat-turn")!).click();
  (Menu as any).shown.items[2].click();
  await until("the chat note", () => calls.some((c) => c.chatNote) && ((window as any).__notices ?? []).length > noticesBeforeNote);
  log.push({ step: "chat note", saved: calls.find((c) => c.chatNote).chatNote, notice: ((window as any).__notices ?? [])[noticesBeforeNote] });

  // ---- closing the panel does not stop an answer (spec 5.4); a panel opened again shows it ----
  const original = answer;
  const slow = { ...answer, pieces: ["닫아도 ", "계속 ", "쓴다 [슬라이드 17]."] };
  answer = slow;
  input.value = "닫아도 돼?";
  button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
  await until("the slow answer started", () => text(".alt-to-obs-chat-a").some((t) => t!.startsWith("닫아도")));
  const live = Component.live;
  button("×").click();
  const closedRun = calls.filter((c) => c.run).pop().run;
  await sleep(500);
  await controller.open();
  await until("the reopened turn", () => text(".alt-to-obs-chat-a").some((t) => t!.startsWith("닫아도 계속 쓴다")) && !!root().querySelectorAll(".alt-to-obs-chat-usage")[1]);
  input = root().querySelector(".alt-to-obs-chat-input") as HTMLTextAreaElement;
  log.push({
    step: "outlived the panel",
    aborted: closedRun.signal.aborted,
    answers: text(".alt-to-obs-chat-a").map((t) => t!.slice(0, 12)),
    status: host.chatThreads.peek(L5).items.filter((i: any) => i.kind === "turn").map((i: any) => i.turn.status),
    liveBeforeClose: live,
  });
  answer = original;

  // ---- a slide change during the thread: a divider (spec 5.2) ----
  ws.trigger(SLIDE_CHANGE_EVENT, { mdPath: L5, pdfPath: "L5.pdf", page: 18 });
  await sleep(50);
  log.push({ step: "moved", dividers: text(".alt-to-obs-chat-divider"), chip: text(".alt-to-obs-chat-chip").find((t) => t!.startsWith("📄")) });

  // ---- stop: the partial answer stays, marked, and is not sent again (spec 5.4) ----
  answer = { ...answer, mode: "hang" };
  input.value = "더 길게";
  button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
  await until("the partial answer", () => root().querySelector(".alt-to-obs-chat-send")!.textContent === "중지" && text(".alt-to-obs-chat-a").some((t) => t === "받은 부분"));
  (root().querySelector(".alt-to-obs-chat-send") as HTMLButtonElement).click();
  await until("stopped", () => text(".alt-to-obs-chat-status").includes("(중지됨)"));
  answer = { ...answer, mode: "ok" };
  input.value = "다음 질문";
  button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
  await until("the fourth answer", () => calls.filter((c) => c.run).length === 4 && !root().querySelector(".alt-to-obs-chat-a.is-streaming"));
  const third = calls.filter((c) => c.run).pop().run.user as string;
  log.push({ step: "stopped", memoButtons: text(".alt-to-obs-chat-actions button").filter((t) => t === "메모에 저장").length, answers: text(".alt-to-obs-chat-a").map((t) => t!.slice(0, 12)), history: third.split("[이번 자료]")[0], hasStopped: third.includes("더 길게") });

  // ---- Enter, then 다시 생성 while the question is being prepared: one run; the input keeps its focus ----
  materialDelay = 150;
  const runsBeforePrep = runs();
  input.focus();
  input.value = "준비 중에 다시 생성?";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const regen = button("다시 생성");
  const regenDisabled = regen.disabled;
  regen.click();
  await until("the prepared question answered", () => runs() === runsBeforePrep + 1 && !root().querySelector(".alt-to-obs-chat-a.is-streaming"));
  await sleep(300);
  log.push({ step: "regenerate while sending", runs: runs() - runsBeforePrep, focused: document.activeElement === input, last: calls.filter((c) => c.run).pop().run.user.split("[질문]\n")[1], regenDisabled });
  materialDelay = 0;

  // ---- error cards (spec 5.6) ----
  const cards: any[] = [];
  for (const kind of ["auth", "limit", "missing", "timeout", "other"]) {
    answer = { ...answer, mode: "error", error: `${kind}: ${kind === "limit" ? "Claude usage limit reached. Your limit resets at 5pm." : "boom"}` };
    input.value = `오류 ${kind}`;
    button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
    await until(`error ${kind}`, () => !!root().querySelector(`.alt-to-obs-chat-error.is-${kind}`));
    const card = root().querySelectorAll(`.alt-to-obs-chat-error.is-${kind}`)[0] as HTMLElement;
    cards.push({ kind, title: card.querySelector("strong")!.textContent, fix: card.querySelector("p")!.textContent, buttons: Array.from(card.querySelectorAll("button")).map((b) => b.textContent) });
  }
  // "Codex로 보내기" sends the same question with the Codex defaults; it answers all at once (no pieces), the clock running meanwhile.
  answer = { ...answer, mode: "whole" };
  const last = root().querySelectorAll(".alt-to-obs-chat-error.is-other")[0] as HTMLElement;
  button("Codex로 보내기", last).click();
  const codexStatus = () => text(".alt-to-obs-chat-status").find((t) => t!.startsWith("답변 쓰는 중")) ?? "";
  await until("the Codex status", () => codexStatus() !== "");
  const codexFirst = codexStatus();
  await until("the clock ticks", () => /· [1-9]초 ·/.test(codexStatus()));
  const codexTicked = codexStatus();
  await until("the retried answer", () => calls.filter((c) => c.run).pop().run.task.provider === "codex-cli" && !root().querySelector(".alt-to-obs-chat-a.is-streaming") && !root().querySelector(".alt-to-obs-chat-error.is-other"));
  answer = { ...answer, mode: "ok" };
  button("설정 열기", root().querySelector(".alt-to-obs-chat-error")!).click();
  log.push({ step: "errors", cards, retried: calls.filter((c) => c.run).pop().run.task, settingsOpened: calls.some((c) => c.settings), codexFirst, codexTicked });

  // ---- the brief cannot be read now: the last state stays (no "읽는 중" forever) ----
  briefStatus = "broken";
  const runsBeforeBroken = runs();
  input.value = "브리프가 안 읽혀도?";
  button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
  await until("sent without a fresh brief", () => runs() === runsBeforeBroken + 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기");
  log.push({ step: "brief unreadable", chip: text(".alt-to-obs-chat-chip")[0], sentBrief: calls.filter((c) => c.run).pop().run.system.includes("[강의 브리프: CSED423 · L5") });
  briefStatus = "ok";

  // ---- the per-question cap: asked in the panel first (spec 5.4) ----
  settings.chatTokenCap = 2000;
  const liveBeforeClear = Component.live;
  button("새 대화").click();
  const liveAfterClear = Component.live;
  const before = runs();
  input.value = "아주 긴 질문 ".repeat(400);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await until("the cap question", () => (root().querySelector(".alt-to-obs-chat-cap") as HTMLElement).style.display !== "none" && !!root().querySelector(".alt-to-obs-chat-cap")!.textContent);
  log.push({ step: "over the cap", runs: runs() - before, cap: root().querySelector(".alt-to-obs-chat-cap")!.textContent, liveBeforeClear, liveAfterClear, threadGone: !host.chatThreads.peek(L5) });
  button("그래도 보내기").click();
  await until("sent anyway", () => runs() - before === 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기");
  settings.chatTokenCap = 20000;

  // ---- brief cards (spec 5.6) ----
  briefStatus = "missing";
  ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L4, pdfPath: "L4.pdf" }), getCurrentSlide: () => 3 } };
  ws.trigger("active-leaf-change");
  await until("the missing brief card", () => !!root().querySelector(".alt-to-obs-chat-card.is-warning"));
  const missing = { card: text(".alt-to-obs-chat-card strong")[0], chip: text(".alt-to-obs-chat-chip")[0], head: text(".alt-to-obs-chat-lecture")[0], thread: text(".alt-to-obs-chat-turn").length, buttons: Array.from(root().querySelectorAll(".alt-to-obs-chat-card button")).map((b) => b.textContent) };
  button("노트로 바로 만들기").click();
  await until("brief built", () => !root().querySelector(".alt-to-obs-chat-card"));
  log.push({ step: "brief missing", ...missing, built: calls.find((c) => c.build), chipAfter: text(".alt-to-obs-chat-chip")[0] });
  briefStatus = "edited-stale";
  ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L5, pdfPath: "L5.pdf" }), getCurrentSlide: () => 18 } };
  ws.trigger("active-leaf-change");
  await until("the stale card", () => text(".alt-to-obs-chat-card strong").includes("브리프가 노트보다 오래됐습니다"));
  const stale = { chip: text(".alt-to-obs-chat-chip")[0], buttons: Array.from(root().querySelectorAll(".alt-to-obs-chat-card button")).map((b) => b.textContent), thread: text(".alt-to-obs-chat-turn").length };
  button("새로 만들기").click();
  const confirm = Array.from(root().querySelectorAll(".alt-to-obs-chat-card button")).map((b) => b.textContent);
  button("덮어쓰기").click();
  await until("rebuilt", () => calls.filter((c) => c.build).length === 2);
  log.push({ step: "brief stale", ...stale, confirm, rebuilt: calls.filter((c) => c.build)[1] });

  // ---- + 자료 추가 (spec 5.7): this lecture's slides, another lecture with its brief, the selected text ----
  const pop = () => root().querySelector(".alt-to-obs-chat-popover") as HTMLElement | null;
  const rowNums = (sel: string) => Array.from(pop()!.querySelectorAll<HTMLInputElement>(`input[data-slide]${sel}`)).map((b) => Number(b.dataset.slide));
  button("+ 자료 추가").click();
  await until("the slide list", () => !!pop()?.querySelector(".alt-to-obs-chat-popover-row"));
  const tabs = text(".alt-to-obs-chat-popover-tab");
  const rangeEl = pop()!.querySelector<HTMLInputElement>(".alt-to-obs-chat-popover-range input")!;
  rangeEl.value = "14-16, 40";
  rangeEl.dispatchEvent(new Event("input"));
  // The note changes while the popover is open: the chips are read again, what is typed stays.
  const readsBefore = calls.filter((c) => c.briefRead).length;
  for (const cb of vaultHandlers.modify ?? []) cb(new (TFile as any)(L5));
  await sleep(500);
  const typed = {
    rows: pop()!.querySelectorAll(".alt-to-obs-chat-popover-row").length,
    locked: rowNums(":disabled"),
    checked: rowNums(":checked"),
    note: pop()!.querySelector(".alt-to-obs-chat-popover-note")!.textContent,
    summary: pop()!.querySelector(".alt-to-obs-chat-popover-summary")!.textContent,
    time15: pop()!.querySelectorAll(".alt-to-obs-chat-popover-time")[0]?.textContent,
    time16: pop()!.querySelectorAll(".alt-to-obs-chat-popover-time")[1]?.textContent,
    uncertain: pop()!.querySelectorAll(".alt-to-obs-chat-uncertain").length,
    rangeKept: (pop()!.querySelector(".alt-to-obs-chat-popover-range input") as HTMLInputElement).value,
    rereadWhileOpen: calls.filter((c) => c.briefRead).length > readsBefore,
  };
  pop()!.querySelector<HTMLInputElement>('input[data-include="image"]')!.click();
  const withImage = pop()!.querySelector(".alt-to-obs-chat-popover-summary")!.textContent;
  button("추가", pop()!).click();
  await until("the added slides", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📄 슬라이드 16 ×")) && calls.filter((c) => c.image).length === 3);
  const afterThis = { chips: text(".alt-to-obs-chat-chip").filter((t) => t!.startsWith("📄")), images: calls.filter((c) => c.image).map((c) => c.image), closed: !pop() };
  button("+ 자료 추가").click();
  button("다른 강의", pop()!).click();
  await until("the other lecture's list", () => !!pop()?.querySelector(".alt-to-obs-chat-popover-row"));
  const otherLecture = (pop()!.querySelectorAll("select")[1] as HTMLSelectElement).value;
  pop()!.querySelector<HTMLInputElement>('input[data-slide="2"]')!.click();
  const otherSummary = pop()!.querySelector(".alt-to-obs-chat-popover-summary")!.textContent;
  // "과목 브리프 넣기" (spec 5.10).
  const subjectBox = pop()!.querySelector<HTMLInputElement>("input[data-subject-brief]")!;
  const subjectOffer = { label: subjectBox.parentElement!.textContent, checked: subjectBox.checked, disabled: subjectBox.disabled };
  subjectBox.click();
  // The subject brief's tokens join the estimate once read.
  const subjectSummaryExpected = `브리프, 과목 브리프와 1장 추가 · 약 ${((600 + estimateTextTokens(SUBJECT_BODY)) / 1000).toFixed(1)}k 토큰`;
  await until("the subject brief's tokens", () => pop()!.querySelector(".alt-to-obs-chat-popover-summary")!.textContent === subjectSummaryExpected);
  const subjectSummary = pop()!.querySelector(".alt-to-obs-chat-popover-summary")!.textContent;
  button("추가", pop()!).click();
  await until("the other lecture added", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📚 L4 브리프 ×")) && text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("📚 CSED423 과목 브리프 ×")));
  button("+ 자료 추가").click();
  button("노트에서 선택한 글", pop()!).click();
  const noSelection = { text: pop()!.querySelector(".alt-to-obs-muted")?.textContent, disabled: button("인용으로 넣기", pop()!).disabled };
  button("취소", pop()!).click();
  selection = "  선택한 문장입니다.\n둘째 줄  ";
  button("+ 자료 추가").click();
  button("노트에서 선택한 글", pop()!).click();
  const quoted = pop()!.querySelector(".alt-to-obs-chat-popover-quote")!.textContent;
  button("인용으로 넣기", pop()!).click();
  await until("the quote chip", () => text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("❝ 선택한 글 ×")));
  const added = text(".alt-to-obs-chat-chip").filter((t) => /^(📄|📚|❝)/.test(t!));
  const runsBeforeAdded = runs();
  // The answer cites the other lecture's slide (spec 5.5): `[L4 슬라이드 2]`; this lecture by name; a lecture not sent.
  answer = { ...answer, pieces: ["다른 강의 [L4 슬라이드 2], ", "이 강의 [L5 슬라이드 14], 안 보낸 [L3 슬라이드 1]."] };
  input.value = "자료를 더하고 묻기";
  button("보내기", root().querySelector(".alt-to-obs-chat-composer")!).click();
  await until("the answer with added material", () => runs() === runsBeforeAdded + 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기");
  const addedReq = calls.filter((c) => c.run).pop().run;
  const lastAnswer = () => Array.from(root().querySelectorAll(".alt-to-obs-chat-a")).pop() as HTMLElement;
  const citesOf = (el: HTMLElement) => Array.from(el.querySelectorAll(".alt-to-obs-chat-cite")).map((c) => `${c.textContent}|${c.getAttribute("title")}`);
  const otherCites = citesOf(lastAnswer());
  (lastAnswer().querySelector(".alt-to-obs-chat-cite.is-slide") as HTMLElement).click();
  await until("the other lecture's slide", () => calls.some((c) => c.go && c.note === L4));
  const otherGone = calls.filter((c) => c.go).pop();
  button("❝ 선택한 글 ×").click();
  log.push({
    step: "add material",
    tabs,
    typed,
    withImage,
    afterThis,
    otherLecture,
    otherSummary,
    otherBriefRead: calls.filter((c) => c.otherBrief).map((c) => c.otherBrief),
    noSelection,
    quoted,
    added,
    headings: addedReq.user.match(/^## .+$/gm),
    quoteSent: addedReq.user.split("[선택한 글]\n")[1]?.split("\n\n")[0] ?? null,
    otherBriefSent: addedReq.system.includes("[다른 강의 브리프: CSED423 · L4]\n## 개요\nL4 브리프 본문"),
    subjectOffer,
    subjectSummary,
    subjectSummaryExpected,
    subjectBriefSent: addedReq.system.includes("[과목 브리프: CSED423]\n- L4 (2026-09-23, 슬라이드 20장): 렉서를 다룬다.\n- L5 (2026-09-30, 슬라이드 30장): 부동소수점 덧셈을 다룬다.\n\n[다른 강의 브리프: CSED423 · L4]"),
    subjectBriefRead: calls.filter((c) => c.subjectBrief).map((c) => c.subjectBrief),
    images: addedReq.images.map((i: any) => i.pageNum),
    quoteAfterRemove: text(".alt-to-obs-chat-chip").some((t) => t!.startsWith("❝")),
    otherCites,
    otherGone,
    otherPlain: lastAnswer().textContent!.includes("[L3 슬라이드 1]"),
  });

  // ---- a slide list that arrives after the tab or the lecture changed is dropped (review LOW 1) ----
  slideListDelay = 150;
  button("+ 자료 추가").click();
  button("다른 강의", pop()!).click();
  await sleep(400);
  const lists = () => ({ pickers: pop()!.querySelectorAll(".alt-to-obs-chat-popover-list").length, adds: Array.from(pop()!.querySelectorAll("button")).filter((b) => b.textContent === "추가").length, summary: pop()!.querySelector(".alt-to-obs-chat-popover-summary")?.textContent ?? null });
  const afterTab = lists();
  const lockedBox = pop()!.querySelector<HTMLInputElement>("input[data-subject-brief]");
  const subjectLocked = lockedBox ? { label: lockedBox.parentElement!.textContent, checked: lockedBox.checked, disabled: lockedBox.disabled } : null;
  const lectureSelect = pop()!.querySelectorAll("select")[1] as HTMLSelectElement;
  lectureSelect.dispatchEvent(new Event("change"));
  lectureSelect.dispatchEvent(new Event("change"));
  await sleep(400);
  const afterPick = lists();
  slideListDelay = 0;
  button("취소", pop()!).click();
  log.push({ step: "stale slide lists", afterTab, afterPick, closed: !pop(), subjectLocked });

  // ---- right-click questions (spec 5.8): pinned on a slide; a selection as the quote, the input focused ----
  const chips = () => Array.from(root().querySelectorAll(".alt-to-obs-chat-chip"));
  const label = (c: Element) => c.textContent!.slice(0, c.textContent!.length - (c.querySelector(".alt-to-obs-chat-chip-tokens")?.textContent?.length ?? 0));
  const slideChip = () => chips().map(label).find((t) => t.startsWith("📄"));
  const quoteChip = () => chips().find((c) => c.textContent!.startsWith("❝"))?.getAttribute("title");
  const isPinned = () => root().querySelector(".alt-to-obs-chat-pin")!.classList.contains("is-active");
  input.blur();
  await view().askAboutSlide(L5, 12);
  const sameSlide = { chip: slideChip(), pinned: isPinned(), focused: document.activeElement === input };
  input.blur();
  await view().askAboutSelection(L5, 12, "  인용할 문장  ");
  const sameQuote = { quote: quoteChip(), focused: document.activeElement === input };
  await view().askAboutSlide(L4, 5);
  const otherSlide = { head: text(".alt-to-obs-chat-lecture")[0], chip: slideChip(), pinned: isPinned(), quote: quoteChip() ?? null };
  await view().askAboutSelection(L5, 20, "다른 노트의 글");
  // Back on L5 after L4, its thread drawn again: the other lecture's chip is still a chip (kept on the turn).
  const otherQuote = { head: text(".alt-to-obs-chat-lecture")[0], chip: slideChip(), quote: quoteChip(), cites: citesOf(lastAnswer()) };
  await view().askAboutSelection("notes/shopping.md", null, "강의 노트가 아닌 글");
  const notLecture = { head: text(".alt-to-obs-chat-lecture")[0], quote: quoteChip() };
  button("❝ 선택한 글 ×").click();
  log.push({ step: "right-click questions", sameSlide, sameQuote, otherSlide, otherQuote, notLecture });

  // ---- a summary note (spec 9): the section above the editor's cursor is the focus; the subject brief offered once (spec 5.10) ----
  {
    const l9 = ["---", 'alt_kind: "transcript"', "---", "# L9", "", "## ⏱ 구간 1 [00:00~12:03]", "요약 1", "", "## ⏱ 구간 2 [12:03~24:00]", "요약 2", "", "## ⏱ 구간 3 [24:00~36:00]", "요약 3", ""].join("\n");
    let line = 9;
    ws.mostRecent = { view: { getViewType: () => "markdown", file: { path: L9, extension: "md" }, editor: { getCursor: () => ({ line }), getValue: () => l9 } } };
    ws.trigger("active-leaf-change");
    await until("the section chip", () => chips().map(label).some((t) => t.startsWith("⏱ 구간 2 [12:03~24:00] · 따라가는 중")));
    await until("the section's transcript", () => chips().map(label).some((t) => t.startsWith("🎙 전사")));
    const focus = { head: text(".alt-to-obs-chat-lecture")[0], chips: chips().map(label).filter((t) => /^(⏱|🎙|✏️)/.test(t)), pinTitle: root().querySelector(".alt-to-obs-chat-pin")!.getAttribute("title") };
    // A question about another lecture: the subject brief offered first; 그냥 보내기 sends without it.
    const runsBefore = runs();
    answer = { ...answer, pieces: ["캐시는 가깝다 [구간 2], ", "시각 [13:00], 없는 [구간 9], 슬라이드는 없다 [슬라이드 3]."] };
    input.value = "지난 강의랑 뭐가 달라?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const suggestEl = () => root().querySelector(".alt-to-obs-chat-suggest") as HTMLElement;
    await until("the suggestion", () => suggestEl().style.display !== "none" && !!suggestEl().textContent);
    const offered = { text: suggestEl().querySelector("span")!.textContent, buttons: Array.from(suggestEl().querySelectorAll("button")).map((b) => b.textContent), runs: runs() - runsBefore, input: input.value };
    button("그냥 보내기", suggestEl()).click();
    await until("sent without the subject brief", () => runs() === runsBefore + 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기" && !!lastAnswer().querySelector(".alt-to-obs-chat-cite"));
    const plainReq = calls.filter((c) => c.run).pop().run;
    const sectionAnswer = lastAnswer();
    const cites = Array.from(sectionAnswer.querySelectorAll(".alt-to-obs-chat-cite")).map((c) => `${c.className.replace("alt-to-obs-chat-cite", "").trim()}:${c.textContent}`);
    const turnEl = sectionAnswer.closest(".alt-to-obs-chat-turn")!;
    const sent = {
      label: turnEl.querySelector(".alt-to-obs-chat-q-meta")?.textContent,
      unit: plainReq.user.split("[이번 자료]\n")[1]?.split("\n\n[질문]")[0],
      subjectBrief: plainReq.system.includes("[과목 브리프:"),
      cites,
      plain: sectionAnswer.textContent!.includes("[슬라이드 3]") && sectionAnswer.textContent!.includes("[구간 9]"),
      related: turnEl.querySelectorAll(".alt-to-obs-chat-related-item").length,
      corpus: calls.filter((c) => c.corpus).some((c) => c.corpus === "L9"),
    };
    (sectionAnswer.querySelector(".alt-to-obs-chat-cite.is-section") as HTMLElement).click();
    (sectionAnswer.querySelector(".alt-to-obs-chat-cite.is-time") as HTMLElement).click();
    await sleep(50);
    const gone = calls.filter((c) => c.go && c.note === L9).map((c) => `${c.go}:${c.n ?? c.ms}`);
    // Once per lecture: the next such question goes as it is.
    input.value = "L4와 비교해줘";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until("the second question", () => runs() === runsBefore + 2 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기");
    const once = { suggestShown: suggestEl().style.display !== "none", subjectBrief: calls.filter((c) => c.run).pop().run.system.includes("[과목 브리프:") };
    // 메모에 저장 goes to the section's memo.
    const noticesBefore = ((window as any).__notices ?? []).length;
    button("메모에 저장", lastAnswer().closest(".alt-to-obs-chat-turn")!).click();
    (Menu as any).shown.items[0].click();
    await until("the section memo", () => calls.filter((c) => c.memo).length === 3);
    const memo = { target: calls.filter((c) => c.memo).pop().memo.target, notice: ((window as any).__notices ?? [])[noticesBefore] };
    // The cursor moves to section 3: a divider; pinned, a move elsewhere changes nothing.
    line = 12;
    ws.trigger("active-leaf-change");
    await until("section 3 followed", () => chips().map(label).some((t) => t.startsWith("⏱ 구간 3 [24:00~36:00] · 따라가는 중")));
    const dividers = text(".alt-to-obs-chat-divider");
    root().querySelector<HTMLButtonElement>(".alt-to-obs-chat-pin")!.click();
    const pinnedTitle = root().querySelector(".alt-to-obs-chat-pin")!.getAttribute("title");
    line = 6;
    ws.trigger("active-leaf-change");
    await sleep(300);
    const pinned = chips().map(label).find((t) => t.startsWith("⏱"));
    log.push({ step: "summary note", focus, offered, sent, gone, once, memo, dividers, pinnedTitle, pinned });

    // Back on L5 (a fresh offer): 넣기 adds the subject brief and sends.
    ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L5, pdfPath: "L5.pdf" }), getCurrentSlide: () => 18 } };
    ws.trigger("active-leaf-change");
    await until("back on L5", () => text(".alt-to-obs-chat-lecture")[0] === "CSED423 · L5");
    const runsL5 = runs();
    input.value = "3강에서 배운 거랑 이어져?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until("the L5 suggestion", () => suggestEl().style.display !== "none" && !!suggestEl().textContent);
    button("넣기", suggestEl()).click();
    await until("sent with the subject brief", () => runs() === runsL5 + 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기");
    const withReq = calls.filter((c) => c.run).pop().run;
    log.push({
      step: "subject brief offer",
      chip: chips().map(label).find((t) => t.startsWith("📚")),
      order: withReq.system.indexOf("[강의 브리프: CSED423 · L5") < withReq.system.indexOf("[과목 브리프: CSED423]\n- L4 (2026-09-23"),
      hidden: suggestEl().style.display === "none",
    });
  }

  // ---- related slides with the 📄 chip off: the current slide may be one, and adding it turns the chip on ----
  {
    ws.mostRecent = { view: { getViewType: () => "alt2obsidian-synced-viewer", getState: () => ({ mdPath: L5, pdfPath: "L5.pdf" }), getCurrentSlide: () => 17 } };
    ws.trigger(SLIDE_CHANGE_EVENT, { mdPath: L5, pdfPath: "L5.pdf", page: 17 });
    await until("slide 17 followed", () => chips().map(label).some((t) => t.startsWith("📄 슬라이드 17 · 따라가는 중")));
    const slideChipEl = () => chips().find((c) => c.textContent!.startsWith("📄 슬라이드 17"))!;
    slideChipEl().click();
    const chipOff = slideChipEl().classList.contains("is-off");
    const runsBefore = runs();
    answer = { ...answer, pieces: ["작은 수부터 더한다 [슬라이드 17]."] };
    input.value = "작은 수부터 더해야 해?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until("the answer with the chip off", () => runs() === runsBefore + 1 && root().querySelector(".alt-to-obs-chat-send")!.textContent === "보내기" && !!lastAnswer().closest(".alt-to-obs-chat-turn")!.querySelector(".alt-to-obs-chat-related-item"));
    const turnEl = lastAnswer().closest(".alt-to-obs-chat-turn")!;
    const rows = Array.from(turnEl.querySelectorAll(".alt-to-obs-chat-related-item"));
    const first = rows.map((r) => r.querySelector(".alt-to-obs-chat-related-text")!.textContent)[0];
    const slideSent = calls.filter((c) => c.run).pop().run.user.includes("## L5 · 슬라이드 17");
    (rows[0].querySelector("button") as HTMLButtonElement).click();
    log.push({ step: "related with the chip off", chipOff, slideSent, first, chipOn: slideChipEl().classList.contains("is-on"), button: rows[0].querySelector("button")!.textContent, added: chips().map(label).filter((t) => t.startsWith("📄")) });
  }

  // ---- the menu, and the × closes the panel ----
  button("⋯").click();
  const menu = (Menu as any).shown;
  log.push({ step: "menu", items: menu.items.map((i: any) => i.title) });
  ws.rightSplit.collapsed = false;
  button("×").click();
  log.push({ step: "closed with ×", open: controller.isOpen(), threadKept: host.chatThreads.peek(L5).items.length > 0, events: opened.slice(-1) });

  // ---- 모든 강의 브리프 만들기 (spec 4.6) ----
  const built: any[] = [];
  const modal: any = new (BriefsModal as any)(app, {
    planAllBriefs: async () => ({ todo: [{ notePath: L4, hasTranscript: true }, { notePath: L5, hasTranscript: false }], aiOnly: ["X/L2.md"], edited: ["X/L1.md"], aiEstimate: { calls: 2, inputTokens: 4800, outputTokens: 1248 } }),
    buildAllBriefs: async (plan: any, withAi: boolean, o: any) => {
      for (const [i, t] of plan.todo.entries()) {
        o.onProgress(i, plan.todo.length, t.notePath);
        await sleep(30);
      }
      built.push(withAi);
      return { made: 1, scriptOnly: 1, skipped: 0, edited: 1, failed: 0, cancelled: false };
    },
  });
  document.getElementById("host")!.replaceChildren(modal.contentEl);
  modal.onOpen();
  await until("the briefs plan", () => modal.contentEl.querySelectorAll("button").length >= 3);
  const planText = modal.contentEl.querySelector("p").textContent;
  const planButtons = Array.from(modal.contentEl.querySelectorAll("button")).map((b: any) => b.textContent);
  const noticesBeforeRun = ((window as any).__notices ?? []).length;
  (Array.from(modal.contentEl.querySelectorAll("button")) as HTMLButtonElement[]).find((b) => b.textContent!.startsWith("강조점 포함"))!.click();
  await until("the briefs summary", () => !!modal.contentEl.querySelector(".alt-to-obs-briefs-summary"));
  const runNotice = ((window as any).__notices ?? [])[noticesBeforeRun];
  // Nothing missing or old, one current brief without its AI part: only 강조점 포함 does something.
  const aiOnlyModal: any = new (BriefsModal as any)(app, {
    planAllBriefs: async () => ({ todo: [], aiOnly: [L4], edited: [], aiEstimate: { calls: 1, inputTokens: 2400, outputTokens: 624 } }),
    buildAllBriefs: async () => ({ made: 1, scriptOnly: 0, skipped: 0, edited: 0, failed: 0, cancelled: false }),
  });
  document.getElementById("host")!.replaceChildren(aiOnlyModal.contentEl);
  aiOnlyModal.onOpen();
  await until("the ai-only plan", () => aiOnlyModal.contentEl.querySelectorAll("button").length >= 3);
  const aiOnlyButtons = (Array.from(aiOnlyModal.contentEl.querySelectorAll("button")) as HTMLButtonElement[]).map((b) => [b.textContent, b.disabled]);
  log.push({ step: "all briefs", planText, planButtons, withAi: built, runNotice, summary: modal.contentEl.querySelector(".alt-to-obs-briefs-summary").textContent, aiOnlyText: aiOnlyModal.contentEl.querySelector("p").textContent, aiOnlyButtons });
  return log;
}
main().then(
  (log) => (document.getElementById("out")!.textContent = JSON.stringify(log)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
