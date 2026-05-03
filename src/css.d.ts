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

declare module "pdfjs-dist/web/pdf_viewer.mjs" {
  // Subset we actually use; widen to `any` to avoid pinning the surface.
  // Declare as both class (value + type) so they can be used as
  // type annotations on fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class PDFViewer {
    constructor(options: any);
    setDocument(doc: any): void;
    currentPageNumber: number;
    currentScale: number;
    currentScaleValue: string;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class EventBus {
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class PDFLinkService {
    constructor(options: any);
    setDocument(doc: any, baseUrl: string | null): void;
    setViewer(viewer: any): void;
  }
  const _default: any;
  export default _default;
}
