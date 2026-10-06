// Pure markdown helpers shared by the plugin (NoteGenerator) and the Skill
// CLI (scripts/src/overview-block.ts), so both build the overview block and
// concept wikilinks identically. No obsidian import.

import { OVERVIEW_BLOCK_END, OVERVIEW_BLOCK_START } from "../types";
import { conceptKey, parseConceptName, sameConcept } from "./conceptNames";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A word character of ASCII text: a term starting or ending with one needs a boundary there. */
const ASCII_WORD = /[A-Za-z0-9]/;
/** A Hangul syllable: a term starting with one must not start inside a word ("트리" in "엔트리"). */
const HANGUL_SYLLABLE = /[\uAC00-\uD7A3]/;

/**
 * Text that is never linked, as one capturing group (the split keeps it at
 * odd indexes): fenced code, inline code (also with double backticks),
 * wikilinks, Markdown links and images, URLs, math, HTML tags and footnote
 * references.
 */
const PROTECTED = new RegExp(
  "(" +
    [
      "```[\\s\\S]*?(?:```|$)",
      "~~~[\\s\\S]*?(?:~~~|$)",
      "``[^\\n]*?``",
      "`[^`\\n]+`",
      "\\[\\[[^\\]\\n]*\\]\\]",
      "!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)",
      "https?:\\/\\/[^\\s)\\]]+",
      "\\$\\$[\\s\\S]*?\\$\\$",
      "\\$[^$\\n]+\\$",
      "<[^<>\\n]+>",
      "\\[\\^[^\\]\\n]*\\]",
    ].join("|") +
    ")"
);

/**
 * Link the first mention of each concept in `[[...]]` (the commentary
 * prompts' rule: one link, where a concept first appears). A concept is mentioned by its whole
 * note name or, for a two-part name such as "Lottery Scheduling (로터리
 * 스케줄링)" or "로터리 스케줄링 (Lottery Scheduling)", by either part:
 * - the whole name becomes `[[name]]`, in the note's own spelling;
 * - a part becomes `[[name|part as written]]` (`\|` inside a table row).
 * Matching ignores case; longer terms win over terms they contain; an
 * English term needs a non-letter on each side ("stride" is not found in
 * "strides"), and an English part next to another capitalized word is a
 * piece of a longer term ("Ticket" in "Ticket Currency", "Scheduling" in
 * "Lottery Scheduling") and is not linked; a Korean term does not start
 * inside a word ("트리" in "엔트리"); names are matched literally. A concept the text already links
 * (any existing wikilink to it, in either name order) is not linked again.
 * Existing links, code, URLs, math, HTML tags and footnotes are left as
 * they are.
 */
export function linkConceptNames(text: string, conceptNames: string[]): string {
  const names = Array.from(new Set(conceptNames.map((n) => n.trim()).filter((n) => n.length > 0)));
  if (names.length === 0) return text;

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
    if (p.english && p.korean) {
      add(p.english, false);
      add(p.korean, false);
    }
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

  const parts = text.split(PROTECTED);
  // Concepts the text already links, in either name order.
  const linked = new Set<string>();
  for (let i = 1; i < parts.length; i += 2) {
    const m = parts[i].match(/^\[\[([^\]|#\n]+?)(?:#[^\]|]*)?(?:\\?\|[^\]]*)?\]\]$/);
    if (!m) continue;
    const target = m[1].trim();
    for (const name of names) if (sameConcept(target, name)) linked.add(name);
  }
  // A table row (also inside a callout) needs the alias pipe escaped, or it would end the cell.
  const inTableRow = (at: number) => /^[ \t>]*\|/.test(text.slice(text.lastIndexOf("\n", at - 1) + 1));
  let base = 0;
  return parts
    .map((part, i) => {
      const start = base;
      base += part.length;
      if (i % 2 === 1) return part; // protected
      return part.replace(pattern, (match, offset: number) => {
        const t = terms.get(match.toLowerCase());
        if (!t || linked.has(t.concept)) return match;
        // An English part next to another capitalized word is a piece of a longer term:
        // "Ticket" in "Ticket Currency", "Scheduling" in "Lottery Scheduling".
        if (!t.whole && ASCII_WORD.test(match[match.length - 1]) && /^[ \t]+[A-Z][A-Za-z]/.test(part.slice(offset + match.length))) return match;
        if (!t.whole && ASCII_WORD.test(match[0]) && /[A-Z][A-Za-z]*[ \t]+$/.test(part.slice(0, offset))) return match;
        linked.add(t.concept);
        if (conceptKey(match) === conceptKey(t.concept)) return `[[${t.concept}]]`;
        return `[[${t.concept}${inTableRow(start + offset) ? "\\|" : "|"}${match}]]`;
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
export function buildOverviewSection(summary: string, conceptNames: string[]): string {
  const trimmed = (summary || "").trim();
  if (trimmed.length === 0) return "";
  const body = linkConceptNames(demoteHeadings(trimmed), conceptNames);
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
