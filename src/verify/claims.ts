// Claim splitting for the note verifier (spec 4.6 step 1). Script only.
//
// The user's note (a Notion markdown export, a Notion MCP fetch or pasted
// text) is cut into sentences and bullets. Headings, blank lines, rules,
// code blocks, images and lines that are only links are dropped; bullet
// markers, checkboxes, quote markers, emphasis and HTML tags are removed.

export interface Claim {
  /** 1-based, in note order. */
  id: number;
  /** Claim text as shown in the verification note (quote). */
  text: string;
  /** 1-based line of the note it came from. */
  line: number;
  /** Text of the nearest heading above it ("" before the first heading). */
  section: string;
  /** 0 before the first heading, then 1, 2, ... per heading: claims of one section share it. */
  sectionIndex: number;
}

/** Shorter claims carry no checkable statement. */
export const MIN_CLAIM_CHARS = 8;
/** With Hangul a short sentence says more: at least this many non-space characters. */
export const MIN_HANGUL_CLAIM_CHARS = 4;

function longEnough(text: string): boolean {
  const content = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (/[가-힣]/.test(text)) return text.replace(/\s+/g, "").length >= MIN_HANGUL_CLAIM_CHARS && content.length >= 2;
  return text.length >= MIN_CLAIM_CHARS && content.length >= MIN_CLAIM_CHARS / 2;
}
/** Longer sentences are cut at a clause break so one claim stays one statement. */
export const MAX_CLAIM_CHARS = 300;

function stripInline(line: string): string {
  return line
    .replace(/<[^>\n]+>/g, " ")
    .replace(/!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g, " ")
    // [text](url) -> text, [[target|alias]] -> alias, [[target]] -> target
    .replace(/\[([^\]\n]+)\]\((?:[^)\n]*)\)/g, "$1")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1")
    .replace(/(\*\*|__|~~|==)/g, "")
    .replace(/(^|[\s(])[*_](\S[^*_\n]*\S|\S)[*_](?=[\s).,!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** A line with nothing but links, URLs or embeds. */
function onlyLinks(line: string): boolean {
  const rest = line
    .replace(/!?\[\[[^\]\n]*\]\]/g, "")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\s,;|·•\-*>]+/g, "");
  return rest.length === 0;
}

/**
 * Sentences of a paragraph. Splits after ". ", "? ", "! " and the Korean
 * endings "다." / "요." etc.; a period inside a number ("3.14") or a known
 * abbreviation ("e.g.", "i.e.", "vs.") does not end a sentence.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?。](?=\s+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + 1;
    const before = text.slice(Math.max(0, m.index - 4), end).toLowerCase();
    if (/(e\.g\.|i\.e\.|\bvs\.|\betc\.|\bcf\.|\bfig\.|\bno\.|\bex\.)$/.test(before)) continue;
    out.push(text.slice(start, end).trim());
    start = end;
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s.length > 0);
}

/** Cuts an over-long sentence at clause breaks (";", ", ") near the limit. */
function capLength(sentence: string): string[] {
  if (sentence.length <= MAX_CLAIM_CHARS) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_CLAIM_CHARS) {
    const window = rest.slice(0, MAX_CLAIM_CHARS);
    const cut = Math.max(window.lastIndexOf("; "), window.lastIndexOf(", "));
    const at = cut > MAX_CLAIM_CHARS / 3 ? cut + 1 : MAX_CLAIM_CHARS;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function splitClaims(markdown: string): Claim[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const claims: Claim[] = [];
  const seen = new Set<string>();
  let i = 0;
  // Frontmatter
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    if (close > 0) i = close + 1;
  }
  let fence: string | null = null;
  let math = false;
  let section = "";
  let sectionIndex = 0;
  /** The last non-blank line was a list item or its indented continuation. */
  let inList = false;
  const isTableRow = (l: string | undefined) => !!l && /^\s*\|.*\|\s*$/.test(l);
  const isTableRule = (l: string | undefined) => !!l && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && /-/.test(l);
  // Each line is taken alone: notes put one thought per line, and a Notion
  // export never hard-wraps a paragraph.
  const addLine = (body: string, line: number) => {
    for (const sentence of splitSentences(body)) {
      for (const part of capLength(sentence)) {
        const text = part.trim();
        if (!longEnough(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ id: claims.length + 1, text, line, section, sectionIndex });
      }
    }
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    const fenceMatch = raw.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const trimmed = raw.trim();
    // $$ math blocks (a one-line $$...$$ too).
    if (math) {
      if (/\$\$\s*$/.test(trimmed)) math = false;
      continue;
    }
    if (/^\$\$/.test(trimmed)) {
      if (!(trimmed.length > 2 && /\$\$\s*$/.test(trimmed.slice(2)))) math = true;
      continue;
    }
    if (!trimmed) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = stripInline(heading[1]).replace(/\s+#+\s*$/, "");
      sectionIndex++;
      inList = false;
      continue;
    }
    // Indented code (4 spaces or a tab) outside a list.
    if (/^( {4}|\t)/.test(raw) && !inList) continue;
    if (/^([-*_=]\s*){3,}$/.test(trimmed) || isTableRule(trimmed)) continue;
    // A table's header row is the row right above its |---| rule.
    if (isTableRow(raw) && isTableRule(lines[i + 1])) continue;
    inList = /^\s*([-*+]|\d+[.)])\s+/.test(raw) || (inList && /^\s+/.test(raw));
    if (/^<\/?(aside|details|summary)\b/i.test(trimmed) && stripInline(trimmed) === "") {
      continue;
    }
    if (onlyLinks(trimmed)) {
      continue;
    }
    // Callout header: its title is a label, not a statement.
    if (/^(>\s*)+\[!\w+\]/.test(trimmed)) {
      continue;
    }
    // Block markers: quote, bullets, numbers, checkboxes.
    let body = trimmed
      .replace(/^(>\s*)+/, "")
      .replace(/^([-*+]|\d+[.)])\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "");
    if (/^\|.*\|$/.test(body)) body = body.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ");
    body = stripInline(body);
    if (body) addLine(body, i + 1);
  }
  return claims;
}
