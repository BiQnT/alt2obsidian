/**
 * Test: slide-hashes CLI is deterministic and follows the spec 4.7 hash rule,
 * and the committed scripts/phase2/*.mjs match a fresh build of scripts/src.
 * Run: node test/test-slide-hash.mjs [pdfPath]
 *
 * Without an argument, the first PDF in Alt's local slide storage is copied
 * to a temp dir (the storage folder is never modified) and used.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { importTs } from "./helpers/bundle-ts.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "scripts/phase2/slide-hashes.mjs");
const ALT_SLIDES = join(homedir(), "Library/Application Support/alt/data/storage/slides");

function resolvePdf() {
  if (process.argv[2]) return { pdf: process.argv[2], cleanup: () => {} };
  let name;
  try {
    name = readdirSync(ALT_SLIDES).find((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    // handled below
  }
  if (!name) {
    console.error(`No PDF given and none found in ${ALT_SLIDES}. Pass a PDF path.`);
    process.exit(1);
  }
  const dir = mkdtempSync(join(tmpdir(), "slide-hash-test-"));
  const pdf = join(dir, "deck.pdf");
  copyFileSync(join(ALT_SLIDES, name), pdf);
  return { pdf, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(pdf, sourceId) {
  const stdout = execFileSync("node", [cli, pdf, sourceId], { encoding: "utf8" });
  return { raw: stdout, json: JSON.parse(stdout) };
}

// Committed CLI bundles must equal a fresh `build:scripts` output.
{
  const dir = mkdtempSync(join(tmpdir(), "slide-hash-build-"));
  try {
    execFileSync("node", [join(repo, "scripts/build-scripts.mjs"), dir], { cwd: repo, stdio: "ignore" });
    const built = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    assert.ok(built.length > 0);
    for (const f of built) {
      assert.equal(
        readFileSync(join(repo, "scripts/phase2", f), "utf8"),
        readFileSync(join(dir, f), "utf8"),
        `scripts/phase2/${f} is stale: run npm run build:scripts`
      );
    }
    console.log(`PASS: committed CLI bundles are fresh (${built.join(", ")})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sha1_8 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 8);

// Independent text extraction (same pdfjs build as the CLI) to recompute hashes.
async function pageTexts(pdf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf)), verbosity: 0 }).promise;
  const texts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    texts.push(content.items.map((it) => it.str ?? "").join(""));
  }
  await doc.destroy();
  return texts;
}

// A page whose text layer throws yields null and gets the positional hash.
{
  const { extractPageTexts, computeSlideHash } = await importTs("src/core/slideHash.ts");
  const fakePdf = {
    numPages: 2,
    getPage: async (n) => ({
      getTextContent: async () => {
        if (n === 2) throw new Error("broken page");
        return { items: [{ str: "Hello " }, {}, { str: "World" }] };
      },
    }),
  };
  const warn = console.warn;
  console.warn = () => {};
  const texts = await extractPageTexts(fakePdf);
  console.warn = warn;
  assert.deepEqual(texts, ["Hello World", null]);
  assert.equal(await computeSlideHash(texts[0], 1, "s"), sha1_8("helloworld"));
  assert.equal(await computeSlideHash(texts[1], 2, "s"), sha1_8("s:2"));
  console.log("PASS: unreadable page yields null and the positional fallback hash");
}

// Two-page PDF: page 1 has the text "Hello  World", page 2 has no text layer.
function writeSyntheticPdf(path) {
  const stream = "BT /F1 24 Tf 72 700 Td (Hello  World) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
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

{
  const dir = mkdtempSync(join(tmpdir(), "slide-hash-synth-"));
  try {
    const synth = join(dir, "synthetic.pdf");
    writeSyntheticPdf(synth);
    const pages = run(synth, "source-a").json.pages;
    assert.deepEqual(pages, [
      { page: 1, hash: sha1_8("helloworld"), textChars: 10 },
      { page: 2, hash: sha1_8("source-a:2"), textChars: 0 },
    ]);
    console.log(`PASS: synthetic PDF, text page and image-only fallback page: ${JSON.stringify(pages)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { pdf, cleanup } = resolvePdf();
try {
  const a = run(pdf, "source-a");
  const b = run(pdf, "source-a");
  assert.equal(a.raw, b.raw, "two runs must produce identical output");

  const pages = a.json.pages;
  assert.ok(Array.isArray(pages) && pages.length > 0, "pages must be a non-empty array");
  pages.forEach((p, i) => {
    assert.equal(p.page, i + 1);
    assert.match(p.hash, /^[0-9a-f]{8}$/);
    assert.equal(typeof p.textChars, "number");
  });

  const texts = await pageTexts(pdf);
  assert.equal(texts.length, pages.length);
  texts.forEach((t, i) => {
    const norm = t.normalize("NFC").toLowerCase().replace(/\s+/g, "");
    assert.equal(pages[i].textChars, norm.length, `page ${i + 1} textChars`);
    const expected = sha1_8(norm.length > 0 ? norm : `source-a:${i + 1}`);
    assert.equal(pages[i].hash, expected, `page ${i + 1} hash`);
  });

  // sourceId only affects pages without text.
  const c = run(pdf, "source-b").json.pages;
  pages.forEach((p, i) => {
    if (p.textChars > 0) assert.equal(c[i].hash, p.hash, `page ${i + 1} must not depend on sourceId`);
    else assert.notEqual(c[i].hash, p.hash, `image-only page ${i + 1} must depend on sourceId`);
  });

  const textPages = pages.filter((p) => p.textChars > 0).length;
  console.log(`PASS: ${pages.length} pages (${textPages} with text), deterministic across runs, hashes match spec 4.7.`);
  console.log(`first pages: ${JSON.stringify(pages.slice(0, 3))}`);
} finally {
  cleanup();
}
