// Attaching a PDF to a lecture without slides (spec 4.10). Pure helpers
// shared by the plugin and its tests; the copy itself is in src/main.ts
// (`attachPdf`), the pickers in src/ui/attachPdf.ts.
//
// The attached PDF becomes the lecture's sibling `<Subject>/Lectures/<lecture>.pdf`
// and the note is marked `alt_pdf_source: "attached"`, so every later
// import (and the sidebar) treats the lecture as a slide lecture with that
// PDF: alignment, per-slide commentary, the Synced Viewer and verification
// against the slides.

/** Frontmatter key and value that remember an attached PDF. */
export const ATTACHED_KEY = "alt_pdf_source";
export const ATTACHED_VALUE = "attached";
export const ATTACHED_LINE = `${ATTACHED_KEY}: "${ATTACHED_VALUE}"`;

/** A PDF starts with "%PDF-" (some files carry a few bytes of junk before it, allowed up to 1024 bytes). */
export function looksLikePdf(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(1024, data.byteLength));
  const sig = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + sig.length <= bytes.length; i++) {
    let ok = true;
    for (let k = 0; k < sig.length; k++) {
      if (bytes[i + k] !== sig[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Where the PDF of a lecture note goes: `<note stem>.pdf` next to it. */
export function attachedPdfPath(notePath: string): string {
  return notePath.replace(/\.md$/i, "") + ".pdf";
}

/**
 * The note's frontmatter (its text, not a metadata cache that may lag right
 * after `attachPdf` wrote the line) marks an attached PDF.
 */
export function markedAttached(noteContent: string | null): boolean {
  const fm = noteContent?.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  return !!fm && /^alt_pdf_source:[ \t]*["']?attached["']?[ \t]*\r?$/m.test(fm[1]);
}
