// esbuild plugin: `import source from "pdfjs-dist/build/pdf.worker.min.mjs"`
// gives the worker file's text (src/pdf/pdfWorker.ts runs it from a Blob
// URL). Obsidian installs only main.js, manifest.json and styles.css, so the
// PDF.js worker has to be inside main.js. Used by esbuild.config.mjs and the
// test bundlers (test/helpers/bundle-ts.mjs, test/dom-*.mjs).
import { readFile } from "node:fs/promises";

export const inlinePdfWorker = {
  name: "inline-pdf-worker",
  setup(build) {
    build.onLoad({ filter: /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.worker\.min\.mjs$/ }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};
