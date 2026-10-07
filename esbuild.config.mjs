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
    // The PDF.js worker goes into main.js (src/pdf/pdfWorker.ts): a release
    // is main.js, manifest.json and styles.css only.
    plugins: [inlinePdfWorker],
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
