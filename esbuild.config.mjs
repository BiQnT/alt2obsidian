import esbuild from "esbuild";
import { copy } from "esbuild-plugin-copy";
import process from "process";

const prod = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
    minify: prod,
    loader: { ".css": "text" },
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
