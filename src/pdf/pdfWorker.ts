// The PDF.js worker, bundled into main.js as text (scripts/inline-pdf-worker.mjs):
// Obsidian installs only main.js, manifest.json and styles.css. It is the
// same file the plugin used to ship next to main.js (pdfjs-dist
// build/pdf.worker.min.mjs), now run from a Blob URL: every document still
// gets its own module worker, as before.
import pdfWorkerSource from "pdfjs-dist/build/pdf.worker.min.mjs";

/** A Blob URL for `GlobalWorkerOptions.workerSrc`. Revoke it with `URL.revokeObjectURL` when the plugin unloads. */
export function createPdfWorkerUrl(): string {
  return URL.createObjectURL(new Blob([pdfWorkerSource], { type: "text/javascript" }));
}
