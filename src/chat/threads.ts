// Question threads (2.1.0 spec 5.1, 5.2): one per lecture note, kept in the
// plugin's memory while it runs (closing the panel keeps them, disabling
// the plugin drops them), the 10 most recently used. A thread holds the
// turns, the "슬라이드 N으로 이동" dividers and notes such as "앞 대화 N개를
// 줄였습니다". Pure: no obsidian import.

import type { EffortLevel, ImageInput, LLMUsage, ProviderId, TaskLLMSetting } from "../types";
import type { HistoryTurn } from "./contextPack";

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

export interface ChatTurn {
  id: number;
  question: string;
  /** "슬라이드 17 기준" and the like ("" for none). */
  label: string;
  /** The slide the question was about (the conversation's place for the dividers), null for none. */
  slide: number | null;
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

let turnIds = 0;

export function newTurnId(): number {
  return ++turnIds;
}

export class ThreadStore {
  private threads = new Map<string, ChatThread>();

  constructor(private max = MAX_THREADS) {}

  /** The lecture's thread (made when there is none), now the most recent; the oldest beyond the limit are dropped. */
  get(notePath: string): ChatThread {
    let thread = this.threads.get(notePath);
    if (thread) this.threads.delete(notePath);
    else thread = { notePath, items: [], folded: 0, used: Date.now() };
    thread.used = Date.now();
    this.threads.set(notePath, thread);
    // A Map iterates in insertion order: the first keys are the least recently used.
    for (const oldest of [...this.threads.keys()].slice(0, Math.max(0, this.threads.size - this.max))) this.threads.delete(oldest);
    return thread;
  }

  peek(notePath: string): ChatThread | undefined {
    return this.threads.get(notePath);
  }

  /** "새 대화": the lecture's thread starts over. */
  clear(notePath: string): void {
    const thread = this.threads.get(notePath);
    if (thread) Object.assign(thread, { items: [], folded: 0 });
  }

  /** Threads with at least one turn, most recently used first. */
  recent(): ChatThread[] {
    return [...this.threads.values()].filter((t) => t.items.some((i) => i.kind === "turn")).reverse();
  }

  /** Every thread is dropped (the plugin is disabled). */
  dropAll(): void {
    this.threads.clear();
  }
}

export function turnsOf(thread: ChatThread): ChatTurn[] {
  return thread.items.filter((i): i is { kind: "turn"; turn: ChatTurn } => i.kind === "turn").map((i) => i.turn);
}

/** The earlier conversation a question sends: finished turns only (a stopped or failed one is left out, spec 5.4). */
export function historyOf(thread: ChatThread, before?: ChatTurn): HistoryTurn[] {
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
export function moveThreadTo(thread: ChatThread, slide: number | null): void {
  if (slide === null || !thread.items.some((i) => i.kind === "turn")) return;
  const last = thread.items[thread.items.length - 1];
  if (last?.kind === "divider") thread.items.pop();
  if (conversationSlide(thread) !== slide) thread.items.push({ kind: "divider", slide });
}
