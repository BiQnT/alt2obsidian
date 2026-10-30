// Question threads (2.1.0 spec 5.1, 5.2, 5.4): one per lecture note, kept
// in the plugin's memory while it runs (closing the panel keeps them,
// disabling the plugin drops them). A thread holds the turns, the
// "슬라이드 N으로 이동" dividers and notes such as "앞 대화 N개를 줄였습니다".
//
// The store also owns the runs: a question keeps streaming into its turn
// when the panel closes, its usage is recorded when it ends, and a panel
// opened again shows the turn as it is (still streaming, or done). Only
// the stop button and the plugin's unload stop a run. A panel listens to
// the store's events while it is open.
//
// A thread is made when its first question is sent; looking at a lecture
// does not make one, and a thread without a turn never counts toward the
// 10 kept. Pure: no obsidian import.

import type { EffortLevel, ImageInput, LLMUsage, ProviderId, TaskLLMSetting } from "../types";
import type { HistoryTurn } from "./contextPack";
import type { MemoTarget } from "./memoSave";

/** The note and unit whose memo "메모에 저장" writes. */
export type ChatMemoTarget = MemoTarget & { notePath: string };

export const MAX_THREADS = 10;

/** Why a turn failed, as the panel shows it (spec 5.6). */
export type ChatErrorKind = "auth" | "limit" | "missing" | "timeout" | "other";

export interface ChatErrorInfo {
  kind: ChatErrorKind;
  /** The CLI's own message (usage limit) or the error's. */
  message: string;
}

/** What a turn sent, kept so "다시 생성" sends the same again. */
export interface ChatRequest {
  task: TaskLLMSetting;
  system: string;
  user: string;
  images: ImageInput[];
}

export interface ChatRunRequest extends ChatRequest {
  signal: AbortSignal;
  onDelta(text: string): void;
  /** The answer starts over (the CLI retried mid-stream). */
  onReset?(): void;
}

export interface ChatRunResult {
  text: string;
  usage: LLMUsage;
  /** The model the CLI reported (an alias as its full id), else the one asked for. */
  model: string;
}

/** What runs a turn: the plugin (its CLI call and its error mapping). */
export interface TurnRunner {
  runChat(req: ChatRunRequest): Promise<ChatRunResult>;
  chatErrorInfo(e: unknown): ChatErrorInfo;
}

export interface ChatTurn {
  id: number;
  question: string;
  /** "슬라이드 17 기준" and the like ("" for none). */
  label: string;
  /** The slide the question was about (the conversation's place for the dividers), null for none. */
  slide: number | null;
  /** Where "메모에 저장" writes: the question's first focus slide (spec 5.9); none without one. */
  memoTarget?: ChatMemoTarget;
  /** Other lectures whose slides or brief the question sent: the answer's `[L4 슬라이드 N]` chips (spec 5.5). */
  otherLectures?: Array<{ notePath: string; name: string; slides: number }>;
  answer: string;
  status: "streaming" | "done" | "stopped" | "error";
  error?: ChatErrorInfo;
  request: ChatRequest;
  usage?: LLMUsage;
  provider?: ProviderId;
  /** The model the CLI reported, else the one requested. */
  model?: string;
  effort?: EffortLevel;
  /** When it was asked (ms). */
  at: number;
  /** When its current run started (ms): the panel shows how long it has been writing. */
  startedAt?: number;
}

export type ThreadItem = { kind: "turn"; turn: ChatTurn } | { kind: "divider"; slide: number } | { kind: "note"; text: string };

export interface ChatThread {
  notePath: string;
  items: ThreadItem[];
  /** Earlier turns already reported as folded ("앞 대화 N개를 줄였습니다"). */
  folded: number;
  /** Last use (ms), for the recent list. */
  used: number;
}

/** A run started, got a piece (or started over), or ended. */
export interface ThreadEvent {
  kind: "start" | "delta" | "end";
  thread: ChatThread;
  turn: ChatTurn;
}

let turnIds = 0;

export function newTurnId(): number {
  return ++turnIds;
}

function hasTurns(thread: ChatThread): boolean {
  return thread.items.some((i) => i.kind === "turn");
}

export class ThreadStore {
  private threads = new Map<string, ChatThread>();
  private runs = new Map<number, AbortController>();
  private listeners = new Set<(event: ThreadEvent) => void>();
  /** dropAll() ran (the plugin unloads): no run starts any more. */
  private dropped = false;

  constructor(private max = MAX_THREADS) {}

  /**
   * The lecture's thread for a question (made when there is none), now the
   * most recent. Past the limit the least recently used threads with turns
   * go, except one that is answering.
   */
  get(notePath: string): ChatThread {
    let thread = this.threads.get(notePath);
    if (thread) this.threads.delete(notePath);
    else thread = { notePath, items: [], folded: 0, used: Date.now() };
    thread.used = Date.now();
    this.threads.set(notePath, thread);
    // A Map iterates in insertion order: the first ones are the least recently used.
    const kept = Array.from(this.threads.values()).filter((t) => t === thread || hasTurns(t));
    for (const old of kept.slice(0, Math.max(0, kept.length - this.max))) {
      if (old !== thread && !this.isRunning(old)) this.threads.delete(old.notePath);
    }
    return thread;
  }

  /** The lecture's thread when it has one (looking at a lecture makes none). */
  peek(notePath: string): ChatThread | undefined {
    return this.threads.get(notePath);
  }

  /** "새 대화": the lecture's thread goes (its running answer is stopped). */
  clear(notePath: string): void {
    const thread = this.threads.get(notePath);
    if (!thread) return;
    for (const turn of turnsOf(thread)) this.stop(turn);
    this.threads.delete(notePath);
  }

  /** Threads with at least one turn, most recently used first. */
  recent(): ChatThread[] {
    return Array.from(this.threads.values()).filter(hasTurns).reverse();
  }

  /** Every run stopped and every thread dropped (the plugin unloads); no run starts after this. */
  dropAll(): void {
    this.dropped = true;
    for (const controller of this.runs.values()) controller.abort();
    this.threads.clear();
  }

  /** Listens to the runs' events; returns what stops listening. */
  subscribe(listener: (event: ThreadEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: ThreadEvent["kind"], thread: ChatThread, turn: ChatTurn): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener({ kind, thread, turn });
      } catch (e) {
        console.warn("[Alt2Obs] thread listener failed:", e);
      }
    }
  }

  /** A turn of the thread is answering now. */
  isRunning(thread: ChatThread): boolean {
    return turnsOf(thread).some((t) => this.runs.has(t.id));
  }

  /**
   * Runs (or runs again) a turn's request; its answer grows in the turn as
   * the pieces come. Never throws: a failure is the turn's error, a stop
   * leaves what came marked as stopped. One run per thread at a time: a run
   * asked for while another turn of the thread answers (or after the
   * plugin unloaded) does not start.
   */
  async run(thread: ChatThread, turn: ChatTurn, runner: TurnRunner): Promise<void> {
    if (this.dropped || this.isRunning(thread)) return;
    const controller = new AbortController();
    this.runs.set(turn.id, controller);
    Object.assign(turn, { answer: "", status: "streaming", error: undefined, usage: undefined, model: undefined, startedAt: Date.now() });
    this.emit("start", thread, turn);
    try {
      const result = await runner.runChat({
        ...turn.request,
        signal: controller.signal,
        onDelta: (piece) => {
          turn.answer += piece;
          this.emit("delta", thread, turn);
        },
        onReset: () => {
          turn.answer = "";
          this.emit("delta", thread, turn);
        },
      });
      Object.assign(turn, { answer: result.text, status: "done", usage: result.usage, model: result.model, provider: turn.request.task.provider, effort: turn.request.task.effort });
    } catch (e) {
      if (controller.signal.aborted) turn.status = "stopped";
      else Object.assign(turn, { status: "error", error: runner.chatErrorInfo(e) });
    } finally {
      this.runs.delete(turn.id);
      this.emit("end", thread, turn);
    }
  }

  /** The stop button: what came stays, marked as stopped. */
  stop(turn: ChatTurn): void {
    this.runs.get(turn.id)?.abort();
  }
}

export function turnsOf(thread: ChatThread): ChatTurn[] {
  return thread.items.filter((i): i is { kind: "turn"; turn: ChatTurn } => i.kind === "turn").map((i) => i.turn);
}

/** The earlier conversation a question sends: finished turns only (a stopped or failed one is left out, spec 5.4). */
export function historyOf(thread: ChatThread | undefined, before?: ChatTurn): HistoryTurn[] {
  if (!thread) return [];
  const turns = turnsOf(thread);
  const end = before ? turns.indexOf(before) : -1;
  return (end >= 0 ? turns.slice(0, end) : turns)
    .filter((t) => t.status === "done" && t.answer.trim())
    .map((t) => ({ label: t.label, question: t.question, answer: t.answer }));
}

/** The slide the conversation is on: the last divider's, else the last turn's. */
function conversationSlide(thread: ChatThread): number | null {
  for (let i = thread.items.length - 1; i >= 0; i--) {
    const item = thread.items[i];
    if (item.kind === "divider") return item.slide;
    if (item.kind === "turn") return item.turn.slide;
  }
  return null;
}

/**
 * The followed slide changed (spec 5.2): once the thread has a turn, a
 * "슬라이드 N으로 이동" divider marks the move. Moving on again before the
 * next question replaces that divider, and coming back to the slide the
 * conversation is on removes it.
 */
export function moveThreadTo(thread: ChatThread | undefined, slide: number | null): void {
  if (!thread || slide === null || !hasTurns(thread)) return;
  const last = thread.items[thread.items.length - 1];
  if (last?.kind === "divider") thread.items.pop();
  if (conversationSlide(thread) !== slide) thread.items.push({ kind: "divider", slide });
}
