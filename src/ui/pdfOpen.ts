// Opening a lecture PDF opens the Synced Viewer (setting "강의 PDF를 열면
// 뷰어로 열기"). The decision is pure (no obsidian import) so it is unit
// tested; the plugin wires it to the workspace "file-open" event.

/** Slide markers the plugin and the Skill write (src/core/merge.ts parses them). */
const SLIDE_MARKER = /<!-- alt2obs:slide:\d+ hash:[0-9a-f]+ start -->/;

export interface NoteLookup {
  exists(path: string): boolean;
  /** Parsed frontmatter of a note, or null. */
  frontmatter(path: string): Record<string, unknown> | null | undefined;
  /** Note text (only read when the frontmatter does not decide). */
  read(path: string): Promise<string>;
}

/** Frontmatter of a lecture note made by the plugin or the Skill (an Alt id, or the plugin as source). */
export function isLectureFrontmatter(fm: Record<string, unknown> | null | undefined): boolean {
  if (!fm) return false;
  const str = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const source = typeof fm.source === "string" ? fm.source : "";
  return str(fm.alt_id) || str(fm.alt_local_id) || source === "alt2obsidian" || source === "alt2obsidian-cc-skill";
}

/**
 * The lecture note of a PDF: `<stem>.md` next to it (the PDF may end in
 * .pdf, .PDF or any other case) when that note is a lecture note: Alt or
 * plugin frontmatter, or the plugin's slide markers in its text. Null for
 * any other PDF, and for a transcript summary note (`alt_kind:
 * "transcript"`, spec 4.10): a PDF attached to it is shown as a plain PDF
 * until the next import turns the note into a slide note.
 */
export async function lectureNoteForPdf(pdfPath: string, notes: NoteLookup): Promise<string | null> {
  if (!/\.pdf$/i.test(pdfPath)) return null;
  const mdPath = pdfPath.replace(/\.pdf$/i, ".md");
  if (!notes.exists(mdPath)) return null;
  const fm = notes.frontmatter(mdPath);
  if (fm?.alt_kind === "transcript") return null;
  if (isLectureFrontmatter(fm)) return mdPath;
  try {
    return SLIDE_MARKER.test(await notes.read(mdPath)) ? mdPath : null;
  } catch {
    return null;
  }
}

export interface PdfOpenFacts {
  /** The setting "강의 PDF를 열면 뷰어로 열기". */
  enabled: boolean;
  /** View type of the tab the PDF opened in ("pdf" for Obsidian's PDF view), null when no tab shows it. */
  viewType: string | null;
  pdfPath: string;
  /** The tab was opened with "PDF만 보기" (or was a plain PDF tab before the plugin started). */
  bypass: boolean;
  /** A redirect of this PDF is already running (the viewer's own open does not start another). */
  busy: boolean;
  /** The lecture note of the PDF (`lectureNoteForPdf`), null when it is not a lecture PDF. */
  notePath: string | null;
}

export type PdfOpenDecision =
  | { action: "none"; reason: "off" | "not-pdf-view" | "bypass" | "busy" | "not-lecture" }
  | { action: "viewer"; mdPath: string; pdfPath: string };

/**
 * Whether a PDF that was just opened becomes the Synced Viewer. Only a
 * lecture PDF in Obsidian's own PDF view does, never a tab the user asked
 * to keep as a plain PDF, and never while a redirect of the same file runs
 * (the viewer renders the PDF itself, so it does not open a PDF tab, but a
 * second event during the switch must not start a second one).
 */
export function decidePdfOpen(f: PdfOpenFacts): PdfOpenDecision {
  if (!f.enabled) return { action: "none", reason: "off" };
  if (f.viewType !== "pdf") return { action: "none", reason: "not-pdf-view" };
  if (f.bypass) return { action: "none", reason: "bypass" };
  if (f.busy) return { action: "none", reason: "busy" };
  if (!f.notePath) return { action: "none", reason: "not-lecture" };
  return { action: "viewer", mdPath: f.notePath, pdfPath: f.pdfPath };
}
