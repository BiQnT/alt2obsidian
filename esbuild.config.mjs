import esbuild from "esbuild";
import { copy } from "esbuild-plugin-copy";
import process from "process";
import { builtinModules } from "module";

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
    plugins: [
      copy({
        resolveFrom: "cwd",
        assets: [
          {
            from: ["node_modules/pdfjs-dist/build/pdf.worker.min.mjs"],
            to: ["."],
          },
        ],
      }),
    ],
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
