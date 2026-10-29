// Browser entry for test/dom-chat.mjs: the real question panel
// (src/ui/ChatView.ts) and its open/close controller (src/ui/chatPanel.ts)
// against the obsidian stub, a fake workspace (right sidebar, leaves,
// events) and a fake plugin (ChatHost) whose CLI answer streams in pieces.
// Results go to <pre id="out"> as JSON.
import { ChatView } from "../../src/ui/ChatView";
import { ChatPanelController, SLIDE_CHANGE_EVENT, VIEW_TYPE_CHAT } from "../../src/ui/chatPanel";
import { ThreadStore } from "../../src/chat/threads";
import { DEFAULT_SETTINGS } from "../../src/types";
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
        : null,
    chatBrief: async (path: string) => {
      calls.push({ briefRead: path });
      if (briefStatus === "broken") throw new Error("brief unreadable");
      return { status: briefStatus, body: briefStatus === "missing" ? null : "## 개요\n부동소수점 덧셈을 다룬다.", path: path.replace("/Lectures/", "/Briefs/").replace(/\.md$/, " brief.md"), sourceHash: "abcd1234" };
    },
    buildChatBrief: async (path: string, force: boolean) => {
      calls.push({ build: path, force });
      briefStatus = "ok";
    },
    rebuildBrief: async () => true,
    chatMaterial: async (_l: unknown, slide: number) => ({
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
    lectureChoices: () => [
      { path: L4, name: "L4", subject: "CSED423" },
      { path: L5, name: "L5", subject: "CSED423" },
    ],
    openSettings: () => calls.push({ settings: true }),
    openLectureViewer: async (p: string) => void calls.push({ viewer: p }),
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
  log.push({ step: "stopped", answers: text(".alt-to-obs-chat-a").map((t) => t!.slice(0, 12)), history: third.split("[이번 자료]")[0], hasStopped: third.includes("더 길게") });

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
  // "Codex로 보내기" sends the same question with the Codex defaults; it answers.
  answer = { ...answer, mode: "ok" };
  const last = root().querySelectorAll(".alt-to-obs-chat-error.is-other")[0] as HTMLElement;
  button("Codex로 보내기", last).click();
  await until("the retried answer", () => calls.filter((c) => c.run).pop().run.task.provider === "codex-cli" && !root().querySelector(".alt-to-obs-chat-a.is-streaming") && !root().querySelector(".alt-to-obs-chat-error.is-other"));
  button("설정 열기", root().querySelector(".alt-to-obs-chat-error")!).click();
  log.push({ step: "errors", cards, retried: calls.filter((c) => c.run).pop().run.task, settingsOpened: calls.some((c) => c.settings) });

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
  const missing = { card: text(".alt-to-obs-chat-card strong")[0], chip: text(".alt-to-obs-chat-chip")[0], head: text(".alt-to-obs-chat-lecture")[0], thread: text(".alt-to-obs-chat-turn").length };
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

  // ---- the menu, and the × closes the panel ----
  button("⋯").click();
  const menu = (Menu as any).shown;
  log.push({ step: "menu", items: menu.items.map((i: any) => i.title) });
  ws.rightSplit.collapsed = false;
  button("×").click();
  log.push({ step: "closed with ×", open: controller.isOpen(), threadKept: host.chatThreads.peek(L5).items.length > 0, events: opened.slice(-1) });
  return log;
}
main().then(
  (log) => (document.getElementById("out")!.textContent = JSON.stringify(log)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
