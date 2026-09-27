// Writes a minimal PDF whose pages each have one line of Helvetica text, or
// only a filled rectangle (no text layer) for a null entry.
// Regenerate the committed fixture: node test/helpers/synthetic-pdf.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_PAGES = [
  "Alpha  Introduction to Caches",
  "Beta  Cache Coherence (MESI)",
  "Beta  Cache Coherence (MESI)",
  null,
  "Gamma  Summary and Questions",
];

export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/text-deck.pdf");

export function writeSyntheticPdf(path, pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    null, // page tree, filled below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const kids = [];
  for (const text of pages) {
    const stream =
      text === null
        ? "0.2 0.4 0.8 rg 100 300 400 300 re f"
        : `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contentRef = objects.length;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentRef} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;

  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(path, body, "latin1");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeSyntheticPdf(FIXTURE_PATH, FIXTURE_PAGES);
  console.log(`wrote ${FIXTURE_PATH}`);
}
