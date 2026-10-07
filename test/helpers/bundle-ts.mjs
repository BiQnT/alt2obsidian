// Bundles a TypeScript module from src/ for Node tests, with "obsidian"
// replaced by a small stub, and imports it.

import esbuild from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inlinePdfWorker } from "../../scripts/inline-pdf-worker.mjs";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");

const OBSIDIAN_STUB = `
export const notices = [];
export class Notice { constructor(message) { notices.push(message); } }
export class TFolder {}
export class TFile {}
export class Plugin {}
export class Modal { constructor(app) { this.app = app; } }
export class FuzzySuggestModal extends Modal { setPlaceholder() {} }
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class Component {}
export const MarkdownRenderer = { render: async () => {} };
export const setIcon = () => {};
export const editorLivePreviewField = null;
export const normalizePath = (p) => p;
export const requestUrl = () => { throw new Error("requestUrl is not available in tests"); };
`;

export async function importTs(entry) {
  const result = await esbuild.build({
    entryPoints: [join(repo, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    loader: { ".md": "text", ".css": "text" },
    logLevel: "error",
    plugins: [
      inlinePdfWorker,
      {
        name: "obsidian-stub",
        setup(b) {
          b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: OBSIDIAN_STUB, loader: "js" }));
        },
      },
    ],
  });
  const dir = mkdtempSync(join(tmpdir(), "alt2obs-test-"));
  const file = join(dir, "bundle.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
