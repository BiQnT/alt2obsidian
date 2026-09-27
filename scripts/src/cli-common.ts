// Shared helpers for the Node CLIs in scripts/src.

import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

/**
 * Opens a PDF with the pdfjs-dist legacy build (the build the plugin uses).
 * Keeps stdout clean for the CLI's JSON output.
 */
export async function openPdf(pdfPath: string) {
  // Node 18 has no global Web Crypto; 19+ does.
  if (!globalThis.crypto) {
    (globalThis as { crypto: unknown }).crypto = webcrypto;
  }
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
