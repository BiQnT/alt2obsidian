// Ambient declaration so esbuild's text loader can `import x from "...css"`
// and TypeScript recognizes it as a string default export.
declare module "*.css" {
  const content: string;
  export default content;
}

// pdfjs-dist 4.10 ships .d.mts type files for the legacy build only. The
// modern build (`pdfjs-dist/build/pdf.mjs`) is needed by `pdf_viewer.mjs`
// (the Synced Viewer's PDFViewer uses the modern runtime), so we declare
// it as ambient `any` to keep tsc happy while letting esbuild bundle it.
declare module "pdfjs-dist/build/pdf.mjs" {
  const content: any;
  export = content;
}

// Note: pdfjs-dist/web/pdf_viewer.mjs is no longer imported (Synced Viewer
// pivoted from A2 to A4 canvas-only — see SyncedViewerView header). Kept
// the modern build declaration above in case future code needs it.
