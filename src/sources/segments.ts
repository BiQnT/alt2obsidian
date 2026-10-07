// Transcript text without timestamps (the URL source, a pasted transcript)
// as segments. Pure, so the Skill CLIs can use it without the scraper.

import { TranscriptSegment } from "./types";

/** Transcript text lines as untimed segments. */
export function untimedSegments(transcript: string | null): TranscriptSegment[] {
  if (!transcript) return [];
  return transcript
    .split(/\n+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text) => ({ startMs: null, endMs: null, text, speaker: "" }));
}
