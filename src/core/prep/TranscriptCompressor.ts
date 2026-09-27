// Transcript compression (spec 5.1). Pure and deterministic.
//
// 1. Remove Korean and English fillers ("음", "어", "그러니까", "um", "uh").
// 2. Collapse phrases repeated back to back ("그래서 그래서", "the the").
// 3. Drop sentences the STT emitted twice.
// 4. Keep sentences up to a per-slide cap, preferring the ones that share the
//    most words with the slide text, and emit them in their original order.

/** Standalone filler tokens. Matched as whole words, optional trailing comma or ellipsis. */
const KO_FILLERS = ["음", "으음", "음음", "어", "어어", "에", "에에", "그러니까", "저기", "그니까"];
const EN_FILLERS = ["um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "you know", "i mean"];
/** Words that are fillers only when a comma or ellipsis follows ("뭐, 그렇죠" but not "뭐가 문제"). */
const PAUSE_FILLERS_RE = /(^|[\s,.!?])(?:뭐|아|ah)(?:,|…|\.{2,})(?=$|\s)/giu;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FILLER_RE = new RegExp(
  `(^|[\\s,.!?])(?:${[...KO_FILLERS, ...EN_FILLERS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|")})(?:[,.…]+|\\.{2,})?(?=$|[\\s,.!?])`,
  "giu"
);

export function removeFillers(text: string): string {
  let prev = "";
  let out = text;
  // Adjacent fillers share a separator, so repeat until stable.
  while (prev !== out) {
    prev = out;
    out = out.replace(FILLER_RE, "$1").replace(PAUSE_FILLERS_RE, "$1");
  }
  return out.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").replace(/^[\s,]+/, "").trim();
}

/** "그래서 그래서 그래서" -> "그래서", for runs of 1 to 4 words. */
export function collapseRepeats(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const key = (w: string) => w.toLowerCase().replace(/[,.!?]+$/, "");
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    let skipped = false;
    for (let n = 4; n >= 1; n--) {
      if (out.length < n || i + n > words.length) continue;
      let same = true;
      for (let k = 0; k < n; k++) {
        if (key(out[out.length - n + k]) !== key(words[i + k])) {
          same = false;
          break;
        }
      }
      if (same) {
        // Keep the later copy's punctuation (the phrase may end the sentence).
        for (let k = 0; k < n; k++) out[out.length - n + k] = words[i + k];
        i += n;
        skipped = true;
        break;
      }
    }
    if (!skipped) out.push(words[i++]);
  }
  return out.join(" ");
}

/** Split after . ! ? … or Korean sentence endings followed by space. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…])\s+|(?<=(?:다|요|죠|까|니다|습니다)[.!?]?)\s+(?=\S)/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sentenceKey(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[\s,.!?…"'`]+/g, "");
}

/** Drop sentences whose normalized form already appeared (STT double output). */
export function dedupeSentences(sentences: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sentences) {
    const k = sentenceKey(s);
    if (k.length === 0 || seen.has(k)) continue;
    // A sentence contained in the previous one is the same utterance cut short.
    const prev = out.length > 0 ? sentenceKey(out[out.length - 1]) : "";
    if (k.length >= 6 && prev.includes(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** Word tokens (Latin words and Hangul runs of 2+) for overlap scoring. */
export function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.normalize("NFC").toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]{3,}|[가-힣]{2,}/g)) {
    const w = m[0];
    tokens.add(w);
    // Korean words carry particles: also index the first two syllables.
    if (/^[가-힣]/.test(w) && w.length > 2) tokens.add(w.slice(0, 2));
  }
  return tokens;
}

/**
 * Keep sentences within `capChars`, highest overlap with the slide text
 * first (ties keep the earlier sentence), returned in original order.
 */
export function capSentences(sentences: string[], slideText: string, capChars: number): string[] {
  if (capChars <= 0) return [];
  const total = sentences.reduce((n, s) => n + s.length + 1, 0);
  if (total <= capChars) return sentences;
  const slide = contentTokens(slideText);
  const scored = sentences.map((s, i) => {
    let score = 0;
    for (const t of contentTokens(s)) if (slide.has(t)) score++;
    return { i, s, score };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const keep = new Set<number>();
  let used = 0;
  for (const c of scored) {
    if (used + c.s.length + 1 > capChars) continue;
    keep.add(c.i);
    used += c.s.length + 1;
  }
  return sentences.filter((_, i) => keep.has(i));
}

export interface CompressResult {
  text: string;
  originalChars: number;
}

export function compressTranscript(chunk: string | null, slideText: string, capChars: number): CompressResult {
  if (!chunk || !chunk.trim()) return { text: "", originalChars: 0 };
  const cleaned = collapseRepeats(removeFillers(chunk));
  const sentences = dedupeSentences(splitSentences(cleaned));
  return { text: capSentences(sentences, slideText, capChars).join(" "), originalChars: chunk.length };
}

/**
 * Even character split, one chunk per slide (the 1.x rule, used while the
 * URL source has no timestamps; spec 4.3 rule 5).
 */
export function splitTranscriptEvenly(transcript: string | null, slideCount: number): Array<string | null> {
  if (!transcript || slideCount === 0) {
    return new Array(slideCount).fill(null);
  }
  const chunkSize = Math.ceil(transcript.length / slideCount);
  const chunks: Array<string | null> = [];
  for (let i = 0; i < slideCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, transcript.length);
    const chunk = transcript.slice(start, end).trim();
    chunks.push(chunk.length > 0 ? chunk : null);
  }
  return chunks;
}
