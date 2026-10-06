// Scroll sync math of the Synced Viewer, kept free of DOM and obsidian
// imports so it is unit-tested in Node (test/test-viewer.mjs).

/**
 * Slide number of a rendered heading: "📚 슬라이드 12" (1.0 to 2.0 notes),
 * also without the emoji or with a title after the number. null for any
 * other heading.
 */
export function slideNumberFromHeading(text: string): number | null {
  const m = text.trim().match(/^(?:📚\s*)?슬라이드\s*(\d+)(?!\d)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Which rendered headings are slide sections. The plugin and the Skill write
 * `## 📚 슬라이드 N` (h2 with the emoji); when a note has any of those, only
 * they count, so an overview subheading like "### 슬라이드 2~3 정리" is not
 * taken for slide 2. A note without them (hand-made) falls back to h2/h3
 * headings starting with "슬라이드 N". The first heading per number wins.
 */
export function pickSlideHeadings(headings: Array<{ level: number; text: string }>): Array<{ index: number; num: number }> {
  const pick = (ok: (h: { level: number; text: string }) => boolean) => {
    const out: Array<{ index: number; num: number }> = [];
    const seen = new Set<number>();
    headings.forEach((h, index) => {
      if (!ok(h)) return;
      const num = slideNumberFromHeading(h.text);
      if (num === null || seen.has(num)) return;
      seen.add(num);
      out.push({ index, num });
    });
    return out;
  };
  const primary = pick((h) => h.level === 2 && /^\s*📚/.test(h.text));
  return primary.length > 0 ? primary : pick((h) => h.level === 2 || h.level === 3);
}

/**
 * The section a pane is reading: the last section whose top is at or above
 * the probe line (scrollTop plus a fraction of the pane height). `sections`
 * are in document order. null when the probe is above the first section
 * (for example the overview above slide 1).
 */
export function sectionAt(sections: Array<{ num: number; top: number }>, probe: number): number | null {
  let found: number | null = null;
  for (const s of sections) {
    if (s.top <= probe) found = s.num;
    else break;
  }
  return found;
}

/** The heading to scroll to for a slide: its own, else the closest earlier one, else the first. */
export function headingForSlide<T>(headings: Map<number, T>, slide: number): T | null {
  if (headings.has(slide)) return headings.get(slide)!;
  let best: number | null = null;
  for (const n of headings.keys()) if (n <= slide && (best === null || n > best)) best = n;
  if (best !== null) return headings.get(best)!;
  const first = Math.min(...headings.keys());
  return Number.isFinite(first) ? headings.get(first)! : null;
}

/** Where in a pane the "current" line sits, as a share of its height. */
export const PROBE_SHARE = 0.25;
