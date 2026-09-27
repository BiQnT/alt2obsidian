// Pure markdown helpers shared by the plugin (NoteGenerator) and the Skill
// CLI (scripts/src/overview-block.ts), so both build the overview block and
// concept wikilinks identically. No obsidian import.

import { OVERVIEW_BLOCK_END, OVERVIEW_BLOCK_START } from "../types";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Wrap every occurrence of a concept name in `[[...]]` (case-insensitive,
 * written with the concept's canonical spelling). Longer names win over
 * names they contain ("캐시 일관성 (Cache Coherence)" before "캐시"), text
 * already inside `[[...]]` is left alone, and names are matched literally.
 */
export function linkConceptNames(text: string, conceptNames: string[]): string {
  const names = Array.from(
    new Set(conceptNames.map((n) => n.trim()).filter((n) => n.length > 0))
  ).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;

  const canonical = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, name);
  }
  const pattern = new RegExp(names.map(escapeRegex).join("|"), "gi");
  const link = (segment: string) =>
    segment.replace(pattern, (m) => `[[${canonical.get(m.toLowerCase()) ?? m}]]`);

  // Odd indexes of the split are existing wikilinks; keep them verbatim.
  return text
    .split(/(\[\[[^\]\n]*\]\])/)
    .map((part, i) => (i % 2 === 1 ? part : link(part)))
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
