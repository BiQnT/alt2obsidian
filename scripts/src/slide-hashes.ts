// Skill-side slide hash CLI (spec 4.7). Same hash as the plugin: both use
// src/core/slideHash.ts and the pdfjs-dist legacy build.
//
// Usage: node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>
// Prints {"pages":[{"page":1,"hash":"xxxxxxxx","textChars":123}, ...]}
// where textChars is the length of the normalized page text (0 for an
// image-only page or one whose text could not be read).
//
// Built by `npm run build:scripts`. pdfjs-dist stays external, so the repo's
// node_modules must be installed.

import {
  computeSlideHash,
  extractPageTexts,
  normalizePageText,
} from "../../src/core/slideHash";
import { fail, openPdf } from "./cli-common";

async function main(): Promise<void> {
  const [pdfPath, sourceId] = process.argv.slice(2);
  if (!pdfPath || !sourceId) {
    process.stderr.write("Usage: node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>\n");
    process.exit(2);
  }

  const pdf = await openPdf(pdfPath);
  try {
    const texts = await extractPageTexts(pdf);
    const pages = [];
    for (let i = 0; i < texts.length; i++) {
      pages.push({
        page: i + 1,
        hash: await computeSlideHash(texts[i], i + 1, sourceId),
        textChars: normalizePageText(texts[i] ?? "").length,
      });
    }
    process.stdout.write(JSON.stringify({ pages }) + "\n");
  } finally {
    await pdf.destroy();
  }
}

main().catch((e: unknown) => fail(e, "slide-hashes"));
