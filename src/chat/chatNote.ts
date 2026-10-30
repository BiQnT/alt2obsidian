// "대화 노트로 저장" and "대화 저장" of the question panel (2.1.0 spec 5.9):
// a lecture's thread as a note in the subject's Chats folder, named
// `<YYYY-MM-DD> <lecture> <first question, 40 characters>.md`. Its
// frontmatter says where it came from (source "alt2obsidian-chat", the
// lecture, the date, the models, the usage summed); each turn is
// `## Q. <question>`, `> 자료: <what it sent>` and the answer. Questions and
// answers are made safe as a saved memo is (safeNoteMarkdown: as the panel
// renders an answer, every `%%` broken too), then the answer's `[슬라이드 N]`, `[L4 슬라이드 N]` and `[구간 N]` marks
// outside code become links to their headings, path-qualified as the note
// verifier writes them. A fence an answer leaves open is closed, so it
// cannot hold the turns after it. Saving the thread again replaces its file
// (the panel remembers the path per thread). Pure: no obsidian import.

import { headingLinkTarget } from "../core/sections";
import { addUsage } from "../llm/usage";
import { EMPTY_USAGE, LLMUsage } from "../types";
import { sanitizeFilename } from "../utils/helpers";
import { CitedLecture, parseCitations } from "./citations";
import type { FocusUnit } from "./contextPack";
import { safeNoteMarkdown } from "./safeMarkdown";

/** Characters of the first question in the file name. */
export const CHAT_NAME_QUESTION_CHARS = 40;
/** The file name's stem at most, in UTF-8 bytes (a file system allows 255 for a name; " 2" and ".md" still fit). */
export const CHAT_NAME_MAX_BYTES = 200;

export interface ChatNoteTurn {
  question: string;
  /** What the question sent, e.g. "슬라이드 17, 전사 29:06-35:56" ("" for nothing to say). */
  material: string;
  answer: string;
  /** A stopped answer is saved as far as it came, marked "(중지됨)". */
  stopped: boolean;
  usage?: LLMUsage;
  model?: string;
  /** Other lectures the question sent: the answer's `[L4 슬라이드 N]` links. */
  otherLectures?: CitedLecture[];
}

export interface ChatNoteInput {
  /** The lecture note's vault path. */
  notePath: string;
  /** The lecture's name (its note's stem). */
  lecture: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Slides of the lecture (a mark past them stays text); 0 for a note without slides. */
  slides: number;
  /** The section headings of a summary note (a `[구간 N]` links to its own). */
  sections: Array<{ num: number; heading: string }>;
  turns: ChatNoteTurn[];
}

/** UTF-8 bytes of one character (a code point). */
function utf8Bytes(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * The file name of a thread's note: `<date> <lecture> <first question cut
 * to 40 characters>.md`, without the characters a file name or a wikilink
 * to it cannot hold, its stem cut to 200 UTF-8 bytes between characters (a
 * long lecture name).
 */
export function chatNoteName(date: string, lecture: string, question: string): string {
  const head = Array.from(question.replace(/\s+/g, " ").trim()).slice(0, CHAT_NAME_QUESTION_CHARS).join("");
  const name = sanitizeFilename(`${date} ${lecture} ${head}`.replace(/[#^[\]|]/g, " ")).replace(/\s+/g, " ").trim();
  let stem = "";
  let bytes = 0;
  for (const ch of name) {
    bytes += utf8Bytes(ch);
    if (bytes > CHAT_NAME_MAX_BYTES) break;
    stem += ch;
  }
  return `${stem.replace(/[.\s]+$/, "")}.md`;
}

/** `<folder>/<name>`, or with " 2", " 3" before ".md" when that path is taken. */
export function uniqueChatNotePath(folder: string, name: string, taken: (path: string) => boolean): string {
  const stem = name.replace(/\.md$/, "");
  const at = (suffix: string) => `${folder ? `${folder}/` : ""}${stem}${suffix}.md`;
  let n = 1;
  while (taken(at(n === 1 ? "" : ` ${n}`))) n++;
  return at(n === 1 ? "" : ` ${n}`);
}

/**
 * What a question sent, as the chat note shows it: its slides or sections
 * (another lecture's with its name), the transcript ranges, then `extras`
 * (the quote, added briefs); "강의 브리프" when the brief was all.
 */
export function materialSummary(lecture: string, focus: Array<Pick<FocusUnit, "lecture" | "unit" | "num" | "range" | "transcript">>, extras: string[], withBrief: boolean): string {
  const groups = new Map<string, number[]>();
  for (const u of focus) {
    const key = `${u.lecture === lecture ? "" : `${u.lecture} `}${u.unit === "slide" ? "슬라이드" : "구간"}`;
    groups.set(key, [...(groups.get(key) ?? []), u.num]);
  }
  const units = Array.from(groups, ([key, nums]) => `${key} ${nums.join(", ")}`);
  const spoken = focus
    .filter((u) => u.transcript.length > 0 && u.range)
    .map((u) => `${u.lecture === lecture ? "" : `${u.lecture} `}전사 ${u.range.replace(/^\[|\??\]$/g, "").replace("~", "-")}`);
  const parts = [...units, ...spoken, ...extras];
  return parts.length > 0 ? parts.join(", ") : withBrief ? "강의 브리프" : "";
}

/** What a wikilink target cannot hold: # ^ [ ] |, and `%%`, which would open a comment. */
const LINK_UNSAFE = /[#^[\]|]|%%/;

/**
 * `[[<path>#<heading>|<alias>]]`, the heading as Obsidian matches it; a
 * path a wikilink cannot hold becomes a Markdown link (percent-encoded).
 */
function headingLink(notePath: string, heading: string, alias: string): string {
  const target = notePath.replace(/\.md$/, "");
  const sub = headingLinkTarget(heading);
  const label = alias.replace(/[#^[\]|]/g, " ").replace(/\s+/g, " ").trim();
  if (!LINK_UNSAFE.test(target)) return `[[${target}#${sub}|${label}]]`;
  return `[${label}](${notePath.split("/").map(encodeURIComponent).join("/")}#${encodeURIComponent(sub)})`;
}

/** Container marks before a fence: block quotes, list items, indentation. */
const CONTAINER = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d+[.)](?=[ \t])))*[ \t]*/;
/** An inline code span: a backtick run, then text up to the same run. */
const CODE_SPAN = /(`+)[\s\S]*?[^`]\1(?!`)/g;

/** A fence still open: its marker, and the prefix that keeps a line in its container (`> ` of a quote, the indentation of a list item). */
interface OpenFence {
  char: string;
  len: number;
  cont: string;
  /** Opened inside a quote or a list item (not only indented). */
  contained: boolean;
}

/** The line is still in the fence's container: a quote's line keeps its `>`, a list item's its indentation (a blank line too). */
function inContainer(line: string, f: OpenFence): boolean {
  if (!f.contained || line.startsWith(f.cont) || line.trimEnd() === f.cont.trimEnd()) return true;
  return !line.trim() && !f.cont.includes(">");
}

/**
 * `fn` applied to the text outside code (fenced blocks, inline code spans).
 * A fence in a quote or a list item ends with its container. A fence left
 * open at the end is closed inside its container (a bare fence at column 0
 * would leave the quote or list and open a new block of code that holds
 * the turns after it).
 */
function outsideCode(text: string, fn: (plain: string) => string): string {
  const out: string[] = [];
  let fence: OpenFence | null = null;
  for (const line of text.split("\n")) {
    if (fence && !inContainer(line, fence)) fence = null;
    const rest = line.replace(CONTAINER, "");
    const mark = rest.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (mark && mark[0] === fence.char && mark.length >= fence.len && !rest.slice(mark.length).trim()) fence = null;
      out.push(line);
    } else if (mark && !(mark[0] === "`" && rest.slice(mark.length).includes("`"))) {
      const prefix = line.slice(0, line.length - rest.length);
      // A list marker's width stays as indentation: the item's next lines start there.
      fence = { char: mark[0], len: mark.length, cont: prefix.replace(/[-*+]|\d+[.)]/g, (m) => " ".repeat(m.length)), contained: /\S/.test(prefix) };
      out.push(line);
    } else {
      let plain = "";
      let last = 0;
      for (const m of line.matchAll(CODE_SPAN)) {
        plain += fn(line.slice(last, m.index)) + m[0];
        last = (m.index ?? 0) + m[0].length;
      }
      out.push(plain + fn(line.slice(last)));
    }
  }
  if (fence) out.push(`${fence.cont}${fence.char.repeat(fence.len)}`);
  return out.join("\n");
}

/** The answer's slide and section marks as links to their headings (other marks stay text). */
function linkCitations(text: string, input: ChatNoteInput, turn: ChatNoteTurn): string {
  const headings = new Map(input.sections.map((s) => [s.num, s.heading]));
  const limits = { slides: input.slides, sections: headings.size > 0 ? Math.max(...headings.keys()) : 0, lengthMs: null, notePath: input.notePath, name: input.lecture, lectures: turn.otherLectures ?? [] };
  return parseCitations(text, limits)
    .map((p) => {
      const alias = p.text.replace(/^\[|\]$/g, "");
      if (p.kind === "slide") return headingLink(p.lecture?.notePath ?? input.notePath, `📚 슬라이드 ${p.slides[0]}`, alias);
      if (p.kind === "section" && headings.has(p.num)) return headingLink(input.notePath, headings.get(p.num)!, alias);
      return p.text;
    })
    .join("");
}

/** The models of the turns, in order, each once ("" when none is known). */
function modelsOf(turns: ChatNoteTurn[]): string {
  return Array.from(new Set(turns.map((t) => t.model ?? "").filter(Boolean))).join(", ");
}

/**
 * The chat note. `queryPrefixes`: the inline query prefixes set in
 * Dataview, made safe as well (as for a memo).
 */
export function renderChatNote(input: ChatNoteInput, queryPrefixes: readonly string[] = []): string {
  const usage = input.turns.reduce((sum, t) => (t.usage ? addUsage(sum, t.usage) : sum), EMPTY_USAGE);
  const front = [
    "---",
    'source: "alt2obsidian-chat"',
    `lecture: ${JSON.stringify(input.notePath)}`,
    `date: ${JSON.stringify(input.date)}`,
    `model: ${JSON.stringify(modelsOf(input.turns))}`,
    `usage: {calls: ${usage.calls}, input: ${usage.inputTokens}, cached: ${usage.cachedInputTokens}, output: ${usage.outputTokens}}`,
    "---",
  ];
  const blocks = input.turns.map((t) => {
    const head = [`## Q. ${t.question.replace(/\s+/g, " ").trim()}`, ...(t.material ? [`> 자료: ${t.material}`] : [])].join("\n");
    const answer = outsideCode(safeNoteMarkdown(t.answer.replace(/\r\n?/g, "\n").trim(), queryPrefixes), (plain) => linkCitations(plain, input, t));
    return [safeNoteMarkdown(head, queryPrefixes), answer, ...(t.stopped ? ["(중지됨)"] : [])].join("\n\n");
  });
  return `${front.join("\n")}\n${blocks.join("\n\n")}\n`;
}
