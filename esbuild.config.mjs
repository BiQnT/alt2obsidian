import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "module";
import { inlinePdfWorker } from "./scripts/inline-pdf-worker.mjs";

const prod = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    // Node built-ins (child_process for the CLI providers) come from
    // Obsidian's desktop runtime.
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
    minify: prod,
    loader: { ".css": "text", ".md": "text" },
    // The bundled PDF.js keeps its license notice inside main.js; this line names it up front.
    banner: { js: "/*! Includes PDF.js (pdfjs-dist 4.10.38), Copyright Mozilla Foundation, Apache-2.0 */" },
    // The PDF.js worker goes into main.js (src/pdf/pdfWorker.ts): a release
    // is main.js, manifest.json and styles.css only.
    plugins: [inlinePdfWorker],
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
