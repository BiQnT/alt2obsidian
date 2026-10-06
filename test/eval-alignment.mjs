/**
 * Alignment evaluation (spec 4.3 acceptance): TranscriptAligner vs the 1.x
 * even character split, on the labelled lectures in test/fixtures/alignment.
 *
 * The labels hold slide boundaries only. The decks and transcripts are the
 * user's own lecture data and are not committed: pass the folder holding
 * them (`<lecture>.pdf` and `<lecture>-transcript.json`, the transcript
 * component's content_text as Alt stores it, as named in each label file),
 * or set ALT2OBS_ALIGN_DATA. Without the data the script says so and exits 0.
 *
 * Accuracy = share of transcript segments whose predicted slide equals the
 * labelled slide, over segments labelled with a slide (off-topic segments,
 * slide 0, are excluded and counted separately).
 *
 * Run: node test/eval-alignment.mjs [dataDir]
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const m = await importTs("test/helpers/alignment-entry.ts");

export function labelPerSegment(labels, segmentCount) {
  const out = new Array(segmentCount).fill(0);
  labels.spans.forEach((s, i) => {
    const end = i + 1 < labels.spans.length ? labels.spans[i + 1].fromSegment : segmentCount;
    for (let k = s.fromSegment; k < end; k++) out[k] = s.slide;
  });
  return out;
}

/** The 1.x rule: the transcript text cut into equal character chunks, one per slide. */
export function evenSplitPerSegment(segments, slideCount) {
  const text = segments.map((s) => s.text).join("\n");
  const size = Math.ceil(text.length / slideCount);
  const out = [];
  let offset = 0;
  for (const s of segments) {
    out.push(Math.min(slideCount, Math.floor(offset / size) + 1));
    offset += s.text.length + 1;
  }
  return out;
}

function accuracy(pred, truth) {
  let n = 0;
  let ok = 0;
  truth.forEach((t, i) => {
    if (t === 0) return;
    n++;
    if (pred[i] === t) ok++;
  });
  return n > 0 ? ok / n : 0;
}

async function slideTexts(pdfPath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdfPath)), verbosity: 0 }).promise;
  try {
    const layouts = await m.extractPageLayouts(doc);
    return layouts.map(m.layoutAlignmentText);
  } finally {
    await doc.destroy();
  }
}

export function segmentsFromAltJson(raw) {
  const out = [];
  for (const entry of raw) for (const s of entry.segments ?? []) out.push({ startMs: s.start, endMs: s.end, text: s.text ?? "" });
  return out;
}

export async function evaluate(dataDir, params = {}) {
  const dir = join(repo, "test/fixtures/alignment");
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const labels = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const pdf = join(dataDir, labels.inputs.pdf);
    const tr = join(dataDir, labels.inputs.transcript);
    if (!existsSync(pdf) || !existsSync(tr)) continue;
    const texts = await slideTexts(pdf);
    const segments = segmentsFromAltJson(JSON.parse(readFileSync(tr, "utf8")));
    const truth = labelPerSegment(labels, segments.length);
    const res = m.alignTranscript(texts, segments, params);
    const even = evenSplitPerSegment(segments, texts.length);
    rows.push({
      lecture: labels.lecture,
      slides: texts.length,
      segments: segments.length,
      offTopic: truth.filter((t) => t === 0).length,
      aligner: accuracy(res.segmentSlides, truth),
      even: accuracy(even, truth),
      spans: res.spans.length,
      lowSpans: res.spans.filter((s) => s.confidence < m.LOW_CONFIDENCE).length,
    });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dataDir = process.argv[2] || process.env.ALT2OBS_ALIGN_DATA;
  if (!dataDir || !existsSync(dataDir)) {
    console.log("INFO: alignment eval skipped (no data folder; pass one or set ALT2OBS_ALIGN_DATA)");
    process.exit(0);
  }
  const rows = await evaluate(dataDir);
  if (rows.length === 0) {
    console.log("INFO: alignment eval skipped (the data folder has none of the labelled lectures)");
    process.exit(0);
  }
  console.log("| lecture | slides | segments | off-topic | aligner | even split | spans (low) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.lecture} | ${r.slides} | ${r.segments} | ${r.offTopic} | ${(r.aligner * 100).toFixed(1)}% | ${(r.even * 100).toFixed(1)}% | ${r.spans} (${r.lowSpans}) |`
    );
  }
  console.log("Labels are drafts (draft: true, needs user review); the numbers are final only after the user confirms them.");
}
