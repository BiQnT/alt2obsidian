// Public share URL source (spec 4.1, fallback path): the 1.x scraper. The
// page has no timestamps and no summary for most notes, so the transcript
// segments carry null times and the pipeline keeps the even split.

import { AltNoteData } from "../types";
import { AltScraper } from "../scraper/AltScraper";
import { LectureBundle, TranscriptSegment } from "./types";

/** Transcript text lines as untimed segments. */
export function untimedSegments(transcript: string | null): TranscriptSegment[] {
  if (!transcript) return [];
  return transcript
    .split(/\n+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text) => ({ startMs: null, endMs: null, text, speaker: "" }));
}

export function bundleFromAltData(altData: AltNoteData, pdf: ArrayBuffer | null): LectureBundle {
  return {
    sourceId: altData.metadata.noteId,
    sourceKind: "alt-url",
    title: altData.title,
    lectureDate: altData.metadata.createdAt?.slice(0, 10) || undefined,
    pdf,
    pdfPath: null,
    slideTexts: null,
    transcript: untimedSegments(altData.transcript),
    summaryMarkdown: altData.summary || undefined,
  };
}

export class AltPublicUrlSource {
  constructor(private scraper: AltScraper = new AltScraper()) {}

  /** Scraped page data; the PDF is downloaded later, at import time. */
  async fetch(url: string): Promise<{ altData: AltNoteData; bundle: LectureBundle }> {
    const altData = await this.scraper.fetch(url);
    return { altData, bundle: bundleFromAltData(altData, null) };
  }
}
