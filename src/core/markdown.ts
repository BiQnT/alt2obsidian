// Pure markdown helpers shared by the plugin (NoteGenerator) and the Skill
// CLI (scripts/src/overview-block.ts), so both build the overview block and
// concept wikilinks identically. No obsidian import.

import { OVERVIEW_BLOCK_END, OVERVIEW_BLOCK_START } from "../types";
import { ambiguousKorean, conceptKey, parseConceptName, sameConcept } from "./conceptNames";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word character of ASCII text: a term starting or ending with one needs a boundary there. */
const ASCII_WORD = /[A-Za-z0-9]/;
/** A Hangul syllable: a term starting with one must not start inside a word ("트리" in "엔트리"). */
const HANGUL_SYLLABLE = /[가-힣]/;

/**
 * Text that is never linked, as one capturing group (the split keeps it at
 * odd indexes): fenced code, inline code (also with double backticks), HTML
 * comments and tags, wikilinks, Markdown links and images, other bracketed
 * text (callout types, footnotes), URLs, math and heading lines. Indented
 * code is found line by line (`indentedCode`), since a nested list item is
 * indented the same way.
 */
const PROTECTED = new RegExp(
  "(" +
    [
      "```[\\s\\S]*?(?:```|$)",
      "~~~[\\s\\S]*?(?:~~~|$)",
      "<!--[\\s\\S]*?(?:-->|$)",
      "``[^\\n]*?``",
      "`[^`\\n]+`",
      "\\[\\[[^\\]\\n]*\\]\\]",
      "!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)",
      "\\[[^\\]\\n]*\\]",
      "https?:\\/\\/[^\\s)\\]]+",
      "\\$\\$[\\s\\S]*?\\$\\$",
      "\\$[^\\s$](?:[^$\\n]*[^\\s$])?\\$",
      "<[^<>\\n]+>",
      "(?<=^|\\n)[ ]{0,3}#{1,6}[ \\t][^\\n]*",
    ].join("|") +
    ")"
);

/**
 * Lines of indented code (four spaces or a tab) as [start, end) offsets: an
 * indented line after a blank line or more code, outside a list (a nested
 * list item or list content is indented the same way) and outside fenced
 * code (the fence rule takes that).
 */
function indentedCode(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let pos = 0;
  let fence: string | null = null;
  let list = false;
  let prevBlank = true;
  let prevCode = false;
  for (const line of text.split("\n")) {
    const start = pos;
    pos += line.length + 1;
    const blank = line.trim() === "";
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      prevBlank = false;
      prevCode = false;
      continue;
    }
    if (blank) {
      prevBlank = true;
      continue;
    }
    const indented = /^( {4}|\t)/.test(line);
    if (indented && !list && (prevBlank || prevCode)) {
      out.push([start, start + line.length]);
      prevCode = true;
      prevBlank = false;
      continue;
    }
    if (f) fence = f[1];
    if (/^\s*([-*+]|\d{1,9}[.)])\s/.test(line)) list = true;
    else if (!indented) list = false;
    prevCode = false;
    prevBlank = false;
  }
  return out;
}

/** The text split into alternating plain and protected pieces (protected at odd indexes). */
function splitProtected(text: string): string[] {
  const parts = [""];
  const plain = (seg: string) => {
    const sub = seg.split(PROTECTED);
    for (let j = 0; j < sub.length; j++) {
      if (j % 2 === 0) parts[parts.length - 1] += sub[j];
      else parts.push(sub[j], "");
    }
  };
  let pos = 0;
  for (const [a, b] of indentedCode(text)) {
    plain(text.slice(pos, a));
    parts.push(text.slice(a, b), "");
    pos = b;
  }
  plain(text.slice(pos));
  return parts;
}

/** Words that start a sentence or a phrase, not a longer term ("The Lottery Scheduling"). */
const SENTENCE_WORDS = new Set(["The", "A", "An", "In", "On", "Of", "For", "To", "And", "Or", "With", "By", "At", "As", "Is", "It", "This", "That"]);

/** Particles and endings a Korean term may carry ("트리를", "트리에서는", "트리입니다"), longest first. */
const PARTICLES = [
  "으로써", "으로서", "에서는", "에서도", "에게서", "으로는", "이라는", "이라고", "입니다", "이었다", "이에요",
  "에서", "에게", "한테", "까지", "부터", "처럼", "보다", "마다", "조차", "마저", "밖에", "이나", "이랑", "이며",
  "이고", "이다", "이라", "이면", "이었", "였다", "으로", "라는", "라고",
  "와", "과", "은", "는", "이", "가", "을", "를", "의", "에", "로", "도", "만", "나", "랑", "며", "고", "다",
  "라", "인", "일", "임", "뿐", "씩", "쯤", "요", "야", "면", "엔", "론", "든",
];

/** Words before a noun that do not make a compound with it: determiners and sentence adverbs ("그 트리", "여러 캐시", "그리고 트리"). */
const DETERMINERS = new Set([
  "그", "이", "저", "이런", "그런", "저런", "각", "새", "모든", "여러", "두", "세", "네", "한", "첫", "다른", "어떤",
  "매", "약", "총", "몇", "온", "이번", "다음", "해당", "같은", "또", "즉", "곧", "바로", "다시", "먼저", "또는",
  "그리고", "그러나", "하지만", "또한", "따라서", "그래서", "반면", "대신", "특히", "다만", "이때", "이제", "결국", "보통", "항상",
  "자기", "자신", "각자", "서로", "우리", "이들", "그들", "모두", "일부", "때", "후", "전", "뒤", "동안",
]);

/** Words after a term that do not make a compound with it ("트리 같은", "캐시 때문에", "트리 및"). */
const FOLLOWERS = [
  "같은", "같이", "등", "및", "또는", "혹은", "덕분에", "때문에", "대신", "대신에", "중", "중에", "중에서", "기반", "기반의", "기반으로",
  "자체", "만큼", "외", "외에", "이외", "관련", "관련된", "하나", "각각", "모두",
];

/**
 * Endings of a word that already carries a particle or a verb ending, so it
 * does not make a compound with the next word ("프로세스가 티켓을", "(화폐)로
 * 티켓을", "빠르게 트리를", "위해 캐시를").
 */
const PARTICLE_ENDINGS = [
  "의", "와", "과", "을", "를", "은", "는", "에", "가", "이", "도", "만", "로", "께", "서", "에서", "으로", "로서", "에게",
  "까지", "부터", "처럼", "보다", "게", "해", "며", "고", "지만", "면", "어", "아", "워", "눠", "려", "도록", "면서", "는데",
];

/** The Hangul right after a term is nothing but particles (at most three). */
function onlyParticles(run: string, depth = 0): boolean {
  if (run === "") return true;
  if (depth >= 3) return false;
  return PARTICLES.some((p) => run.startsWith(p) && onlyParticles(run.slice(p.length), depth + 1));
}

/** A Hangul word that makes a compound noun with the next word ("로터리 스케줄링", "페이지 테이블"). */
function modifiesAsNoun(word: string): boolean {
  if (DETERMINERS.has(word) || PARTICLE_ENDINGS.some((e) => word.endsWith(e))) return false;
  // A final ㄴ or ㄹ is a modifier ending ("정렬된", "사용할", "새로운").
  const last = word.charCodeAt(word.length - 1) - 0xac00;
  const final = last % 28;
  return final !== 4 && final !== 8;
}

/**
 * A Korean term (not a two-part name) stands alone: not inside a longer word
 * ("트리거", "키보드": only particles may follow it) and not part of a
 * compound noun with the word before or after it ("로터리 스케줄링",
 * "캐시 일관성").
 */
export function koreanStandsAlone(text: string, start: number, end: number): boolean {
  const after = text.slice(end);
  const run = after.match(/^[가-힣]+/);
  if (run) {
    if (!onlyParticles(run[0])) return false;
  } else {
    const next = after.match(/^[ \t]([가-힣]+)/);
    if (next && !FOLLOWERS.some((f) => next[1].startsWith(f) && onlyParticles(next[1].slice(f.length)))) return false;
  }
  const prev = text.slice(0, start).match(/([가-힣]+)[ \t]$/);
  return !(prev && modifiesAsNoun(prev[1]));
}

/** An English part next to another capitalized word is a piece of a longer term ("Ticket Currency", "Lottery Scheduling"). */
function englishInLongerTerm(text: string, start: number, end: number): boolean {
  const next = text.slice(end).match(/^[ \t]+([A-Z][A-Za-z]*)/);
  if (next && !SENTENCE_WORDS.has(next[1])) return true;
  const prev = text.slice(0, start).match(/(?:^|[^A-Za-z])([A-Z][A-Za-z]*)[ \t]+$/);
  return !!prev && !SENTENCE_WORDS.has(prev[1]);
}

/** Lines that belong to a Markdown table: a block with a delimiter row ("|---|---|" or "---|---"), also inside a callout. */
function tableLines(text: string): (at: number) => boolean {
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const body = (l: string) => l.replace(/^[ \t>]*/, "");
  const isDelimiter = (l: string) => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(body(l)) || /^\|\s*:?-+:?\s*\|\s*$/.test(body(l));
  const flags = lines.map(() => false);
  for (let i = 0; i < lines.length; ) {
    if (body(lines[i]).trim() === "") {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && body(lines[j]).trim() !== "") j++;
    if (lines.slice(i, j).some(isDelimiter)) for (let k = i; k < j; k++) flags[k] = body(lines[k]).includes("|");
    i = j;
  }
  return (at: number) => {
    let lo = 0;
    for (let i = 0; i < starts.length && starts[i] <= at; i++) lo = i;
    return flags[lo] || /^\|/.test(body(lines[lo]));
  };
}

/**
 * Link the first mention of each concept in `[[...]]` (the commentary
 * prompts' rule: one link, where a concept first appears).
 * - A concept is mentioned by its whole note name or, for a two-part name
 *   such as "Lottery Scheduling (로터리 스케줄링)", "로터리 스케줄링
 *   (Lottery Scheduling)" or "PTE (Page Table Entry)", by either part. The
 *   whole name becomes `[[name]]`, a part `[[name|part as written]]` (`\|`
 *   inside a table row).
 * - Matching ignores case and longer terms win. An English term needs a
 *   non-letter on each side and is not linked next to another capitalized
 *   word ("Ticket" in "Ticket Currency"); a Korean term is not linked inside
 *   a longer word or a compound noun ("트리거", "페이지 테이블").
 * - An existing wikilink to a concept under another name (the other name
 *   order, or the English part alone) is pointed at the note's real name,
 *   keeping the text it shows; `knownNames` (the concept notes already in
 *   the vault) count for this too. A concept linked anywhere is not linked
 *   again.
 * - Code, HTML, links, bracketed text, URLs, math and headings are left as
 *   they are.
 */
export function linkConceptNames(text: string, conceptNames: string[], knownNames: string[] = []): string {
  const names = Array.from(new Set(conceptNames.map((n) => n.trim()).filter((n) => n.length > 0)));
  const targets = Array.from(new Set([...names, ...knownNames.map((n) => n.trim()).filter((n) => n.length > 0)]));
  if (targets.length === 0) return text;
  const inTableRow = tableLines(text);

  // Existing wikilinks: point a concept link at the note's real name; note which concepts are linked.
  const parts = splitProtected(text);
  const linkRe = /^\[\[([^\]|#\n]+?)(#[^\]|\\]*)?(?:(\\?\|)([^\]]*))?\]\]$/;
  // A Korean-only note takes no link when two different concepts here share its Korean name.
  const ambiguous = ambiguousKorean([...targets, ...parts.filter((_, i) => i % 2 === 1).map((p) => p.match(linkRe)?.[1].trim() ?? "").filter(Boolean)]);
  const linked = new Set<string>();
  let base = 0;
  for (let i = 0; i < parts.length; i++) {
    const at = base;
    base += parts[i].length;
    if (i % 2 === 0) continue;
    const m = parts[i].match(linkRe);
    if (!m) continue;
    const target = m[1].trim();
    let real = target;
    if (!targets.some((t) => t.toLowerCase() === target.toLowerCase())) {
      const same = targets.find((t) => sameConcept(target, t, ambiguous));
      if (same) {
        real = same;
        const pipe = m[3] ?? (inTableRow(at) ? "\\|" : "|");
        parts[i] = `[[${same}${m[2] ?? ""}${pipe}${m[3] ? m[4] : target}]]`;
      }
    }
    for (const name of names) if (sameConcept(real, name, ambiguous)) linked.add(name);
  }
  if (names.length === 0) return parts.join("");

  // Every term with the concept it names. Each term goes to the first concept that has it.
  const terms = new Map<string, { term: string; concept: string; whole: boolean }>();
  for (const name of names) {
    const p = parseConceptName(name);
    const add = (term: string, whole: boolean) => {
      const key = term.toLowerCase();
      if (!term || (terms.has(key) && !(whole && !terms.get(key)!.whole))) return;
      terms.set(key, { term, concept: name, whole });
    };
    add(name, true);
    if (p.korean) for (const e of p.aliases) add(e, false);
    if (p.korean && p.aliases.length > 0) add(p.korean, false);
    if (!p.korean && p.aliases.length > 1) for (const e of p.aliases) add(e, false);
  }
  const sorted = Array.from(terms.values()).sort((a, b) => b.term.length - a.term.length);
  const pattern = new RegExp(
    sorted
      .map(({ term }) => {
        const head = ASCII_WORD.test(term[0]) ? "(?<![A-Za-z0-9])" : HANGUL_SYLLABLE.test(term[0]) ? "(?<![\\uAC00-\\uD7A3])" : "";
        const tail = ASCII_WORD.test(term[term.length - 1]) ? "(?![A-Za-z0-9])" : "";
        return head + escapeRegex(term) + tail;
      })
      .join("|"),
    "gi"
  );

  base = 0;
  return parts
    .map((part, i) => {
      const start = base;
      base += part.length;
      if (i % 2 === 1) return part; // protected
      return part.replace(pattern, (match, offset: number) => {
        const t = terms.get(match.toLowerCase());
        if (!t || linked.has(t.concept)) return match;
        const from = start + offset;
        const to = from + match.length;
        const single = !/\(/.test(t.term);
        if (single && ASCII_WORD.test(match) && !HANGUL_SYLLABLE.test(match) && !t.whole && englishInLongerTerm(text, from, to)) return match;
        if (single && HANGUL_SYLLABLE.test(match) && !koreanStandsAlone(text, from, to)) return match;
        linked.add(t.concept);
        if (conceptKey(match) === conceptKey(t.concept)) return `[[${t.concept}]]`;
        return `[[${t.concept}${inTableRow(from) ? "\\|" : "|"}${match}]]`;
      });
    })
    .join("");
}

/**
 * Push every heading down one level so the summary nests under
 * "## 📋 전체 요약":
 * - ATX headings with 0 to 3 leading spaces: `#` to `##`, ..., `#####` to
 *   `######`; `######` stays.
 * - Setext headings (a paragraph underlined with `===` or `---`) become ATX
 *   headings one level down (`##` and `###`).
 * Lines inside fenced code blocks are untouched; a fence closes only on the
 * same character repeated at least as many times as the opening fence.
 */
export function demoteHeadings(markdown: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  // Number of trailing `out` lines forming a paragraph that a setext
  // underline could turn into a heading.
  let paragraphLines = 0;

  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.len &&
        fenceMatch[2].trim() === ""
      ) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch && !(fenceMatch[1][0] === "`" && fenceMatch[2].includes("`"))) {
      fence = { char: fenceMatch[1][0], len: fenceMatch[1].length };
      out.push(line);
      paragraphLines = 0;
      continue;
    }

    const setext = line.match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (setext && paragraphLines > 0) {
      const text = out
        .splice(out.length - paragraphLines, paragraphLines)
        .map((l) => l.trim())
        .join(" ");
      out.push(`${setext[1][0] === "=" ? "##" : "###"} ${text}`);
      paragraphLines = 0;
      continue;
    }

    const atx = line.match(/^( {0,3})(#{1,6})(?=[ \t]|$)/);
    if (atx) {
      out.push(atx[2].length < 6 ? `${atx[1]}#${line.slice(atx[1].length)}` : line);
      paragraphLines = 0;
      continue;
    }

    out.push(line);
    paragraphLines = isParagraphLine(line) ? paragraphLines + 1 : 0;
  }
  return out.join("\n");
}

/** A line that can be part of a paragraph (and so of a setext heading). */
function isParagraphLine(line: string): boolean {
  if (line.trim() === "") return false;
  if (/^ {4,}/.test(line)) return false; // indented code
  return !/^ {0,3}([>|]|[-*+][ \t]|\d{1,9}[.)][ \t]|<!--)/.test(line);
}

/**
 * Lecture overview section placed between the title and slide 1. The body is
 * the enriched lecture summary with headings demoted (so it nests under
 * "## 📋 전체 요약") and concept names linked. Returns "" for an empty summary.
 */
export function buildOverviewSection(summary: string, conceptNames: string[], knownNames: string[] = []): string {
  const trimmed = (summary || "").trim();
  if (trimmed.length === 0) return "";
  const body = linkConceptNames(demoteHeadings(trimmed), conceptNames, knownNames);
  return [
    "## 📋 전체 요약",
    "",
    OVERVIEW_BLOCK_START,
    body,
    OVERVIEW_BLOCK_END,
    "",
    "",
  ].join("\n");
}
