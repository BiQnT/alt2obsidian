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
 * Push every ATX heading down one level (`#` to `##`, ..., `#####` to
 * `######`; `######` stays). Lines inside fenced code blocks are untouched.
 */
export function demoteHeadings(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      return /^#{1,5}(\s|$)/.test(line) ? `#${line}` : line;
    })
    .join("\n");
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
