// Skill-side slide hash CLI (spec 4.7). Same hash as the plugin: both use
// src/core/slideHash.ts and the pdfjs-dist legacy build.
//
// Usage: node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>
// Prints {"pages":[{"page":1,"hash":"xxxxxxxx","textChars":123}, ...]}
// where textChars is the length of the normalized page text.
//
// Built by `npm run build:scripts`. pdfjs-dist stays external, so the repo's
// node_modules must be installed.

import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import {
  computeSlideHash,
  extractPageTexts,
  normalizePageText,
} from "../../src/core/slideHash";

async function main(): Promise<void> {
  const [pdfPath, sourceId] = process.argv.slice(2);
  if (!pdfPath || !sourceId) {
    process.stderr.write("Usage: node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>\n");
    process.exit(2);
  }

  // Node 18 has no global Web Crypto; 19+ does.
  if (!globalThis.crypto) {
    (globalThis as { crypto: unknown }).crypto = webcrypto;
  }
  // pdfjs prints warnings with console.log. Keep stdout for the JSON result.
  console.log = (...args: unknown[]) => console.error(...args);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(await readFile(pdfPath));
  const pdf = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  try {
    const texts = await extractPageTexts(pdf);
    const pages = [];
    for (let i = 0; i < texts.length; i++) {
      pages.push({
        page: i + 1,
        hash: await computeSlideHash(texts[i], i + 1, sourceId),
        textChars: normalizePageText(texts[i]).length,
      });
    }
    process.stdout.write(JSON.stringify({ pages }) + "\n");
  } finally {
    await pdf.destroy();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`slide-hashes: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
