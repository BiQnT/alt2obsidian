// Question panel (2.1.0 spec 5): questions about the lecture the reader is
// on, answered from the lecture brief and the material of the current
// slide, so the whole lecture is never sent (spec 6).
//
// - The lecture is the note of the Synced Viewer last made active, or a
//   lecture note open in an editor; activating the panel itself or another
//   kind of tab changes nothing. The slide follows the viewer's page
//   (SLIDE_CHANGE_EVENT, getCurrentSlide()) or the heading above the
//   editor's cursor, read when a tab is activated, when the input gets
//   focus and when a question is sent. 📌 pins it. Nothing is read before
//   the workspace layout is ready (a panel restored at startup goes then).
// - Chips choose what goes with the question (brief, slide, transcript,
//   memo) and show their estimated tokens; the input row shows the whole
//   estimate and asks in the panel before sending past "질문당 토큰 상한".
//   The commentary, the memo and the brief are read again at every send and
//   when the note changes; the PDF text and the transcript stay cached.
// - The answer streams in as plain text (redrawn once per animation frame),
//   then is rendered as Markdown (made safe first: src/chat/safeMarkdown.ts)
//   with its grounding marks as chips that go where they point (spec 5.5),
//   and the slides that match the question but were not sent (spec 5.11).
// - A summary note (no slides, spec 9) works the same with its transcript
//   sections: the section above the editor's cursor is the focus.
// - A question about other lectures offers the subject brief once (spec
//   5.10); "대화 저장" keeps the thread as a note (spec 5.9).
// - Threads and their runs live in the plugin (ThreadStore): closing the
//   panel neither drops a thread nor stops an answer; the panel only
//   listens while it is open.
//
// Everything that touches the vault, the PDF or a CLI goes through
// ChatHost (the plugin), so the view runs in a browser test as it is.

import { Component, ItemView, MarkdownRenderer, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import type { Events } from "obsidian";
import type { Alt2ObsSettings, CliName, ImageInput, TaskId, TaskLLMSetting } from "../types";
import type { BriefStatus } from "../brief/lectureBrief";
import { alignedRange } from "../brief/lectureBrief";
import type { LectureNoteKind } from "../brief/lectureNote";
import { unitAtLine } from "../brief/lectureNote";
import { estimateTextTokens } from "../core/budget/estimate";
import type { StoredSpan } from "../core/prep/TranscriptAligner";
import { formatClock } from "../core/sections";
import { CitedLecture, parseCitations } from "../chat/citations";
import { dataviewQueryPrefixes, safeAnswerMarkdown, ZW } from "../chat/safeMarkdown";
import {
  buildChatPack,
  ChatPack,
  estimateChat,
  FocusUnit,
  formatTranscriptLines,
  materialLabel,
  parseSlideRange,
  SECTION_TRANSCRIPT_CAP,
  suggestsSubjectBrief,
  TimedText,
  transcriptLines,
} from "../chat/contextPack";
import { materialSummary } from "../chat/chatNote";
import { RelatedSlide, relatedSlides, SlideDoc } from "../chat/related";
import { ChatErrorInfo, ChatMemoTarget, ChatThread, ChatTurn, historyOf, moveThreadTo, newTurnId, ThreadEvent, ThreadStore, TurnRunner, turnsOf } from "../chat/threads";
import { defaultTaskSetting, estimateEffort, isCliProvider, ModelCatalog, modelName } from "../settings/llmSettings";
import { renderModelPicker } from "./modelPicker";
import { AddRequest, renderAddPopover } from "./addMaterialPopover";
import { DEFAULT_INCLUDE, IMAGE_TOKENS, IncludeOptions, MAX_ADDED_SLIDES, quoteOf, SlideRow } from "../chat/addMaterial";
import { SLIDE_CHANGE_EVENT, SlideChangeInfo, VIEW_TYPE_CHAT } from "./chatPanel";
import chatSystemPrompt from "../../prompts/chat.system.md";

/** A lecture note as the panel uses it. */
export interface ChatLecture {
  notePath: string;
  /** The note's name (its stem). */
  name: string;
  subject: string;
  kind: LectureNoteKind;
  /** The lecture PDF next to the note, null without one. */
  pdfPath: string | null;
  /** Slides a `[슬라이드 N]` may name (0 for a note without slides). */
  slideCount: number;
  /** Transcript sections a `[구간 N]` may name. */
  sectionCount: number;
  /** The transcript's last end, else the alignment's; null when neither is known. */
  lengthMs: number | null;
  neighbours: { prev: string | null; next: string | null };
}

/** One slide's material. */
export interface SlideMaterial {
  slideText: string;
  /** The page as a JPEG when it has no text layer (spec 6.2), else null. */
  image: ImageInput | null;
  commentary: string;
  memo: string;
  /** The transcript segments aligned to the slide (empty: no alignment or no transcript). */
  segments: TimedText[];
  /** The slide's aligned spans. */
  spans: StoredSpan[];
  /** The end of the lecture's transcript when it was read for this slide, else null. */
  transcriptEndMs: number | null;
}

export interface ChatBriefState {
  status: BriefStatus;
  /** What a question sends; null without a file. */
  body: string | null;
  path: string;
  /** The note's current source hash ("내 수정 유지" is remembered for it). */
  sourceHash: string;
}

/** What the panel needs from the plugin (it also runs the turns: TurnRunner). */
export interface ChatHost extends TurnRunner {
  data: { settings: Alt2ObsSettings; cliDetection: Partial<Record<CliName, unknown>> };
  chatThreads: ThreadStore;
  modelCatalog(): ModelCatalog;
  saveTaskDefault(task: TaskId, setting: TaskLLMSetting): Promise<void>;
  /** The lecture of a note, null when it is not a lecture note. */
  chatLecture(notePath: string): Promise<ChatLecture | null>;
  chatBrief(notePath: string): Promise<ChatBriefState>;
  /** The brief's script part (no tokens), with `withAi` the AI part too; `force` overwrites the user's edits. */
  buildChatBrief(notePath: string, force: boolean, withAi?: boolean): Promise<void>;
  /** Tokens of the brief's AI part for "강조점까지 만들기 · 약 Nk"; null without a transcript or candidates. */
  briefAiEstimate(notePath: string): Promise<number | null>;
  /** "브리프 다시 만들기" from the menu (asks first when the user edited it). */
  rebuildBrief(notePath: string | null): Promise<boolean>;
  /** One slide's material: the note read now, the PDF text and the transcript from their caches. */
  chatMaterial(lecture: ChatLecture, slide: number): Promise<SlideMaterial>;
  /** Lecture notes for the "강의 없음" card and "+ 자료 추가". */
  lectureChoices(): Array<{ path: string; name: string; subject: string }>;
  /** A lecture's slides for "+ 자료 추가" (gist, time, rough tokens). */
  chatSlideList(lecture: ChatLecture): Promise<SlideRow[]>;
  /** Another lecture's brief body: its file, else the script part built in memory (nothing written). */
  chatOtherBrief(lecture: ChatLecture): Promise<string>;
  /** A slide as an image ("슬라이드 이미지" of an added slide), null when it cannot be rendered. */
  chatSlideImage(lecture: ChatLecture, slide: number): Promise<ImageInput | null>;
  /** The text selected in the note the reader is on (the viewer's note pane or an editor), "" for none. */
  noteSelection(): string;
  /** "메모에 저장": the answer as it is, or cut to three lines (`shorten`, the brief task's model), in the unit's memo callout. */
  saveChatMemo(target: ChatMemoTarget, question: string, answer: string, shorten: boolean): Promise<void>;
  /** "대화 노트로 저장" / "대화 저장": the thread as a note in the subject's Chats folder (its file replaced when saved again); its path. */
  saveChatNote(thread: ChatThread, lecture: ChatLecture): Promise<string>;
  /** The subject brief of a lecture's subject: its file's body, else assembled in memory (no tokens, nothing written). */
  chatSubjectBrief(notePath: string): Promise<{ subject: string; body: string }>;
  /** A slide lecture's slides for the related-slide search: gist, commentary, page text already read. */
  chatSlideCorpus(lecture: ChatLecture): Promise<SlideDoc[]>;
  openSettings(): void;
  openLectureViewer(notePath: string): Promise<void>;
  /** A slide chip (spec 5.5): the slide in the lecture's Synced Viewer (opened if needed), else its heading in the note. */
  gotoSlide(lecture: ChatLecture, slide: number): Promise<void>;
  /** A time chip: the viewer's transcript at that time, or the transcript section heading that holds it. */
  gotoTime(lecture: ChatLecture, ms: number): Promise<void>;
  /** A section chip: the section's heading in the summary note. */
  gotoSection(lecture: ChatLecture, num: number): Promise<void>;
  openVaultFile(path: string): Promise<void>;
  closeChatPanel(): void;
  chatPanelClosed(leaf: WorkspaceLeaf): void;
}

/** Quick questions (spec 5.3): the chip label and the question it sends. */
const QUICK_QUESTIONS: Array<[string, string]> = [
  ["더 쉽게", "더 쉽게 설명해줘"],
  ["예시 하나", "예시를 하나 들어줘"],
  ["시험에 나올 점", "이 내용에서 시험에 나올 만한 점을 짚어줘"],
  ["앞 슬라이드와 연결", "앞 슬라이드 내용과 어떻게 이어지는지 설명해줘"],
];

/** A chip's tooltip shows this much of what it sends. */
const CHIP_TITLE_CHARS = 300;
/** A followed slide is read once the reader stays on it this long. */
const MATERIAL_DELAY_MS = 200;
/** A note change is read again once it has settled this long. */
const NOTE_CHANGE_DELAY_MS = 300;
/** Within this much of the end, the thread keeps following a streaming answer. */
const NEAR_BOTTOM_PX = 60;

/** A turn the chat note keeps: an answer that ended or was stopped (spec 5.9). */
function savable(turn: ChatTurn): boolean {
  return (turn.status === "done" || turn.status === "stopped") && !!turn.answer.trim();
}

/** Briefs the user chose to keep as they are ("내 수정 유지"), by note and source, for this session. */
const keptBriefs = new Set<string>();

function k(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

function clipTitle(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length > CHIP_TITLE_CHARS ? `${chars.slice(0, CHIP_TITLE_CHARS).join("")}…` : chars.join("");
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** What one error kind says and how to fix it (spec 5.6). */
function errorText(info: ChatErrorInfo): { title: string; fix: string } {
  switch (info.kind) {
    case "auth":
      return { title: "로그인이 필요합니다", fix: "터미널에서 `claude`(또는 `codex login`)를 한 번 실행해 로그인한 뒤 다시 보내세요." };
    case "limit":
      return { title: "사용 한도에 걸렸습니다", fix: info.message };
    case "missing":
      return { title: "CLI를 찾지 못했습니다", fix: `설정 > LLM 연결에서 실행 파일 경로를 확인하거나 '다시 찾기'를 누르세요. (${info.message})` };
    case "timeout":
      return { title: "응답이 없어 중단했습니다", fix: "다시 보내거나 설정의 'CLI 호출 제한 시간'을 늘리세요." };
    default:
      return { title: "답을 받지 못했습니다", fix: info.message };
  }
}

export class ChatView extends ItemView {
  private lecture: ChatLecture | null = null;
  private brief: ChatBriefState | null = null;
  /** The brief could not be read and there is no earlier state to show. */
  private briefError = false;
  /** Tokens of "강조점까지 만들기" for a lecture without a brief (null: no transcript, no button). */
  private briefAiTokens: number | null = null;
  /** The slide the viewer or the editor is on. */
  private followed: number | null = null;
  /** 📌: the slide the panel stays on (null: it follows). */
  private pinned: number | null = null;
  /** Slides added besides the current one ("+ 자료 추가", the "강의 없음" range), with what each carries. */
  private addedSlides: Array<{ lecture: ChatLecture; slide: number; include: IncludeOptions }> = [];
  /** Other lectures' briefs added ("다른 강의 브리프"). */
  private addedBriefs: Array<{ lecture: ChatLecture; body: string }> = [];
  /** The subject brief added (the 다른 강의 tab's checkbox or the suggestion), sent before the other briefs. */
  private subjectBrief: { subject: string; body: string } | null = null;
  /** The subject brief offered for a question about other lectures ("넣기 / 그냥 보내기"), with that question. */
  private suggestion: { question: string; brief: { subject: string; body: string } } | null = null;
  /** The subject brief was offered for this lecture: it is offered once (spec 5.10). */
  private suggested = false;
  /** Text selected in the note, sent as [선택한 글]. */
  private quote: string | null = null;
  /** The "+ 자료 추가" popover is open. */
  private popoverOpen = false;
  /** Images of added slides that carry one, by material key. */
  private images = new Map<string, ImageInput | null>();
  private chips = { brief: true, slide: true, transcript: true, memo: true };
  private materials = new Map<string, SlideMaterial>();
  /** Material reads in flight, so one slide is not read twice at once. */
  private materialLoads = new Map<string, Promise<void>>();
  /** This run's model (the picker); the saved setting until changed. */
  private runChoice: TaskLLMSetting;
  /** A question is being prepared (from the first click until its run starts). */
  private sending = false;
  /** A question waiting for "그래도 보내기" past the token cap. */
  private capPending: string | null = null;
  /** "새로 만들기" of a stale brief waits for its confirmation. */
  private confirmRebuild = false;
  /** Rendered turns by id, so a thread is drawn again without rendering every answer again. */
  private turnEls = new Map<number, HTMLElement>();
  /** One render component per rendered answer, unloaded when it is drawn again or goes. */
  private turnComponents = new Map<number, Component>();
  /** Answers with a redraw waiting for the next animation frame. */
  private drawFrames = new Map<number, number>();
  /** Lecture switches in flight: only the last one applies. */
  private switchSeq = 0;
  /** Thread drawings in flight: one that waited on a rendering stops when a newer one started. */
  private threadSeq = 0;
  private estimateFrame = 0;
  private materialTimer: number | null = null;
  private noteTimer: number | null = null;
  private clockTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  private headEl!: HTMLElement;
  private cardsEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  /** The "+ 자료 추가" popover, outside the chips so their re-renders keep what is typed in it. */
  private popoverEl!: HTMLElement;
  private threadEl!: HTMLElement;
  private composerEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private capEl!: HTMLElement;
  /** "과목 브리프를 넣을까요?" above the input. */
  private suggestEl!: HTMLElement;
  private modelEl!: HTMLElement;
  private estimateEl: HTMLElement | null = null;
  private sendBtn!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private host: ChatHost
  ) {
    super(leaf);
    this.runChoice = { ...host.data.settings.tasks.chat };
    this.chips.memo = host.data.settings.chatIncludeMemo;
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText(): string {
    return "강의 질문";
  }

  getIcon(): string {
    return "message-circle";
  }

  /** Nothing is restored with the layout: the panel opens on demand (spec 5.1). */
  getState(): Record<string, unknown> {
    return {};
  }

  /** The lecture the panel is on, null for none. */
  lecturePath(): string | null {
    return this.lecture?.notePath ?? null;
  }

  /** The lecture's thread, when a question was asked about it. */
  private get thread(): ChatThread | undefined {
    return this.lecture ? this.host.chatThreads.peek(this.lecture.notePath) : undefined;
  }

  /** The turn of this lecture's thread answering now, if any. */
  private runningTurn(): ChatTurn | null {
    const thread = this.thread;
    if (!thread || !this.host.chatThreads.isRunning(thread)) return null;
    return turnsOf(thread).find((t) => t.status === "streaming") ?? null;
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("alt-to-obs-chat");
    this.headEl = root.createDiv({ cls: "alt-to-obs-chat-head" });
    this.cardsEl = root.createDiv({ cls: "alt-to-obs-chat-cards" });
    this.chipsEl = root.createDiv({ cls: "alt-to-obs-chat-chips" });
    this.popoverEl = root.createDiv({ cls: "alt-to-obs-chat-popover-host" });
    this.threadEl = root.createDiv({ cls: "alt-to-obs-chat-thread" });
    // What is copied from an answer leaves out the zero-width spaces the sanitizer added (code copied must compile).
    this.registerDomEvent(this.threadEl, "copy", (e) => {
      const text = this.threadEl.ownerDocument.getSelection()?.toString() ?? "";
      if (!text.includes(ZW) || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text.split(ZW).join(""));
    });
    // So does a code block's copy button: this runs first (capture) and Obsidian's own handler does not.
    // Like Obsidian's own button, it leaves out the code's trailing newline.
    this.registerDomEvent(
      this.threadEl,
      "click",
      (e) => {
        const button = e.target instanceof Element ? e.target.closest(".copy-code-button") : null;
        const code = button?.closest("pre")?.querySelector("code");
        if (!button || !code) return;
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText((code.textContent ?? "").split(ZW).join("").replace(/\n$/, "")).then(
          () => new Notice("코드를 복사했습니다."),
          () => new Notice("복사하지 못했습니다.")
        );
      },
      { capture: true }
    );
    this.composerEl = root.createDiv({ cls: "alt-to-obs-chat-composer" });
    this.buildComposer();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.syncFromWorkspace()));
    this.registerEvent((this.app.workspace as Events).on(SLIDE_CHANGE_EVENT, (info: unknown) => void this.onSlideChange(info as SlideChangeInfo)));
    // The lecture note changed (a memo typed, a re-import): its chips are read again.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.path === this.lecture?.notePath) this.noteChangedLater();
      })
    );
    this.unsubscribe = this.host.chatThreads.subscribe((e) => this.onThreadEvent(e));
    // "답변 쓰는 중 · N초" of answers with no piece yet (Codex never sends one).
    this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
    this.render();
    await this.syncFromWorkspace();
  }

  async onClose(): Promise<void> {
    // A running answer goes on in the thread (spec 5.4); the panel only stops listening.
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of [this.materialTimer, this.noteTimer]) if (timer !== null) window.clearTimeout(timer);
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    if (this.estimateFrame) window.cancelAnimationFrame(this.estimateFrame);
    for (const frame of this.drawFrames.values()) window.cancelAnimationFrame(frame);
    this.clearRendered();
    this.host.chatPanelClosed(this.leaf);
  }

  // ---- the current lecture and slide (spec 5.2) ----

  /** Reads the lecture and slide from the main area's most recent tab (once the layout is ready). */
  async syncFromWorkspace(): Promise<void> {
    if (this.closed || !this.app.workspace.layoutReady) return;
    const view = this.app.workspace.getMostRecentLeaf()?.view as unknown;
    if (!view || view === this) return;
    const v = view as {
      getState?: () => Record<string, unknown>;
      getCurrentSlide?: () => number | null;
      getViewType?: () => string;
      file?: { path: string; extension?: string } | null;
      editor?: { getCursor(): { line: number }; getValue(): string };
    };
    if (typeof v.getCurrentSlide === "function" && typeof v.getState === "function") {
      const md = v.getState().mdPath;
      if (typeof md === "string" && md) await this.showLecture(md, v.getCurrentSlide());
      return;
    }
    if (v.getViewType?.() === "markdown" && v.file && v.file.extension !== "pdf") {
      // The slide (or, in a summary note, the transcript section) above the cursor.
      const at = v.editor ? unitAtLine(v.editor.getValue(), v.editor.getCursor().line) : null;
      await this.showLecture(v.file.path, at?.num ?? null, [], at?.unit ?? "slide");
    }
  }

  private async onSlideChange(info: SlideChangeInfo): Promise<void> {
    if (!info?.mdPath || this.closed) return;
    if (info.mdPath === this.lecture?.notePath) this.follow(info.page);
    else {
      // Another pair loaded in the viewer the reader is on.
      const recent = this.app.workspace.getMostRecentLeaf()?.view as { getState?: () => Record<string, unknown> } | undefined;
      if (recent?.getState?.().mdPath === info.mdPath) await this.showLecture(info.mdPath, info.page);
    }
  }

  /**
   * The panel on a lecture (and slide, or `unit` "section": a transcript
   * section of a summary note). A unit of the other kind is no focus (a
   * section heading left in a slide note's backup). A note that is not a
   * lecture note changes nothing: the last lecture stays.
   */
  async showLecture(notePath: string, slide: number | null, pinned: number[] = [], unit: "slide" | "section" = "slide"): Promise<void> {
    const fits = (l: ChatLecture) => l.kind === (unit === "slide" ? "slides" : "transcript");
    if (notePath === this.lecture?.notePath && pinned.length === 0) {
      this.follow(fits(this.lecture) ? slide : null);
      return;
    }
    const seq = ++this.switchSeq;
    const lecture = await this.host.chatLecture(notePath);
    if (seq !== this.switchSeq || !lecture || this.closed) return;
    this.lecture = lecture;
    this.materials.clear();
    this.clearRendered();
    this.followed = fits(lecture) ? slide : null;
    this.pinned = pinned[0] ?? null;
    this.addedSlides = pinned.slice(1, 1 + MAX_ADDED_SLIDES).map((slide) => ({ lecture, slide, include: { ...DEFAULT_INCLUDE } }));
    this.addedBriefs = [];
    this.subjectBrief = null;
    this.suggestion = null;
    this.suggested = false;
    this.quote = null;
    this.popoverOpen = false;
    this.images.clear();
    this.capPending = null;
    this.confirmRebuild = false;
    this.brief = null;
    this.briefError = false;
    this.render();
    await Promise.all([this.loadBrief(true), this.loadMaterials(false)]);
  }

  /** The followed slide changed; a pinned panel stays where it is. Its material is read once the reader stays. */
  private follow(slide: number | null): void {
    if (slide === null || slide === this.followed) return;
    this.followed = slide;
    if (this.pinned !== null) return;
    moveThreadTo(this.thread, slide);
    void this.renderThread();
    this.renderChips();
    if (this.materialTimer !== null) window.clearTimeout(this.materialTimer);
    this.materialTimer = window.setTimeout(() => {
      this.materialTimer = null;
      void this.loadMaterials(false);
    }, MATERIAL_DELAY_MS);
  }

  /** The note changed: its commentary and memo (chips) and the brief's state are read again, once it settles. */
  private noteChangedLater(): void {
    if (this.noteTimer !== null) window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      this.noteTimer = null;
      void Promise.all([this.loadMaterials(true), this.loadBrief(false)]);
    }, NOTE_CHANGE_DELAY_MS);
  }

  /** The slide (or a summary note's section) the question is about, pinned, else followed; null without one. */
  private currentUnit(): number | null {
    if (this.lecture?.kind !== "slides" && this.lecture?.kind !== "transcript") return null;
    return this.pinned ?? this.followed;
  }

  /** What the lecture's units are called: "구간" in a summary note, else "슬라이드". */
  private unitWord(lecture: ChatLecture | null = this.lecture): string {
    return lecture?.kind === "transcript" ? "구간" : "슬라이드";
  }

  /**
   * The slides a question sends, with what each carries: the current one
   * (the chips decide; the slide chip off sends none of it), then the added
   * ones (their own toggles).
   */
  private focusTargets(): Array<{ lecture: ChatLecture; slide: number; include: IncludeOptions }> {
    const lecture = this.lecture;
    if (!lecture) return [];
    const current = this.currentUnit();
    const own: IncludeOptions = { slideText: true, commentary: true, transcript: this.chips.transcript, memo: this.chips.memo, image: false };
    const head = this.chips.slide && current !== null ? [{ lecture, slide: current, include: own }] : [];
    return [...head, ...this.addedSlides.filter((a) => !(a.lecture.notePath === lecture.notePath && a.slide === current))];
  }

  /** Every slide whose material is read: the current one (for its chips) and the added ones. */
  private materialTargets(): Array<{ lecture: ChatLecture; slide: number }> {
    const current = this.currentUnit();
    return [...(this.lecture && current !== null ? [{ lecture: this.lecture, slide: current }] : []), ...this.addedSlides];
  }

  private materialKey(slide: number, lecture: ChatLecture | null = this.lecture): string {
    return `${lecture?.notePath}#${slide}`;
  }

  /**
   * Reads the material of the current and added slides: the missing ones,
   * or (`fresh`) all of them again, as a send does (spec 6.2). A slide whose
   * read is already running is not read a second time.
   */
  private async loadMaterials(fresh: boolean): Promise<void> {
    const lecture = this.lecture;
    if (!lecture) return;
    const reads: Array<Promise<void>> = [];
    for (const { lecture: of, slide } of this.materialTargets()) {
      const key = this.materialKey(slide, of);
      const running = this.materialLoads.get(key);
      if (running && !fresh) {
        reads.push(running);
        continue;
      }
      if (!fresh && this.materials.has(key)) continue;
      // A fresh read after one still running, so the older one cannot land last.
      const read = running ? running.then(() => this.readMaterial(of, slide, key)) : this.readMaterial(of, slide, key);
      this.materialLoads.set(key, read);
      void read.then(() => {
        if (this.materialLoads.get(key) === read) this.materialLoads.delete(key);
      });
      reads.push(read);
    }
    // Added slides that carry their image (the textless ones get theirs with the material).
    for (const a of this.addedSlides) {
      const key = this.materialKey(a.slide, a.lecture);
      if (a.include.image && !this.images.has(key)) reads.push(this.host.chatSlideImage(a.lecture, a.slide).then((img) => void this.images.set(key, img), () => void this.images.set(key, null)));
    }
    await Promise.all(reads);
    if (this.lecture === lecture) this.renderChips();
  }

  private async readMaterial(lecture: ChatLecture, slide: number, key: string): Promise<void> {
    const shown = this.lecture;
    try {
      const material = await this.host.chatMaterial(lecture, slide);
      if (this.lecture !== shown) return;
      this.materials.set(key, material);
      // The transcript's end, once read, is the lecture's length for the time marks (spec 5.5).
      if (material.transcriptEndMs !== null) lecture.lengthMs = Math.max(lecture.lengthMs ?? 0, material.transcriptEndMs);
    } catch (e) {
      console.warn("[Alt2Obs] slide material not read:", e);
    }
  }

  /**
   * Reads the brief. `rebuild`: a brief the note left behind (and the user
   * did not edit) is built again first (no tokens). A failed read or
   * rebuild keeps the last state that could be read.
   */
  private async loadBrief(rebuild: boolean): Promise<void> {
    const lecture = this.lecture;
    if (!lecture) return;
    try {
      let brief = await this.host.chatBrief(lecture.notePath);
      if (rebuild && brief.status === "outdated") {
        try {
          await this.host.buildChatBrief(lecture.notePath, false);
          brief = await this.host.chatBrief(lecture.notePath);
        } catch (e) {
          // The outdated brief is still readable: it is used as it is.
          console.warn("[Alt2Obs] brief not rebuilt:", e);
        }
      }
      if (this.lecture !== lecture) return;
      this.brief = brief;
      this.briefError = false;
      this.briefAiTokens = brief.status === "missing" ? await this.host.briefAiEstimate(lecture.notePath).catch(() => null) : null;
      if (this.lecture !== lecture) return;
    } catch (e) {
      console.warn("[Alt2Obs] brief not read:", e);
      if (this.lecture === lecture && !this.brief) this.briefError = true;
    }
    if (this.lecture !== lecture || this.closed) return;
    this.renderHead();
    this.renderCards();
    this.renderChips();
  }

  /** The brief was rebuilt elsewhere (the command): read it again. */
  async reloadBrief(): Promise<void> {
    await this.loadBrief(false);
  }

  private briefStale(): boolean {
    const b = this.brief;
    return !!b && !!this.lecture && b.status === "edited-stale" && !keptBriefs.has(`${this.lecture.notePath}\n${b.sourceHash}`);
  }

  // ---- the runs (ThreadStore events) ----

  private onThreadEvent(e: ThreadEvent): void {
    if (this.closed || e.thread !== this.thread) return;
    if (e.kind === "delta") {
      this.drawLater(e.turn);
      return;
    }
    const follow = this.nearBottom();
    void this.renderTurn(e.turn).then(() => this.keepAtBottom(follow));
    this.renderComposer();
    if (e.kind === "end") this.renderChips();
  }

  /** The streaming answer's text, redrawn once per animation frame. */
  private drawLater(turn: ChatTurn): void {
    if (this.drawFrames.has(turn.id)) return;
    this.drawFrames.set(
      turn.id,
      window.requestAnimationFrame(() => {
        this.drawFrames.delete(turn.id);
        const el = this.turnEls.get(turn.id);
        if (!el || turn.status !== "streaming") return;
        const follow = this.nearBottom();
        el.querySelector(".alt-to-obs-chat-a")?.setText(turn.answer);
        el.querySelector(".alt-to-obs-chat-status")?.setText(turn.answer ? "" : this.writingText(turn));
        this.keepAtBottom(follow);
      })
    );
  }

  private writingText(turn: ChatTurn): string {
    const text = `답변 쓰는 중 · ${Math.round((Date.now() - (turn.startedAt ?? turn.at)) / 1000)}초`;
    // Codex sends no pieces (spec 5.4): the answer appears when it is done.
    return turn.request.task.provider === "codex-cli" ? `${text} · Codex는 답을 다 쓴 뒤 한 번에 보여줍니다` : text;
  }

  private tickClock(): void {
    const turn = this.runningTurn();
    if (!turn || turn.answer) return;
    this.turnEls.get(turn.id)?.querySelector(".alt-to-obs-chat-status")?.setText(this.writingText(turn));
  }

  private nearBottom(): boolean {
    const el = this.threadEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  private keepAtBottom(follow: boolean): void {
    if (follow) this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  // ---- drawing ----

  private render(): void {
    this.renderHead();
    this.renderCards();
    this.renderChips();
    this.renderPopover();
    void this.renderThread();
    this.renderComposer();
  }

  /** Every rendered answer goes (its render component unloaded). */
  private clearRendered(): void {
    for (const component of this.turnComponents.values()) component.unload();
    this.turnComponents.clear();
    this.turnEls.clear();
  }

  private renderHead(): void {
    const head = this.headEl;
    head.empty();
    const title = head.createDiv({ cls: "alt-to-obs-chat-title" });
    title.createSpan({ text: "💬 강의 질문" });
    if (this.lecture) title.createSpan({ cls: "alt-to-obs-chat-lecture", text: [this.lecture.subject, this.lecture.name].filter(Boolean).join(" · ") });
    const actions = head.createDiv({ cls: "alt-to-obs-chat-head-actions" });
    if (this.lecture) {
      const fresh = actions.createEl("button", { text: "새 대화", attr: { title: "이 강의의 대화를 비웁니다" } });
      fresh.addEventListener("click", () => this.newThread());
    }
    const menu = actions.createEl("button", { text: "⋯", cls: "alt-to-obs-chat-menu", attr: { "aria-label": "메뉴" } });
    menu.addEventListener("click", (e) => this.openMenu(e));
    const close = actions.createEl("button", { text: "×", cls: "alt-to-obs-chat-close", attr: { "aria-label": "닫기" } });
    close.addEventListener("click", () => this.host.closeChatPanel());
  }

  private openMenu(e: MouseEvent): void {
    const menu = new Menu();
    const lecture = this.lecture;
    const brief = this.brief;
    if (this.thread && turnsOf(this.thread).some(savable)) menu.addItem((i) => i.setTitle("대화 저장").onClick(() => void this.saveChatNote()));
    if (lecture && brief && brief.status !== "missing") menu.addItem((i) => i.setTitle("브리프 열기").onClick(() => void this.host.openVaultFile(brief.path)));
    if (lecture)
      menu.addItem((i) =>
        i.setTitle("브리프 다시 만들기").onClick(() => {
          void this.host.rebuildBrief(lecture.notePath).then(async (done) => {
            if (done) await this.loadBrief(false);
          });
        })
      );
    menu.addItem((i) => i.setTitle("설정 열기").onClick(() => this.host.openSettings()));
    menu.showAtMouseEvent(e);
  }

  /** "대화 노트로 저장" / "대화 저장" (spec 5.9): the thread's note in the Chats folder, written again when saved before. */
  private async saveChatNote(): Promise<void> {
    const lecture = this.lecture;
    const thread = this.thread;
    if (!lecture || !thread) return;
    try {
      new Notice(`대화 노트를 저장했습니다: ${await this.host.saveChatNote(thread, lecture)}`);
    } catch (e) {
      new Notice(`대화 노트를 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** "새 대화": the lecture's thread goes (a running answer is stopped). */
  private newThread(): void {
    if (!this.lecture) return;
    this.host.chatThreads.clear(this.lecture.notePath);
    this.clearRendered();
    void this.renderThread();
    this.renderChips();
    this.renderComposer();
  }

  private renderCards(): void {
    const cards = this.cardsEl;
    cards.empty();
    const lecture = this.lecture;
    if (!lecture || !this.brief) return;
    if (this.brief.status === "missing") {
      const card = cards.createDiv({ cls: "alt-to-obs-chat-card is-warning" });
      card.createEl("strong", { text: "이 강의에는 브리프가 아직 없습니다" });
      card.createEl("p", { text: "브리프는 질문마다 강의 전체 대신 보내는 요약입니다. 만들지 않아도 질문할 수 있습니다." });
      const row = card.createDiv({ cls: "alt-to-obs-chat-card-actions" });
      const make = row.createEl("button", { text: "노트로 바로 만들기 · 토큰 0", cls: "mod-cta" });
      make.addEventListener("click", () => void this.buildBrief(make, false));
      if (this.briefAiTokens !== null) {
        const withAi = row.createEl("button", { text: `강조점까지 만들기 · 약 ${k(this.briefAiTokens)}`, attr: { title: "전사에서 교수님이 강조한 점과 강의 중 질문을 경량 모델로 한 번 뽑습니다." } });
        withAi.addEventListener("click", () => void this.buildBrief(withAi, false, true));
      }
      return;
    }
    if (this.briefStale()) {
      const card = cards.createDiv({ cls: "alt-to-obs-chat-card is-warning" });
      card.createEl("strong", { text: "브리프가 노트보다 오래됐습니다" });
      card.createEl("p", { text: "직접 고친 브리프인데 그 뒤에 노트가 바뀌었습니다. 고친 브리프를 그대로 쓰거나 노트로 새로 만들 수 있습니다." });
      const row = card.createDiv({ cls: "alt-to-obs-chat-card-actions" });
      if (this.confirmRebuild) {
        row.createSpan({ cls: "alt-to-obs-muted", text: "고친 내용이 새로 만든 내용으로 바뀝니다." });
        const yes = row.createEl("button", { text: "덮어쓰기", cls: "mod-warning" });
        yes.addEventListener("click", () => void this.buildBrief(yes, true));
        row.createEl("button", { text: "취소" }).addEventListener("click", () => {
          this.confirmRebuild = false;
          this.renderCards();
        });
      } else {
        row.createEl("button", { text: "내 수정 유지" }).addEventListener("click", () => {
          if (this.brief) keptBriefs.add(`${lecture.notePath}\n${this.brief.sourceHash}`);
          this.renderCards();
          this.renderChips();
        });
        row.createEl("button", { text: "새로 만들기" }).addEventListener("click", () => {
          this.confirmRebuild = true;
          this.renderCards();
        });
      }
    }
  }

  private async buildBrief(button: HTMLButtonElement, force: boolean, withAi = false): Promise<void> {
    const lecture = this.lecture;
    if (!lecture) return;
    button.disabled = true;
    try {
      await this.host.buildChatBrief(lecture.notePath, force, withAi);
      this.confirmRebuild = false;
      await this.loadBrief(false);
    } catch (e) {
      button.disabled = false;
      new Notice(`브리프를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One material chip: label, tokens, on/off (or disabled), its text in the tooltip. */
  private chip(parent: HTMLElement, o: { text: string; tokens?: number; on?: boolean; disabled?: boolean; warning?: boolean; info?: boolean; title?: string; onClick?: () => void }): HTMLButtonElement {
    const cls = ["alt-to-obs-chat-chip", o.disabled ? "is-disabled" : o.info ? "is-info" : o.on ? "is-on" : "is-off", o.warning ? "is-warning" : ""].filter(Boolean).join(" ");
    const el = parent.createEl("button", { cls });
    el.createSpan({ text: o.text });
    if (o.tokens !== undefined && !o.disabled) el.createSpan({ cls: "alt-to-obs-chat-chip-tokens", text: k(o.tokens) });
    if (o.title) el.setAttr("title", clipTitle(o.title));
    el.disabled = !!o.disabled;
    const click = o.onClick;
    if (click) el.addEventListener("click", () => click());
    return el;
  }

  private renderChips(): void {
    const el = this.chipsEl;
    el.empty();
    this.estimateEl = null;
    const lecture = this.lecture;
    if (!lecture) return;
    const row = el.createDiv({ cls: "alt-to-obs-chat-chip-row" });
    const brief = this.brief;
    if (!brief) this.chip(row, { text: this.briefError ? "📘 브리프를 읽지 못함" : "📘 브리프 읽는 중", warning: this.briefError, disabled: true });
    else if (brief.status === "missing" || !brief.body) this.chip(row, { text: "📘 브리프 없음", warning: true, disabled: true });
    else
      this.chip(row, {
        text: this.briefStale() ? "📘 브리프 오래됨" : "📘 브리프",
        warning: this.briefStale(),
        tokens: estimateTextTokens(brief.body),
        on: this.chips.brief,
        title: brief.body,
        onClick: () => this.toggleChip("brief"),
      });
    const current = this.currentUnit();
    if (current !== null) {
      const m = this.materials.get(this.materialKey(current));
      // A summary note's section (spec 9): "⏱ 구간 N [mm:ss~mm:ss]", its summary in place of the slide text and commentary.
      const section = lecture.kind === "transcript";
      const slideText = m ? [m.slideText, m.commentary].filter(Boolean).join("\n\n") : "";
      const word = this.unitWord();
      const group = row.createDiv({ cls: "alt-to-obs-chat-chip-group" });
      this.chip(group, {
        text: `${section ? `⏱ 구간 ${current}${m && m.spans.length > 0 ? ` ${alignedRange(m.spans)}` : ""}` : `📄 슬라이드 ${current}`}${this.pinned !== null ? "" : " · 따라가는 중"}`,
        tokens: m ? estimateTextTokens(slideText) + (m.image ? 1060 : 0) : undefined,
        on: this.chips.slide,
        title: slideText || "읽는 중",
        onClick: () => this.toggleChip("slide"),
      });
      const pin = group.createEl("button", {
        text: "📌",
        cls: `alt-to-obs-chat-pin${this.pinned !== null ? " is-active" : ""}`,
        attr: { title: this.pinned !== null ? `고정 풀기 (지금 ${section ? "구간을" : "슬라이드를"} 따라감)` : `이 ${word}에 고정` },
      });
      pin.addEventListener("click", () => this.togglePin());

      if (m && m.segments.length > 0) {
        const lines = transcriptLines(m.segments, section ? SECTION_TRANSCRIPT_CAP : this.host.data.settings.generation.transcriptCapChars, m.slideText);
        const span = `${formatClock(m.spans[0].startMs)}-${formatClock(m.spans[m.spans.length - 1].endMs)}`;
        this.chip(row, { text: `🎙 전사 ${span}`, tokens: estimateTextTokens(formatTranscriptLines(lines)), on: this.chips.transcript, title: formatTranscriptLines(lines), onClick: () => this.toggleChip("transcript") });
      } else if (m) this.chip(row, { text: section ? "🎙 전사 없음" : "🎙 정렬된 전사 없음", disabled: true });
      if (m && m.memo) this.chip(row, { text: "✏️ 내 메모", tokens: estimateTextTokens(m.memo), on: this.chips.memo, title: m.memo, onClick: () => this.toggleChip("memo") });
      else if (m) this.chip(row, { text: "✏️ 비어 있음", disabled: true });
    }
    for (const a of this.addedSlides) {
      if (a.lecture.notePath === lecture.notePath && a.slide === current) continue;
      const xm = this.materials.get(this.materialKey(a.slide, a.lecture));
      const text = xm ? [a.include.slideText ? xm.slideText : "", a.include.commentary ? xm.commentary : "", a.include.memo ? xm.memo : ""].filter(Boolean).join("\n\n") : "";
      const chip = this.chip(row, {
        text: `📄 ${a.lecture.notePath === lecture.notePath ? "" : `${a.lecture.name} · `}슬라이드 ${a.slide} ×`,
        tokens: xm ? estimateTextTokens(text) + (a.include.image ? IMAGE_TOKENS : 0) : undefined,
        on: true,
        title: text || "읽는 중",
        onClick: () => {
          this.addedSlides = this.addedSlides.filter((x) => x !== a);
          this.renderChips();
        },
      });
      chip.addClass("is-extra");
    }
    const subject = this.subjectBrief;
    if (subject) {
      this.chip(row, {
        text: `📚 ${subject.subject ? `${subject.subject} ` : ""}과목 브리프 ×`,
        tokens: estimateTextTokens(subject.body),
        on: true,
        title: subject.body,
        onClick: () => {
          this.subjectBrief = null;
          this.renderChips();
        },
      }).addClass("is-extra");
    }
    for (const b of this.addedBriefs) {
      this.chip(row, {
        text: `📚 ${b.lecture.name} 브리프 ×`,
        tokens: estimateTextTokens(b.body),
        on: true,
        title: b.body,
        onClick: () => {
          this.addedBriefs = this.addedBriefs.filter((x) => x !== b);
          this.renderChips();
        },
      }).addClass("is-extra");
    }
    if (this.quote) {
      this.chip(row, {
        text: "❝ 선택한 글 ×",
        tokens: estimateTextTokens(this.quote),
        on: true,
        title: this.quote,
        onClick: () => {
          this.quote = null;
          this.renderChips();
        },
      }).addClass("is-extra");
    }
    const adder = row.createEl("button", { text: "+ 자료 추가", cls: `alt-to-obs-chat-chip alt-to-obs-chat-add${this.popoverOpen ? " is-active" : ""}` });
    adder.addEventListener("click", () => this.setPopover(!this.popoverOpen));
    const history = historyOf(this.thread);
    if (history.length > 0) {
      const text = history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join("\n\n");
      this.chip(row, { text: `💬 이전 대화 ${history.length}`, tokens: Math.min(estimateTextTokens(text), 3000), info: true, title: text });
    }
    this.estimateEl = el.createDiv({ cls: "alt-to-obs-chat-estimate" });
    this.renderEstimate();
  }

  private setPopover(open: boolean): void {
    this.popoverOpen = open;
    this.renderChips();
    this.renderPopover();
  }

  /** "+ 자료 추가" (spec 5.7). */
  private renderPopover(): void {
    const el = this.popoverEl;
    el.empty();
    const lecture = this.lecture;
    if (!this.popoverOpen || !lecture) return;
    renderAddPopover(el, {
      lecture,
      current: lecture.kind === "slides" ? this.currentUnit() : null,
      alreadyAdded: (notePath) => this.addedSlides.filter((a) => a.lecture.notePath === notePath).map((a) => a.slide),
      addedCount: this.addedSlides.length,
      subjectBriefAdded: !!this.subjectBrief,
      choices: this.host.lectureChoices(),
      loadLecture: (notePath) => this.host.chatLecture(notePath),
      slideList: (l) => this.host.chatSlideList(l),
      selection: () => this.host.noteSelection(),
      onAdd: (request) => void this.addMaterial(request),
      onClose: () => this.setPopover(false),
    });
  }

  private async addMaterial(request: AddRequest): Promise<void> {
    const shown = this.lecture;
    this.setPopover(false);
    if ("quote" in request) this.quote = request.quote;
    else {
      const room = MAX_ADDED_SLIDES - this.addedSlides.length;
      for (const slide of request.slides.slice(0, Math.max(0, room))) this.addedSlides.push({ lecture: request.lecture, slide, include: request.include });
      if (request.withBrief && !this.addedBriefs.some((b) => b.lecture.notePath === request.lecture.notePath)) {
        try {
          const body = await this.host.chatOtherBrief(request.lecture);
          if (this.lecture !== shown) return;
          this.addedBriefs.push({ lecture: request.lecture, body });
        } catch (e) {
          new Notice(`그 강의의 브리프를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // "과목 브리프 넣기" (spec 5.10): the subject brief of the lecture picked.
      if (request.withSubjectBrief && !this.subjectBrief) {
        try {
          const brief = await this.host.chatSubjectBrief(request.lecture.notePath);
          if (this.lecture !== shown) return;
          this.subjectBrief = brief;
        } catch (e) {
          new Notice(`과목 브리프를 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    this.renderChips();
    await this.loadMaterials(false);
  }

  /** "선택한 내용으로 질문" (spec 5.8): the panel on that note (and slide), the text as the quote, the input focused. */
  async askAboutSelection(notePath: string, slide: number | null, text: string): Promise<void> {
    await this.showLecture(notePath, slide);
    if (this.lecture?.notePath !== notePath) return;
    this.quote = quoteOf(text) || null;
    this.renderChips();
    this.inputEl.focus();
  }

  /** "이 슬라이드에 질문" (spec 5.8): the panel on that lecture, pinned on that slide. */
  async askAboutSlide(notePath: string, slide: number): Promise<void> {
    if (notePath === this.lecture?.notePath) {
      this.followed = this.followed ?? slide;
      this.pinned = slide;
      moveThreadTo(this.thread, slide);
      this.renderChips();
      void this.renderThread();
      await this.loadMaterials(false);
    } else await this.showLecture(notePath, slide, [slide]);
    this.inputEl.focus();
  }

  private toggleChip(name: "brief" | "slide" | "transcript" | "memo"): void {
    this.chips[name] = !this.chips[name];
    this.renderChips();
  }

  private togglePin(): void {
    if (this.pinned !== null) {
      this.pinned = null;
      moveThreadTo(this.thread, this.followed);
      void this.renderThread();
    } else this.pinned = this.followed;
    this.renderChips();
    void this.loadMaterials(false);
  }

  /** The pack this question would send now (materials as read so far). */
  private pack(question: string): { pack: ChatPack; images: ImageInput[]; focus: FocusUnit[] } {
    const lecture = this.lecture!;
    const settings = this.host.data.settings;
    const focus: FocusUnit[] = [];
    const images: ImageInput[] = [];
    for (const t of this.focusTargets()) {
      const key = this.materialKey(t.slide, t.lecture);
      const m = this.materials.get(key);
      if (!m) continue;
      // A textless page goes as an image anyway; an added slide may ask for its image too.
      const image = m.image ?? (t.include.image ? this.images.get(key) ?? null : null);
      // A summary note's section: its summary, memo and up to 1500 characters of transcript (spec 6.2).
      const section = t.lecture.kind === "transcript";
      focus.push({
        lecture: t.lecture.name,
        unit: section ? "section" : "slide",
        num: t.slide,
        range: alignedRange(m.spans),
        slideText: m.image || !t.include.slideText ? "" : m.slideText,
        imageAttached: !!m.image,
        commentary: t.include.commentary ? m.commentary : "",
        memo: t.include.memo ? m.memo : "",
        transcript: t.include.transcript ? transcriptLines(m.segments, section ? SECTION_TRANSCRIPT_CAP : settings.generation.transcriptCapChars, `${m.slideText}\n${question}`) : [],
      });
      if (image) images.push(image);
    }
    const brief = this.chips.brief && this.brief?.body ? this.brief.body : null;
    const pack = buildChatPack({
      instructions: chatSystemPrompt,
      subject: lecture.subject,
      lecture: lecture.name,
      neighbours: lecture.neighbours,
      brief,
      // The subject brief, then the other lectures' briefs (spec 6.2).
      extraBriefs: [
        ...(this.subjectBrief ? [{ title: `과목 브리프: ${this.subjectBrief.subject}`, body: this.subjectBrief.body }] : []),
        ...this.addedBriefs.map((b) => ({ title: `다른 강의 브리프: ${[b.lecture.subject, b.lecture.name].filter(Boolean).join(" · ")}`, body: b.body })),
      ],
      history: historyOf(this.thread),
      focus,
      quote: this.quote,
      question,
    });
    return { pack, images, focus };
  }

  private renderEstimate(): void {
    if (!this.estimateEl || !this.lecture) return;
    const el = this.estimateEl;
    el.empty();
    const task = this.runChoice;
    if (!isCliProvider(task.provider)) return;
    const { pack, images } = this.pack(this.inputEl?.value ?? "");
    const effort = estimateEffort(task.provider, task.model, task.effort, this.host.modelCatalog());
    const est = estimateChat(pack, task.provider, effort, images.length);
    const cached = historyOf(this.thread).length > 0 && est.cached > 0 ? ` (캐시 약 ${k(est.cached)})` : "";
    el.setText(`이번 질문 예상: 입력 약 ${k(est.input)}${cached} · 출력 약 ${k(est.output)}`);
    el.toggleClass("is-over", est.input + est.output > this.host.data.settings.chatTokenCap);
  }

  private scheduleEstimate(): void {
    if (this.estimateFrame) return;
    this.estimateFrame = window.requestAnimationFrame(() => {
      this.estimateFrame = 0;
      this.renderEstimate();
    });
  }

  /** The "강의 없음" card (spec 5.6): pick a lecture, an optional slide range, or a recent thread. */
  private renderNoLecture(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "alt-to-obs-chat-card is-empty" });
    card.createEl("strong", { text: "열린 강의 노트가 없습니다" });
    card.createEl("p", { text: "강의 노트나 synced viewer를 열거나 아래에서 강의를 고르세요. 슬라이드 범위를 비우면 브리프만 보냅니다." });
    const choices = this.host.lectureChoices();
    const subjects = Array.from(new Set(choices.map((c) => c.subject)));
    const form = card.createDiv({ cls: "alt-to-obs-chat-pick" });
    const subjectEl = form.createEl("select", { cls: "dropdown", attr: { "aria-label": "과목" } });
    for (const s of subjects) subjectEl.createEl("option", { text: s || "(과목 없음)", attr: { value: s } });
    const lectureEl = form.createEl("select", { cls: "dropdown", attr: { "aria-label": "강의" } });
    const fill = () => {
      lectureEl.empty();
      for (const c of choices.filter((x) => x.subject === subjectEl.value)) lectureEl.createEl("option", { text: c.name, attr: { value: c.path } });
    };
    subjectEl.addEventListener("change", fill);
    fill();
    const rangeEl = form.createEl("input", { type: "text", placeholder: "슬라이드 범위 (예: 14-18, 23)", attr: { "aria-label": "슬라이드 범위" } });
    const actions = card.createDiv({ cls: "alt-to-obs-chat-card-actions" });
    const start = actions.createEl("button", { text: "이 강의로 시작", cls: "mod-cta" });
    start.disabled = choices.length === 0;
    start.addEventListener("click", () => void this.startWith(lectureEl.value, rangeEl.value));
    const viewer = actions.createEl("button", { text: "뷰어로 열기" });
    viewer.disabled = choices.length === 0;
    viewer.addEventListener("click", () => void this.host.openLectureViewer(lectureEl.value));
    if (choices.length === 0) card.createEl("p", { cls: "alt-to-obs-muted", text: "보관함에 가져온 강의 노트가 없습니다." });
    const recent = this.host.chatThreads.recent();
    if (recent.length > 0) {
      const list = card.createDiv({ cls: "alt-to-obs-chat-recent" });
      list.createDiv({ cls: "alt-to-obs-muted", text: "최근 대화" });
      for (const t of recent) {
        const turns = turnsOf(t);
        const turn = turns[turns.length - 1] ?? null;
        const name = (t.notePath.split("/").pop() ?? t.notePath).replace(/\.md$/, "");
        const text = [name, turn?.slide ? `${turn.memoTarget?.unit === "section" ? "구간" : "슬라이드"} ${turn.slide}` : "", turn ? clock(turn.at) : ""].filter(Boolean).join(" · ");
        list.createEl("button", { text, cls: "alt-to-obs-chat-recent-item" }).addEventListener("click", () => void this.showLecture(t.notePath, turn?.slide ?? null, [], turn?.memoTarget?.unit ?? "slide"));
      }
    }
  }

  private async startWith(notePath: string, range: string): Promise<void> {
    if (!notePath) return;
    const lecture = await this.host.chatLecture(notePath);
    if (!lecture) return;
    const { slides, ignored } = parseSlideRange(range, lecture.slideCount);
    if (ignored.length > 0) new Notice(`슬라이드 수(${lecture.slideCount}장) 밖의 번호는 뺐습니다: ${ignored.join(", ")}`);
    await this.showLecture(notePath, null, slides);
  }

  private async renderThread(): Promise<void> {
    const seq = ++this.threadSeq;
    const el = this.threadEl;
    el.empty();
    if (!this.lecture) {
      this.renderNoLecture(el);
      return;
    }
    const thread = this.thread;
    if (!thread || thread.items.length === 0) {
      const slide = this.currentUnit();
      el.createDiv({ cls: "alt-to-obs-chat-hint", text: `자료: 강의 브리프${slide !== null ? `, ${this.unitWord()} ${slide}` : ""}. 아래에 질문을 쓰거나 빠른 질문을 누르세요.` });
      return;
    }
    for (const item of thread.items) {
      if (item.kind === "divider") el.createDiv({ cls: "alt-to-obs-chat-divider", text: `${this.unitWord()} ${item.slide}으로 이동` });
      else if (item.kind === "note") el.createDiv({ cls: "alt-to-obs-chat-note", text: item.text });
      else {
        const cached = this.turnEls.get(item.turn.id);
        if (cached) el.appendChild(cached);
        else {
          await this.renderTurn(item.turn, el);
          if (seq !== this.threadSeq) return;
        }
      }
    }
    el.scrollTop = el.scrollHeight;
  }

  /** Draws a turn (in place of its old element, or at the end of `parent`). */
  private async renderTurn(turn: ChatTurn, parent?: HTMLElement): Promise<HTMLElement> {
    const old = this.turnEls.get(turn.id);
    this.turnComponents.get(turn.id)?.unload();
    this.turnComponents.delete(turn.id);
    const el = createDiv({ cls: "alt-to-obs-chat-turn" });
    el.dataset.turn = String(turn.id);
    if (old?.parentElement) old.replaceWith(el);
    else (parent ?? this.threadEl).appendChild(el);
    this.turnEls.set(turn.id, el);
    const q = el.createDiv({ cls: "alt-to-obs-chat-q" });
    q.createDiv({ text: turn.question });
    if (turn.label) q.createDiv({ cls: "alt-to-obs-chat-q-meta", text: turn.label });
    const answer = el.createDiv({ cls: "alt-to-obs-chat-a" });
    if (turn.status === "streaming") {
      answer.addClass("is-streaming");
      answer.setText(turn.answer);
      el.createDiv({ cls: "alt-to-obs-chat-status", text: turn.answer ? "" : this.writingText(turn) });
      return el;
    }
    if (turn.answer.trim()) {
      const component = new Component();
      component.load();
      this.turnComponents.set(turn.id, component);
      await MarkdownRenderer.render(this.app, safeAnswerMarkdown(turn.answer, dataviewQueryPrefixes(this.app)), answer, this.lecture?.notePath ?? "", component);
      this.applyCitations(answer, turn);
    }
    if (turn.status === "stopped") el.createDiv({ cls: "alt-to-obs-chat-status", text: "(중지됨)" });
    if (turn.status === "error" && turn.error) this.renderError(el, turn, turn.error);
    if (turn.status !== "error") this.renderActions(el, turn);
    return el;
  }

  /** Runs a turn again in its thread (다시 생성, 다시 보내기, the other provider). */
  private rerun(turn: ChatTurn): void {
    const thread = this.thread;
    if (!thread || this.sending || this.runningTurn()) return;
    void this.host.chatThreads.run(thread, turn, this.host);
  }

  private renderActions(el: HTMLElement, turn: ChatTurn): void {
    const actions = el.createDiv({ cls: "alt-to-obs-chat-actions" });
    if (turn.answer.trim()) {
      actions.createEl("button", { text: "복사" }).addEventListener("click", () => {
        void navigator.clipboard.writeText(turn.answer).then(
          () => new Notice("답변을 복사했습니다."),
          () => new Notice("복사하지 못했습니다.")
        );
      });
    }
    const again = actions.createEl("button", { text: "다시 생성" });
    again.disabled = !!this.runningTurn();
    again.addEventListener("click", () => this.rerun(turn));
    const target = turn.memoTarget;
    if (turn.status === "done" && turn.answer.trim()) {
      const save = actions.createEl("button", { text: "메모에 저장" });
      save.addEventListener("click", (evt) => {
        const menu = new Menu();
        // The memo of the question's first slide or section; a question without one has none.
        if (target) {
          menu.addItem((i) => i.setTitle("답변 그대로 · 토큰 0").onClick(() => void this.saveMemo(target, turn, false)));
          menu.addItem((i) => i.setTitle("세 줄로 줄여서 · 브리프 모델 1회").onClick(() => void this.saveMemo(target, turn, true)));
        }
        menu.addItem((i) => i.setTitle("대화 노트로 저장").onClick(() => void this.saveChatNote()));
        menu.showAtMouseEvent(evt);
      });
    }
    if (turn.usage && turn.provider) {
      const u = turn.usage;
      const model = turn.model ? modelName(turn.provider, turn.model, this.host.modelCatalog()) : "CLI 기본 모델";
      el.createDiv({
        cls: "alt-to-obs-chat-usage",
        text: `${model} · ${turn.effort || "CLI 기본값"} · 입력 ${k(u.inputTokens)} (캐시 ${k(u.cachedInputTokens)}) · 출력 ${k(u.outputTokens)}`,
      });
    }
    if (turn.status !== "streaming" && turn.related?.length) this.renderRelated(el, turn.related);
  }

  /** "관련 슬라이드 16 · <gist> · + 자료에 추가" (spec 5.11): a click adds the slide for the next question. */
  private renderRelated(el: HTMLElement, related: RelatedSlide[]): void {
    const lecture = this.lecture;
    if (!lecture) return;
    const box = el.createDiv({ cls: "alt-to-obs-chat-related" });
    for (const r of related) {
      const row = box.createDiv({ cls: "alt-to-obs-chat-related-item" });
      row.createSpan({ cls: "alt-to-obs-chat-related-text", text: `관련 슬라이드 ${r.num}${r.gist ? ` · ${r.gist}` : ""}`, attr: { title: r.gist } });
      const add = row.createEl("button", { text: "+ 자료에 추가" });
      const added = () => this.currentUnit() === r.num || this.addedSlides.some((a) => a.lecture.notePath === lecture.notePath && a.slide === r.num);
      if (added()) {
        add.setText("자료에 있음");
        add.disabled = true;
      } else add.disabled = this.addedSlides.length >= MAX_ADDED_SLIDES;
      add.addEventListener("click", () => {
        if (this.lecture !== lecture || added() || this.addedSlides.length >= MAX_ADDED_SLIDES) return;
        this.addedSlides.push({ lecture, slide: r.num, include: { ...DEFAULT_INCLUDE } });
        add.setText("자료에 있음");
        add.disabled = true;
        this.renderChips();
        void this.loadMaterials(false);
      });
    }
  }

  private async saveMemo(target: ChatMemoTarget, turn: ChatTurn, shorten: boolean): Promise<void> {
    const where = `${target.unit === "slide" ? "슬라이드" : "구간"} ${target.num}`;
    if (shorten) new Notice(`답변을 세 줄로 줄여 ${where} 메모에 저장합니다...`);
    try {
      await this.host.saveChatMemo(target, turn.question, turn.answer, shorten);
      new Notice(`${where} 메모에 저장했습니다.`);
    } catch (e) {
      new Notice(`메모에 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private renderError(el: HTMLElement, turn: ChatTurn, info: ChatErrorInfo): void {
    const { title, fix } = errorText(info);
    const card = el.createDiv({ cls: `alt-to-obs-chat-error is-${info.kind}` });
    card.createEl("strong", { text: title });
    card.createEl("p", { text: fix });
    const actions = card.createDiv({ cls: "alt-to-obs-chat-card-actions" });
    const busy = !!this.runningTurn();
    const retry = actions.createEl("button", { text: "다시 보내기", cls: "mod-cta" });
    retry.disabled = busy;
    retry.addEventListener("click", () => this.rerun(turn));
    const provider = turn.request.task.provider;
    const other = provider === "claude-cli" ? "codex-cli" : "claude-cli";
    if (this.host.data.cliDetection[other === "claude-cli" ? "claude" : "codex"]) {
      const switchBtn = actions.createEl("button", { text: `${other === "claude-cli" ? "Claude" : "Codex"}로 보내기`, attr: { title: "다른 프로바이더로 보내기 (이번 질문만)" } });
      switchBtn.disabled = busy;
      switchBtn.addEventListener("click", () => {
        turn.request = { ...turn.request, task: defaultTaskSetting(other, "chat") };
        this.rerun(turn);
      });
    }
    actions.createEl("button", { text: "설정 열기" }).addEventListener("click", () => this.host.openSettings());
  }

  /**
   * Grounding marks of a rendered answer as chips, never inside code (spec
   * 5.5). `[L4 슬라이드 N]` counts for the other lectures the turn sent.
   */
  private applyCitations(root: HTMLElement, turn: ChatTurn): void {
    const lecture = this.lecture;
    if (!lecture) return;
    const limits = { slides: lecture.slideCount, sections: lecture.sectionCount, lengthMs: lecture.lengthMs, notePath: lecture.notePath, name: lecture.name, lectures: turn.otherLectures ?? [] };
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.parentElement?.closest("code, pre"))) nodes.push(n as Text);
    }
    for (const node of nodes) {
      const parts = parseCitations(node.data, limits);
      if (parts.every((p) => p.kind === "text")) continue;
      const frag = createFragment();
      for (const p of parts) {
        if (p.kind === "text") {
          frag.appendChild(doc.createTextNode(p.text));
          continue;
        }
        const [text, title] =
          p.kind === "slide"
            ? [`${p.lecture ? `${p.lecture.name} ` : ""}슬라이드 ${p.slides.length > 2 ? `${p.slides[0]}~${p.slides[p.slides.length - 1]}` : p.slides.join(", ")}`, `${p.lecture?.name ?? lecture.name} · 슬라이드 ${p.slides.join(", ")}`]
            : p.kind === "section"
              ? [`구간 ${p.num}`, `${lecture.name} · 구간 ${p.num}`]
              : p.kind === "time"
                ? [`▶ ${formatClock(p.ms)}`, `전사 ${formatClock(p.ms)}`]
                : ["강의 자료 밖", "강의 자료에 없는 일반 지식이나 예시"];
        const chip = frag.createSpan({ cls: `alt-to-obs-chat-cite is-${p.kind}`, text, attr: { title } });
        // Where the mark points (spec 5.5); "강의 자료 밖" is only a badge.
        const go =
          p.kind === "slide"
            ? () => this.gotoCitedSlide(lecture, p.lecture, p.slides[0])
            : p.kind === "section"
              ? () => this.host.gotoSection(lecture, p.num)
              : p.kind === "time"
                ? () => this.host.gotoTime(lecture, p.ms)
                : null;
        if (go) {
          chip.setAttr("role", "button");
          chip.setAttr("tabindex", "0");
          const activate = () => void go().catch((e) => new Notice(`이동하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`));
          chip.addEventListener("click", activate);
          // A focused chip works from the keyboard as a button does.
          chip.addEventListener("keydown", (e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            activate();
          });
        }
      }
      node.replaceWith(frag);
    }
  }

  /** A slide chip: this lecture's slide, or one of another lecture the turn sent (its viewer, else its note's heading). */
  private async gotoCitedSlide(lecture: ChatLecture, other: CitedLecture | undefined, slide: number): Promise<void> {
    if (!other) return this.host.gotoSlide(lecture, slide);
    const of = await this.host.chatLecture(other.notePath);
    if (!of) throw new Error(`강의 노트를 찾지 못했습니다: ${other.notePath}`);
    await this.host.gotoSlide(of, slide);
  }

  // ---- the input row ----

  private buildComposer(): void {
    const c = this.composerEl;
    const quick = c.createDiv({ cls: "alt-to-obs-chat-quick" });
    for (const [label, question] of QUICK_QUESTIONS) {
      quick.createEl("button", { text: label, cls: "alt-to-obs-chat-quick-chip", attr: { title: question } }).addEventListener("click", () => void this.send(question));
    }
    this.capEl = c.createDiv({ cls: "alt-to-obs-chat-cap" });
    this.suggestEl = c.createDiv({ cls: "alt-to-obs-chat-suggest" });
    this.inputEl = c.createEl("textarea", { cls: "alt-to-obs-chat-input", attr: { rows: "3", placeholder: "질문을 쓰세요 (Enter 보내기, Shift+Enter 줄바꿈)" } });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      // A Korean syllable still being composed: Enter ends the composition, it does not send.
      if (e.isComposing || (e as { keyCode?: number }).keyCode === 229) return;
      e.preventDefault();
      void this.send(this.inputEl.value);
    });
    this.inputEl.addEventListener("input", () => this.scheduleEstimate());
    // The editor's cursor has no event: it is read again when the input gets focus.
    this.inputEl.addEventListener("focus", () => void this.syncFromWorkspace());
    this.modelEl = c.createDiv({ cls: "alt-to-obs-chat-model" });
    const row = c.createDiv({ cls: "alt-to-obs-chat-send-row" });
    this.sendBtn = row.createEl("button", { cls: "mod-cta alt-to-obs-chat-send", text: "보내기" });
    this.sendBtn.addEventListener("click", () => {
      const running = this.runningTurn();
      if (running) this.host.chatThreads.stop(running);
      else void this.send(this.inputEl.value);
    });
  }

  private renderComposer(): void {
    const running = !!this.runningTurn();
    const busy = running || this.sending;
    this.composerEl.toggle(!!this.lecture);
    this.sendBtn.setText(running ? "중지" : "보내기");
    this.sendBtn.toggleClass("mod-cta", !running);
    this.sendBtn.toggleClass("mod-warning", running);
    this.sendBtn.disabled = this.sending;
    this.inputEl.disabled = this.sending;
    for (const b of Array.from(this.composerEl.querySelectorAll<HTMLButtonElement>(".alt-to-obs-chat-quick-chip"))) b.disabled = busy;
    this.renderModel(busy);
    this.renderCap();
    this.renderSuggest();
  }

  private renderModel(busy: boolean): void {
    this.modelEl.empty();
    const settings = this.host.data.settings;
    renderModelPicker(this.modelEl, {
      task: "chat",
      label: "질문 모델",
      value: this.runChoice,
      saved: settings.tasks.chat,
      catalog: this.host.modelCatalog(),
      recent: settings.recentModels,
      disabled: busy,
      onChange: (next) => {
        this.runChoice = next;
        this.renderModel(false);
        this.renderEstimate();
      },
      onSaveDefault: (next) => this.host.saveTaskDefault("chat", next),
    });
  }

  private renderCap(): void {
    const el = this.capEl;
    el.empty();
    el.toggle(this.capPending !== null);
    if (this.capPending === null) return;
    el.createSpan({ text: `예상 토큰이 질문당 상한(${k(this.host.data.settings.chatTokenCap)})을 넘습니다` });
    const go = el.createEl("button", { text: "그래도 보내기", cls: "mod-warning" });
    go.addEventListener("click", () => {
      const question = this.capPending;
      this.capPending = null;
      if (question !== null) void this.send(question, { overCap: true });
    });
    el.createEl("button", { text: "취소" }).addEventListener("click", () => {
      // The question goes back to the input.
      if (this.capPending !== null && !this.inputEl.value.trim()) this.inputEl.value = this.capPending;
      this.capPending = null;
      this.renderCap();
    });
  }

  /**
   * "과목 브리프를 넣을까요? · 약 Nk · 넣기 / 그냥 보내기" (spec 5.10): both
   * send the question the row was shown for (it waits in the input).
   */
  private renderSuggest(): void {
    const el = this.suggestEl;
    el.empty();
    const s = this.suggestion;
    el.toggle(s !== null);
    if (!s) return;
    el.createSpan({ text: `과목 브리프를 넣을까요? · 약 ${k(estimateTextTokens(s.brief.body))}` });
    const go = (withBrief: boolean) => {
      if (this.suggestion !== s) return;
      this.suggestion = null;
      if (withBrief) this.subjectBrief = s.brief;
      this.renderSuggest();
      this.renderChips();
      void this.send(s.question, { suggested: true });
    };
    el.createEl("button", { text: "넣기", cls: "mod-cta" }).addEventListener("click", () => go(true));
    el.createEl("button", { text: "그냥 보내기" }).addEventListener("click", () => go(false));
  }

  /**
   * Sends a question (spec 5.4): the commentary, memo and brief read again,
   * the pack, the cap check, then a run in the lecture's thread (made now
   * if it is the first question). A question about other lectures without
   * the subject brief first offers it, once per lecture (spec 5.10). A
   * second send while this one is being prepared does nothing.
   */
  async send(text: string, opts: { overCap?: boolean; suggested?: boolean } = {}): Promise<void> {
    const question = text.trim();
    if (!question || this.sending || !this.lecture || this.runningTurn()) return;
    this.sending = true;
    if (this.suggestion) {
      this.suggestion = null;
      this.renderSuggest();
    }
    // Disabling the input takes its focus: it gets it back when the send is done.
    const hadFocus = this.inputEl.ownerDocument.activeElement === this.inputEl;
    if (this.inputEl.value.trim() === question) this.inputEl.value = "";
    this.renderComposer();
    let sent = false;
    try {
      await this.syncFromWorkspace();
      const lecture = this.lecture;
      if (!lecture) return;
      if (!opts.suggested && !this.suggested && !this.subjectBrief && suggestsSubjectBrief(question)) {
        this.suggested = true;
        try {
          const brief = await this.host.chatSubjectBrief(lecture.notePath);
          if (this.lecture !== lecture) return;
          // The question stays in the input (put back below) until 넣기 or 그냥 보내기.
          if (brief.body.trim()) {
            this.suggestion = { question, brief };
            return;
          }
        } catch (e) {
          console.warn("[Alt2Obs] subject brief not read:", e);
        }
      }
      await Promise.all([this.loadMaterials(true), this.loadBrief(true)]);
      if (this.lecture !== lecture) return;
      const task = { ...this.runChoice };
      if (!isCliProvider(task.provider)) {
        new Notice("질문에 쓸 LLM이 설정되어 있지 않습니다. 설정의 '작업별 모델'에서 '질문'을 고르세요.");
        return;
      }
      const { pack, images, focus } = this.pack(question);
      const effort = estimateEffort(task.provider, task.model, task.effort, this.host.modelCatalog());
      const est = estimateChat(pack, task.provider, effort, images.length);
      if (!opts.overCap && est.input + est.output > this.host.data.settings.chatTokenCap) {
        this.capPending = question;
        sent = true;
        return;
      }
      // Slides of this lecture that match the question but are not in the material, offered under the answer (spec 5.11, no tokens).
      const inMaterial = [this.currentUnit(), ...this.addedSlides.filter((a) => a.lecture.notePath === lecture.notePath).map((a) => a.slide)].filter((n): n is number => n !== null);
      const related = lecture.kind === "slides" ? relatedSlides(question, await this.host.chatSlideCorpus(lecture).catch(() => []), inMaterial) : [];
      if (this.lecture !== lecture) return;
      const thread = this.host.chatThreads.get(lecture.notePath);
      if (pack.folded > thread.folded) {
        thread.items.push({ kind: "note", text: `앞 대화 ${pack.folded}개를 줄였습니다` });
        thread.folded = pack.folded;
      }
      const read = this.focusTargets().filter((t) => this.materials.has(this.materialKey(t.slide, t.lecture)));
      const first = read[0];
      // Other lectures whose slides or brief go with the question, kept on the turn for its `[L4 슬라이드 N]` chips.
      const others = new Map<string, CitedLecture>();
      for (const of of [...read.map((t) => t.lecture), ...this.addedBriefs.filter((b) => b.body.trim()).map((b) => b.lecture)]) {
        if (of.notePath !== lecture.notePath) others.set(of.notePath, { notePath: of.notePath, name: of.name, subject: of.subject, slides: of.slideCount });
      }
      const turn: ChatTurn = {
        id: newTurnId(),
        question,
        label: materialLabel(focus, this.chips.brief && !!this.brief?.body),
        slide: this.currentUnit(),
        memoTarget: first ? { notePath: first.lecture.notePath, unit: first.lecture.kind === "transcript" ? "section" : "slide", num: first.slide } : undefined,
        ...(others.size > 0 ? { otherLectures: [...others.values()] } : {}),
        material: materialSummary(
          lecture.name,
          focus,
          [...(this.quote ? ["선택한 글"] : []), ...(this.subjectBrief ? ["과목 브리프"] : []), ...this.addedBriefs.map((b) => `${b.lecture.name} 브리프`)],
          this.chips.brief && !!this.brief?.body
        ),
        ...(related.length > 0 ? { related } : {}),
        answer: "",
        status: "streaming",
        request: { task, system: pack.system, user: pack.user, images },
        at: Date.now(),
      };
      // A trailing divider is where this question is asked: it stays.
      thread.items.push({ kind: "turn", turn });
      sent = true;
      // The run belongs to the thread: it goes on if the panel closes.
      void this.host.chatThreads.run(thread, turn, this.host);
      await this.renderThread();
    } finally {
      this.sending = false;
      if (!sent && !this.inputEl.value.trim()) this.inputEl.value = question;
      if (!this.closed) {
        this.renderComposer();
        if (hadFocus) this.inputEl.focus();
      }
    }
  }
}
