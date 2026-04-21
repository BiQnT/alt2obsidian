/**
 * Integration test: Fetch a real Alt page and verify RscParser extraction.
 * Run: node test/test-scraper.mjs
 *
 * Tests both note types:
 *  - Note with LLM summary + slides (SLIDES_URL in Cloudflare R2)
 *  - Transcript-only note (no summary, no slides_url)
 */

// Note with LLM summary AND slides (Cloudflare R2 storage)
const SUMMARY_URL = "https://www.altalt.io/en/note/0a471d1c-4ec6-4101-8de2-ccc1781770d4";
// Transcript-only note (no LLM summary, but has slides_url)
const TRANSCRIPT_URL = "https://altalt.io/note/d4f1a3e9-52aa-435b-88ed-e857fd9e8331";

async function fetchPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Inline the RscParser logic for testing outside Obsidian
function parseRscPayload(html) {
  const RSC_PUSH_REGEX = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
  // Matches both Supabase (legacy) and Cloudflare R2 (current) slide URLs
  const SLIDES_URL_REGEX =
    /https?:\/\/(?:[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/sign|[a-z0-9-]+\.r2\.cloudflarestorage\.com)\/[^\s"'\\]+/g;

  const rawChunks = [];
  let match;
  const regex = new RegExp(RSC_PUSH_REGEX.source, "g");
  while ((match = regex.exec(html)) !== null) {
    rawChunks.push(match[1]);
  }

  console.log(`✓ RSC chunks found: ${rawChunks.length}`);
  console.log(`  Chunk sizes: [${rawChunks.slice(0, 5).map(c => c.length).join(", ")}${rawChunks.length > 5 ? ", ..." : ""}]`);

  // Unescape chunks
  const unescapedChunks = [];
  for (const raw of rawChunks) {
    const innerMatch = raw.match(/^\[\s*\d+\s*,\s*"([\s\S]*)"\s*\]$/);
    if (innerMatch) {
      try {
        unescapedChunks.push(JSON.parse(`"${innerMatch[1]}"`));
      } catch {
        unescapedChunks.push(
          innerMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\")
        );
      }
    } else {
      unescapedChunks.push(raw);
    }
  }

  const rawPayload = rawChunks.join("\n");
  const unescapedPayload = unescapedChunks.join("\n");

  const cleanUrl = (url) => url.replace(/\\u0026/g, "&").replace(/\\"/g, "").replace(/"+$/, "");

  // Extract slides_url field (primary — Cloudflare R2 signed URL)
  let pdfUrl = null;
  const slidesFieldMatch = unescapedPayload.match(/"slides_url"\s*:\s*"([^"]+)"/);
  if (slidesFieldMatch) {
    pdfUrl = cleanUrl(slidesFieldMatch[1]);
  }

  // Fallback: scan for any matching storage URL
  if (!pdfUrl) {
    const urlMatches = unescapedPayload.match(SLIDES_URL_REGEX) || rawPayload.match(SLIDES_URL_REGEX);
    if (urlMatches) {
      for (const url of urlMatches) {
        const cleaned = cleanUrl(url);
        if (cleaned.includes("slides") || cleaned.includes(".pdf")) { pdfUrl = cleaned; break; }
      }
      if (!pdfUrl && urlMatches.length > 0) pdfUrl = cleanUrl(urlMatches[0]);
    }
  }

  // Extract summary: long markdown strings
  const stringRegex = /"((?:[^"\\]|\\.){200,})"/g;
  let summary = null;
  let bestLen = 0;
  while ((match = stringRegex.exec(unescapedPayload)) !== null) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      if ((decoded.includes("##") || decoded.includes("**")) && decoded.length > bestLen) {
        summary = decoded;
        bestLen = decoded.length;
      }
    } catch { /* skip */ }
  }

  // Extract title
  const titleMatch = unescapedPayload.match(/"noteTitle"\s*:\s*"([^"]+)"/);
  const title = titleMatch ? titleMatch[1] : null;

  // Extract createdAt
  const createdMatch = unescapedPayload.match(/"createdAt"\s*:\s*"(\d{4}-[^"]+)"/);
  const createdAt = createdMatch ? createdMatch[1] : null;

  // Extract transcript segments
  const transcriptSegments = [];
  for (const chunk of unescapedChunks) {
    if (chunk.startsWith("[{") && chunk.includes('"segments"') && chunk.includes('"text"')) {
      try {
        const parsed = JSON.parse(chunk);
        if (Array.isArray(parsed)) {
          for (const group of parsed) {
            if (Array.isArray(group.segments)) {
              for (const seg of group.segments) {
                if (seg.text && seg.text.trim().length > 0) transcriptSegments.push(seg.text.trim());
              }
            }
          }
        }
      } catch { /* skip */ }
    }
  }

  return { title, summary, pdfUrl, createdAt, chunkCount: rawChunks.length, transcriptSegments: transcriptSegments.length };
}

function parseMetaTags(html) {
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]*?)"\s*\/?>/i);
  const descMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]*?)"\s*\/?>/i);
  return {
    title: titleMatch ? titleMatch[1] : null,
    description: descMatch ? descMatch[1] : null,
  };
}

async function testNote(url, label) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Testing: ${label}`);
  console.log(`URL: ${url}\n`);

  const html = await fetchPage(url);
  console.log(`✓ Page fetched: ${html.length} bytes\n`);

  console.log("--- RSC Parser ---");
  const rsc = parseRscPayload(html);
  const meta = parseMetaTags(html);

  const effectiveTitle = rsc.title || meta.title?.replace(/\s*\|\s*Alt$/, "");
  console.log(`  Title: ${effectiveTitle || "MISSING ✗"}`);
  console.log(`  Summary: ${rsc.summary ? `${rsc.summary.length} chars` : "none (transcript-only note)"}`);
  console.log(`  Transcript segments: ${rsc.transcriptSegments}`);
  console.log(`  PDF URL (slides): ${rsc.pdfUrl ? `${rsc.pdfUrl.slice(0, 70)}...` : "MISSING ✗"}`);
  console.log(`  CreatedAt: ${rsc.createdAt || "MISSING (optional)"}`);

  const passed = [];
  const failed = [];

  if (effectiveTitle) passed.push(`Title: "${effectiveTitle}"`);
  else failed.push("Title extraction (RSC + OG meta)");

  if (rsc.summary || rsc.transcriptSegments > 0) passed.push("Content (summary or transcript)");
  else failed.push("Content — neither summary nor transcript found");

  if (rsc.pdfUrl && (rsc.pdfUrl.includes("r2.cloudflarestorage.com") || rsc.pdfUrl.includes("supabase.co")))
    passed.push("Slides URL (Cloudflare R2)");
  else failed.push("Slides URL extraction");

  if (meta.title) passed.push("OG meta title fallback");
  else failed.push("OG meta title");

  return { passed, failed, pdfUrl: rsc.pdfUrl };
}

async function main() {
  console.log("=== Alt2Obsidian Scraper Test ===");

  const results = [];
  results.push(await testNote(SUMMARY_URL, "Note with LLM summary + slides"));
  results.push(await testNote(TRANSCRIPT_URL, "Transcript-only note (no summary)"));

  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of results) {
    totalPassed += r.passed.length;
    totalFailed += r.failed.length;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`TOTAL — ✓ ${totalPassed} passed, ✗ ${totalFailed} failed`);

  // Attempt PDF download for the first URL that has a slides URL
  const pdfUrl = results.find(r => r.pdfUrl)?.pdfUrl;
  if (pdfUrl) {
    console.log("\n--- PDF Download Test ---");
    try {
      const pdfRes = await fetch(pdfUrl);
      if (pdfRes.ok) {
        const buf = await pdfRes.arrayBuffer();
        console.log(`✓ PDF downloaded: ${(buf.byteLength / 1024).toFixed(1)} KB`);
        const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
        console.log(magic.startsWith("%PDF") ? "✓ Valid PDF confirmed" : "✗ Not a valid PDF");
      } else {
        console.log(`⚠ PDF download: HTTP ${pdfRes.status} (signed URL may have expired — re-run to get a fresh URL)`);
      }
    } catch (e) {
      console.log(`⚠ PDF download error: ${e.message}`);
    }
  }

  if (totalFailed > 0) {
    for (const r of results) {
      for (const f of r.failed) console.error(`  ✗ ${f}`);
    }
    process.exit(1);
  }

  console.log("\n✓ All scraper tests passed!\n");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
