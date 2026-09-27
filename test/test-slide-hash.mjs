/**
 * Test: slide-hashes CLI follows the spec 4.7 hash rule and is deterministic,
 * and the committed scripts/phase2/*.mjs match a fresh build of scripts/src.
 * Run: node test/test-slide-hash.mjs [pdfPath]
 *
 * Uses the committed fixture test/fixtures/text-deck.pdf. A real deck (the
 * given path, or the first PDF in Alt's local storage) is checked as well
 * when available.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";
import { optionalRealDeck } from "./helpers/decks.mjs";
import { FIXTURE_PAGES, FIXTURE_PATH } from "./helpers/synthetic-pdf.mjs";

const cli = join(repo, "scripts/phase2/slide-hashes.mjs");
const sha1_8 = (s) => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 8);
const normalize = (t) => t.normalize("NFC").toLowerCase().replace(/\s+/g, "");

function run(pdf, sourceId) {
  const stdout = execFileSync("node", [cli, pdf, sourceId], { encoding: "utf8" });
  return { raw: stdout, pages: JSON.parse(stdout).pages };
}

// Committed CLI bundles must equal a fresh `build:scripts` output.
{
  const dir = mkdtempSync(join(tmpdir(), "slide-hash-build-"));
  try {
    execFileSync("node", [join(repo, "scripts/build-scripts.mjs"), dir], { cwd: repo, stdio: "ignore" });
    const built = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
    const committed = readdirSync(join(repo, "scripts/phase2")).filter((f) => f.endsWith(".mjs") && f !== "alt-scrape.mjs").sort();
    assert.deepEqual(committed, built, "scripts/phase2 has exactly the built CLIs");
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

// Fixture: exact expected hashes, including duplicate text and an image-only page.
{
  const a = run(FIXTURE_PATH, "source-a");
  assert.equal(run(FIXTURE_PATH, "source-a").raw, a.raw, "two runs must produce identical output");
  const expected = FIXTURE_PAGES.map((text, i) =>
    text === null
      ? { page: i + 1, hash: sha1_8(`source-a:${i + 1}`), textChars: 0 }
      : { page: i + 1, hash: sha1_8(normalize(text)), textChars: normalize(text).length }
  );
  assert.deepEqual(a.pages, expected);
  assert.equal(a.pages[1].hash, a.pages[2].hash, "identical text shares a hash");
  const b = run(FIXTURE_PATH, "source-b").pages;
  a.pages.forEach((p, i) => {
    if (p.textChars > 0) assert.equal(b[i].hash, p.hash, `page ${i + 1} must not depend on sourceId`);
    else assert.notEqual(b[i].hash, p.hash, `image-only page ${i + 1} must depend on sourceId`);
  });
  console.log(`PASS: fixture deck, exact hashes (text, duplicate text, image-only): ${JSON.stringify(a.pages)}`);
}

// Optional real deck: determinism and independent recomputation.
const deck = optionalRealDeck();
if (!deck) {
  console.log("INFO: no real deck available, fixture only");
} else {
  try {
    const a = run(deck.pdf, "source-a");
    assert.equal(run(deck.pdf, "source-a").raw, a.raw, "two runs must produce identical output");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(deck.pdf)), verbosity: 0 }).promise;
    assert.equal(doc.numPages, a.pages.length);
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      const norm = normalize(content.items.map((it) => it.str ?? "").join(""));
      assert.equal(a.pages[i - 1].textChars, norm.length, `page ${i} textChars`);
      assert.equal(a.pages[i - 1].hash, sha1_8(norm.length > 0 ? norm : `source-a:${i}`), `page ${i} hash`);
    }
    await doc.destroy();
    console.log(`PASS: ${deck.label}, ${a.pages.length} pages, deterministic, hashes recomputed independently`);
  } finally {
    deck.cleanup();
  }
}
