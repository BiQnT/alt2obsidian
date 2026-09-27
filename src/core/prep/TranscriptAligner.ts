// Transcript to slide alignment (spec 4.3). Pure and deterministic, no LLM.
//
// 1. Slide texts and transcript segments are tokenized (Korean and English,
//    lowercased, stopwords dropped, light stemming, Korean particles cut).
// 2. Every segment gets an emission score per slide: BM25 of a short time
//    window around the segment (the slides are the documents), divided by
//    the window's best score plus a damping constant, so a window with no
//    slide vocabulary is uninformative instead of confidently wrong.
// 3. A Viterbi pass over the segments picks one slide per segment. Staying
//    is free, moving to the next slide costs a little, skipping ahead costs
//    more per skipped slide, and going back (a revisit or a recap) costs the
//    most. The order is mostly monotonic but revisits stay possible. Each
//    slide also has an "off topic" twin state with a flat emission, so an
//    announcement, a video or a Q&A tangent keeps the current slide instead
//    of dragging the path to whatever slide shares a word with it.
// 4. Runs of the same slide become spans with a confidence in [0, 1]: the
//    assigned slide's share of the emission mass against the best other
//    slide, damped for spans with little evidence.
//
// Pages with identical text (animation builds) score the same; the path
// walks through them in order. Template pages (cover, contents, thanks)
// take part like any other page.

export interface TimedSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface AlignedSpan {
  /** 1-based slide number. */
  slide: number;
  startMs: number;
  endMs: number;
  /** Index of the first segment, and one past the last. */
  fromSegment: number;
  toSegment: number;
  /** 0 (no evidence) to 1 (only this slide matches). */
  confidence: number;
}

export interface AlignmentResult {
  spans: AlignedSpan[];
  /** Slide number per segment (1-based). */
  segmentSlides: number[];
}

/** Below this a span counts as low confidence (LLM check candidates, "?" in frontmatter). */
export const LOW_CONFIDENCE = 0.45;

export interface AlignerParams {
  /** Half width of the scoring window around a segment, ms. */
  windowMs: number;
  /** Damping added to a window's best score before normalizing, as a share of the lecture's median best score. */
  damping: number;
  /** Cost of moving to the next slide. */
  nextCost: number;
  /** Extra cost per skipped slide when jumping ahead. */
  skipCost: number;

  /** Cost of going back to an earlier slide. */
  backCost: number;
  /** Extra cost per slide of a backward jump. */
  backPerSlide: number;
  /** Emission of the "off topic" state (talk that matches no slide). */
  offEmission: number;
  /** Cost of drifting off topic; coming back to the same slide is free. */
  offCost: number;
  /** Extra copies of the slide's first line (its title) in the slide document. */
  titleWeight: number;
  bm25K1: number;
  bm25B: number;
}

// Tuned on the two draft-labelled lectures in test/fixtures/alignment
// (test/eval-alignment.mjs); revisit when the labels are confirmed.
export const DEFAULT_ALIGNER_PARAMS: AlignerParams = {
  windowMs: 15000,
  damping: 0.4,
  nextCost: 1.2,
  skipCost: 1.5,
  backCost: 6,
  backPerSlide: 0.05,
  offEmission: 0.5,
  offCost: 1,
  titleWeight: 1,
  bm25K1: 1.2,
  bm25B: 0.75,
};

const EN_STOPWORDS = new Set(
  (
    "a an the and or but if then than so as at by for from in into of on onto to with without within about above below over under " +
    "is are was were be been being am do does did done doing have has had having can could will would shall should may might must " +
    "this that these those there here it its it's they them their we us our you your he she his her i me my mine " +
    "what which who whom whose when where why how all any both each few more most other some such no nor not only own same " +
    "very just also too again further once now okay ok yeah yes right well like really actually basically kind sort thing things " +
    "let lets go going get got say said see look talk think know want need make made use used using one two way ll ve re don doesn didn isn aren wasn " +
    "slide slides lecture today class question questions answer example examples"
  ).split(/\s+/)
);

const KO_STOPWORDS = new Set(
  (
    "그리고 그래서 그러면 그러니까 그런데 하지만 그러나 또는 혹은 이제 지금 여기 거기 저기 이것 그것 저것 이거 그거 저거 이런 그런 저런 " +
    "이렇게 그렇게 저렇게 우리 여러분 제가 저는 나는 내가 너무 정말 진짜 약간 조금 많이 그냥 일단 다시 계속 먼저 다음 " +
    "있습니다 있어요 있는 있고 없습니다 없는 합니다 해요 하는 하고 해서 했습니다 됩니다 되는 된다 이다 입니다 에요 예요 " +
    "것이 것은 것을 거죠 거예요 거에요 뭐냐 무엇 어떤 어떻게 왜냐 때문 경우 부분 정도 슬라이드 강의 오늘 질문"
  ).split(/\s+/)
);

/** Particles and endings cut from the end of a Hangul word, longest first. */
const KO_SUFFIXES = [
  "에서는", "으로는", "이라는", "이라고", "입니다", "했습니다", "합니다", "에게서", "까지는", "부터는",
  "에서", "으로", "에게", "까지", "부터", "라는", "라고", "이고", "이며", "하는", "하고", "해서", "했다", "한다", "된다", "되는", "처럼", "보다", "마다", "이나", "에는", "와는", "과는", "들이", "들을", "들은", "들의",
  "은", "는", "이", "가", "을", "를", "에", "의", "로", "와", "과", "도", "만", "들", "고", "다", "요",
].sort((a, b) => b.length - a.length);

/** Light stemming; only needs to map a word's common forms to one token ("caches" -> "cache"). */
function stemEnglish(w: string): string {
  let t = w;
  if (t.length > 4 && t.endsWith("ies")) t = t.slice(0, -3) + "y";
  else if (t.length > 4 && t.endsWith("sses")) t = t.slice(0, -2);
  else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
  return t;
}

function stemKorean(w: string): string {
  for (const s of KO_SUFFIXES) {
    if (w.length - s.length >= 2 && w.endsWith(s)) return w.slice(0, -s.length);
  }
  return w;
}

/** Tokens with repeats (term frequency matters for BM25). */
export function alignTokens(text: string): string[] {
  const out: string[] = [];
  // NFKC folds math alphanumerics (𝐿, 𝑀) and full-width letters to ASCII.
  const lower = text.normalize("NFKC").toLowerCase();
  for (const m of lower.matchAll(/[a-z][a-z0-9]*|\d+(?:\.\d+)?|[가-힣]+/g)) {
    const w = m[0];
    if (/^[가-힣]/.test(w)) {
      if (w.length < 2 || KO_STOPWORDS.has(w)) continue;
      const stem = stemKorean(w);
      if (stem.length < 2 || KO_STOPWORDS.has(stem)) continue;
      out.push(stem);
    } else if (/^\d/.test(w)) {
      // Numbers identify slides well ("32 bit", "64 KB"), except tiny ones.
      if (w.length >= 2) out.push(w);
    } else {
      if (w.length < 2 || EN_STOPWORDS.has(w)) continue;
      const stem = stemEnglish(w);
      if (stem.length < 2 || EN_STOPWORDS.has(stem)) continue;
      out.push(stem);
    }
  }
  return out;
}

interface SlideIndex {
  tf: Array<Map<string, number>>;
  len: number[];
  avgLen: number;
  idf: Map<string, number>;
}

function indexSlides(slideTexts: string[], titleWeight: number): SlideIndex {
  const tf = slideTexts.map((t) => {
    const m = new Map<string, number>();
    const title = t.split("\n").find((line) => line.trim().length > 0) ?? "";
    const titleTokens = alignTokens(title);
    for (const tok of alignTokens(t)) m.set(tok, (m.get(tok) ?? 0) + 1);
    for (let r = 0; r < titleWeight; r++) for (const tok of titleTokens) m.set(tok, (m.get(tok) ?? 0) + 1);
    return m;
  });
  const len = tf.map((m) => Array.from(m.values()).reduce((a, b) => a + b, 0));
  const avgLen = Math.max(1, len.reduce((a, b) => a + b, 0) / Math.max(1, len.length));
  const df = new Map<string, number>();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = slideTexts.length;
  const idf = new Map<string, number>();
  for (const [t, d] of df) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  return { tf, len, avgLen, idf };
}

function bm25(query: Map<string, number>, index: SlideIndex, p: AlignerParams): number[] {
  const scores = new Array(index.tf.length).fill(0);
  for (const [term] of query) {
    const idf = index.idf.get(term);
    if (idf === undefined) continue;
    for (let j = 0; j < index.tf.length; j++) {
      const f = index.tf[j].get(term);
      if (!f) continue;
      const norm = p.bm25K1 * (1 - p.bm25B + (p.bm25B * index.len[j]) / index.avgLen);
      scores[j] += (idf * f * (p.bm25K1 + 1)) / (f + norm);
    }
  }
  return scores;
}

/** Emission matrix [segment][slide] in [0, 1). */
export function emissionScores(slideTexts: string[], segments: TimedSegment[], p: AlignerParams = DEFAULT_ALIGNER_PARAMS): number[][] {
  const index = indexSlides(slideTexts, p.titleWeight);
  const segTokens = segments.map((s) => alignTokens(s.text));
  const raw: number[][] = [];
  const bests: number[] = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < segments.length; i++) {
    const from = segments[i].startMs - p.windowMs;
    const to = segments[i].endMs + p.windowMs;
    while (lo < segments.length && segments[lo].endMs < from) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < segments.length && segments[hi + 1].startMs <= to) hi++;
    const query = new Map<string, number>();
    for (let k = Math.min(lo, i); k <= hi; k++) for (const t of segTokens[k]) query.set(t, (query.get(t) ?? 0) + 1);
    const scores = bm25(query, index, p);
    raw.push(scores);
    bests.push(Math.max(0, ...scores));
  }
  // Damping relative to this lecture's typical window score, so the scale
  // of BM25 (deck size, talk speed) does not matter.
  const sorted = bests.filter((b) => b > 0).sort((a, b) => a - b);
  const typical = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 1;
  const damp = p.damping * typical;
  return raw.map((scores, i) => scores.map((s) => s / (bests[i] + damp)));
}

const TEXTLESS_BONUS = 0.05;

/** A slide needs this many tokens to be matched by its text. */
export const MIN_SLIDE_TOKENS = 3;

/** Slides with enough text to be matched (textless: image-only or scanned pages). */
export function textSlideMask(slideTexts: string[]): boolean[] {
  return slideTexts.map((t) => alignTokens(t).length >= MIN_SLIDE_TOKENS);
}

/**
 * `textBefore[j]` = text slides among 0..j-1. Skipping a textless slide is
 * free: nothing in the transcript can show it was shown.
 */
function transitionCost(from: number, to: number, p: AlignerParams, textBefore: Int32Array): number {
  if (to === from) return 0;
  if (to === from + 1) return p.nextCost;
  if (to > from) return p.nextCost + p.skipCost * (textBefore[to] - textBefore[from + 1]);
  return p.backCost + p.backPerSlide * (from - to);
}

/**
 * A run of segments on a block of consecutive textless slides is split in
 * order across the block, so each textless slide gets part of the talk
 * given while the block was on screen (the path itself cannot tell them apart).
 */
function spreadTextless(path: number[], isText: boolean[]): void {
  const n = path.length;
  let i = 0;
  while (i < n) {
    if (isText[path[i]]) {
      i++;
      continue;
    }
    let a = path[i];
    while (a > 0 && !isText[a - 1]) a--;
    let b = path[i];
    while (b + 1 < isText.length && !isText[b + 1]) b++;
    let k = i;
    while (k < n && path[k] >= a && path[k] <= b) k++;
    const len = k - i;
    const slides = b - a + 1;
    if (slides > 1) for (let q = 0; q < len; q++) path[i + q] = a + Math.min(slides - 1, Math.floor((q * slides) / len));
    i = k;
  }
}

export function alignTranscript(
  slideTexts: string[],
  segments: TimedSegment[],
  params: Partial<AlignerParams> = {}
): AlignmentResult {
  const p = { ...DEFAULT_ALIGNER_PARAMS, ...params };
  const m = slideTexts.length;
  const n = segments.length;
  if (m === 0 || n === 0) return { spans: [], segmentSlides: [] };
  const e = emissionScores(slideTexts, segments, p);
  // Textless slides: a flat score a little above the off-topic state, so talk
  // that matches no slide text can settle on them instead of a neighbour.
  const isText = textSlideMask(slideTexts);
  const textBefore = new Int32Array(m + 1);
  for (let j = 0; j < m; j++) textBefore[j + 1] = textBefore[j] + (isText[j] ? 1 : 0);
  for (const row of e) for (let j = 0; j < m; j++) if (!isText[j]) row[j] = p.offEmission + TEXTLESS_BONUS;

  // Viterbi, maximizing emission minus transition cost. Every slide has an
  // "on" state (talking about it) and an "off" state (talk that matches no
  // slide while it is still on screen: announcements, Q&A, a video). The off
  // state keeps the position, so a tangent does not force a jump.
  let on = new Float64Array(m);
  let off = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    const enter = j === 0 ? 0 : (p.nextCost + p.skipCost * textBefore[j]) * 0.5;
    on[j] = e[0][j] - enter;
    off[j] = p.offEmission - p.offCost - enter;
  }
  // Back pointers: state index (j for on, m + j for off) of the predecessor.
  const back: Int32Array[] = [new Int32Array(2 * m).fill(-1)];
  const best = new Float64Array(m);
  const bestState = new Int32Array(m);
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (off[j] > on[j]) {
        best[j] = off[j];
        bestState[j] = m + j;
      } else {
        best[j] = on[j];
        bestState[j] = j;
      }
    }
    const nextOn = new Float64Array(m);
    const nextOff = new Float64Array(m);
    const ptr = new Int32Array(2 * m);
    for (let k = 0; k < m; k++) {
      let v = -Infinity;
      let arg = k;
      for (let j = 0; j < m; j++) {
        const c = best[j] - transitionCost(j, k, p, textBefore);
        if (c > v) {
          v = c;
          arg = bestState[j];
        }
      }
      nextOn[k] = v + e[i][k];
      ptr[k] = arg;
      const stay = off[k];
      const drift = on[k] - p.offCost;
      nextOff[k] = Math.max(stay, drift) + p.offEmission;
      ptr[m + k] = stay >= drift ? m + k : k;
    }
    back.push(ptr);
    on = nextOn;
    off = nextOff;
  }
  let lastState = 0;
  let lastScore = -Infinity;
  for (let j = 0; j < m; j++) {
    if (on[j] > lastScore) {
      lastScore = on[j];
      lastState = j;
    }
    if (off[j] > lastScore) {
      lastScore = off[j];
      lastState = m + j;
    }
  }
  const states = new Array<number>(n);
  states[n - 1] = lastState;
  for (let i = n - 1; i > 0; i--) states[i - 1] = back[i][states[i]];
  const path = states.map((st) => st % m);
  spreadTextless(path, isText);

  const spans: AlignedSpan[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && path[i] === path[start]) continue;
    const j = path[start];
    let own = 0;
    let other = 0;
    for (let k = start; k < i; k++) {
      own += e[k][j];
      let alt = 0;
      for (let q = 0; q < m; q++) if (q !== j && e[k][q] > alt) alt = e[k][q];
      other += alt;
    }
    const share = own + other > 0 ? own / (own + other) : 0;
    // Little evidence (few segments, weak matches) pulls the confidence down.
    const evidence = Math.min(1, own / 3);
    spans.push({
      slide: j + 1,
      startMs: segments[start].startMs,
      endMs: segments[i - 1].endMs,
      fromSegment: start,
      toSegment: i,
      confidence: Math.round(share * (0.5 + 0.5 * evidence) * 100) / 100,
    });
    start = i;
  }
  return { spans, segmentSlides: path.map((j) => j + 1) };
}

/** Transcript chunk per slide (index 0 = slide 1) from the aligned segments; null when a slide got none. */
export function chunksFromAlignment(
  result: AlignmentResult,
  segments: TimedSegment[],
  slideCount: number
): Array<string | null> {
  const parts: string[][] = Array.from({ length: slideCount }, () => []);
  result.segmentSlides.forEach((slide, i) => {
    if (slide >= 1 && slide <= slideCount) parts[slide - 1].push(segments[i].text.trim());
  });
  return parts.map((p) => {
    const text = p.filter((t) => t.length > 0).join(" ");
    return text.length > 0 ? text : null;
  });
}

/**
 * Compact frontmatter form, spans in time order: "3:120-181 4:181-260? 3:260-300"
 * (slide:startSec-endSec, "?" marks a low-confidence span). A span ends
 * where the next one starts, so every second belongs to one span.
 */
export function formatAlignment(spans: AlignedSpan[]): string {
  return spans
    .map((s, i) => {
      const start = Math.floor(s.startMs / 1000);
      const end = i + 1 < spans.length ? Math.floor(spans[i + 1].startMs / 1000) : Math.ceil(s.endMs / 1000);
      return `${s.slide}:${start}-${Math.max(start, end)}${s.confidence < LOW_CONFIDENCE ? "?" : ""}`;
    })
    .join(" ");
}

export interface StoredSpan {
  slide: number;
  startMs: number;
  endMs: number;
  low: boolean;
}

/** Inverse of `formatAlignment`; malformed entries are skipped. */
export function parseAlignment(value: unknown): StoredSpan[] {
  if (typeof value !== "string") return [];
  const out: StoredSpan[] = [];
  for (const part of value.trim().split(/\s+/)) {
    const m = part.match(/^(\d+):(\d+)-(\d+)(\?)?$/);
    if (!m) continue;
    const startMs = Number(m[2]) * 1000;
    const endMs = Number(m[3]) * 1000;
    if (endMs < startMs) continue;
    out.push({ slide: Number(m[1]), startMs, endMs, low: m[4] === "?" });
  }
  return out;
}

/** Spans of one slide (a revisited slide has several). */
export function spansForSlide(spans: StoredSpan[], slide: number): StoredSpan[] {
  return spans.filter((s) => s.slide === slide);
}
