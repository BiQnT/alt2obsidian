#!/usr/bin/env node
// Headless import benchmark (spec 5.6). Bundles scripts/bench/bench-core.ts
// with esbuild (dev dependency) and runs it. See scripts/bench/README.md.
//
//   node scripts/bench/bench.mjs --pdf deck.pdf --provider claude-cli \
//     [--transcript t.txt] [--summary s.md] [--title T] [--subject S] \
//     [--model M] [--effort low|medium|high|xhigh|max] \
//     [--concept-model haiku] [--concept-effort low] [--batch 8] [--cap 600] \
//     [--image-rule auto|text-only] [--fewer-images] [--bin /path/to/cli] \
//     [--api-key KEY] [--timeout 300] [--out note.md] [--json] [--dry-run]

import esbuild from "esbuild";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

// GeminiProvider imports requestUrl from obsidian; give it fetch.
const OBSIDIAN_STUB = `
export class Notice { constructor(m) { console.error(m); } }
export class TFile {}
export class TFolder {}
export const normalizePath = (p) => p;
export async function requestUrl({ url, method = "GET", headers, body }) {
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (res.status >= 400) throw new Error("Request failed, status " + res.status + ": " + text.slice(0, 300));
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, arrayBuffer: new TextEncoder().encode(text).buffer };
}
`;

function parseArgs(argv) {
  const flags = new Set(["--json", "--dry-run", "--fewer-images", "--help"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (flags.has(a)) out[a.slice(2)] = true;
    else {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.pdf) {
  process.stderr.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n") + "\n");
  process.exit(args.help ? 0 : 2);
}
const provider = args.provider ?? "claude-cli";
if (!["claude-cli", "codex-cli", "gemini"].includes(provider)) throw new Error(`unknown provider ${provider}`);
const read = (f) => (f ? readFileSync(f, "utf8") : null);
if (!existsSync(args.pdf)) throw new Error(`no such PDF: ${args.pdf}`);

const options = {
  pdf: resolve(args.pdf),
  transcript: read(args.transcript),
  summary: read(args.summary) ?? "",
  title: args.title ?? basename(args.pdf, ".pdf"),
  subject: args.subject ?? "BENCH",
  provider,
  model: args.model ?? "",
  effort: args.effort ?? (provider === "gemini" ? "" : "medium"),
  conceptModel: args["concept-model"] ?? (provider === "claude-cli" ? "haiku" : args.model ?? ""),
  conceptEffort: args["concept-effort"] ?? (provider === "gemini" ? "" : "low"),
  batchSize: parseInt(args.batch ?? "8", 10),
  capChars: parseInt(args.cap ?? "600", 10),
  imageRule: args["image-rule"] === "text-only" ? "text-only" : "auto",
  fewerImages: !!args["fewer-images"],
  bin: args.bin ? resolve(args.bin) : "",
  apiKey: args["api-key"] ?? process.env.GEMINI_API_KEY ?? "",
  timeoutSec: parseInt(args.timeout ?? "300", 10),
  out: args.out ? resolve(args.out) : null,
  dryRun: !!args["dry-run"],
};

const built = await esbuild.build({
  entryPoints: [join(here, "bench-core.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  write: false,
  external: ["pdfjs-dist"],
  loader: { ".md": "text" },
  logLevel: "error",
  plugins: [
    {
      name: "obsidian-stub",
      setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: OBSIDIAN_STUB, loader: "js" }));
      },
    },
  ],
});
// Inside the repo so the bundle resolves pdfjs-dist from node_modules.
const dir = mkdtempSync(join(repo, "node_modules", ".alt2obs-bench-"));
const file = join(dir, "bench.mjs");
writeFileSync(file, built.outputFiles[0].text);
try {
  const { runBench, formatTable } = await import(pathToFileURL(file).href);
  // pdfjs warns on stdout; keep stdout for the result.
  const log = console.log;
  console.log = (...a) => console.error(...a);
  const result = await runBench(options);
  console.log = log;
  process.stdout.write((args.json ? JSON.stringify(result, null, 2) : formatTable(result)) + "\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
