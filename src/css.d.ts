// Ambient declaration so esbuild's text loader can `import x from "...css"`
// and TypeScript recognizes it as a string default export.
declare module "*.css" {
  const content: string;
  export default content;
}

// The PDF.js worker as text (scripts/inline-pdf-worker.mjs, src/pdf/pdfWorker.ts).
// The modern build's pdf.mjs is not imported (the Synced Viewer renders with
// the legacy build, see the SyncedViewerView header), so it needs no
// declaration.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  const source: string;
  export default source;
}
