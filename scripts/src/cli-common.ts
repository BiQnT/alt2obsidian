// Shared helpers for the Node CLIs in scripts/src.

import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

/** Node 18 has no global Web Crypto (the slide and section hashes use it); 19+ does. */
export function ensureWebCrypto(): void {
  if (!globalThis.crypto) {
    (globalThis as { crypto: unknown }).crypto = webcrypto;
  }
}

/**
 * Opens a PDF with the pdfjs-dist legacy build (the build the plugin uses).
 * Keeps stdout clean for the CLI's JSON output.
 */
export async function openPdf(pdfPath: string) {
  ensureWebCrypto();
  // pdfjs prints warnings with console.log. Keep stdout for the result.
  console.log = (...args: unknown[]) => console.error(...args);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(await readFile(pdfPath));
  return pdfjs.getDocument({ data, verbosity: 0 }).promise;
}

export function fail(e: unknown, name: string): never {
  process.stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

/**
 * `key: value` lines of a note's frontmatter (JSON string values decoded),
 * or null when the file does not exist or has no frontmatter block.
 */
export function readFrontmatter(file: string | undefined): Record<string, unknown> | null {
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const block = text.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  const fm: Record<string, unknown> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v: unknown = m[2].trim();
    if (typeof v === "string" && v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        // keep the raw text
      }
    }
    fm[m[1]] = v;
  }
  return fm;
}
