/**
 * Test: memo/transcript-only Alt note
 * Run: node test/test-memo-note.mjs
 */

const TEST_URL = "https://www.altalt.io/en/note/d610372c-9850-4a1f-8498-01d5ff3231cd";

async function main() {
  console.log("=== Memo/Transcript Note Test ===\n");
  const res = await fetch(TEST_URL);
  const html = await res.text();
  console.log(`Page: ${html.length} bytes\n`);

  // RSC chunks
  const chunks = [];
  const regex = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
  let m;
  while ((m = regex.exec(html)) !== null) chunks.push(m[1]);
  console.log(`RSC chunks: ${chunks.length}`);

  const fullPayload = chunks.join("\n");

  // Unescape chunks
  const unescaped = [];
  for (const raw of chunks) {
    const inner = raw.match(/^\[\s*\d+\s*,\s*"([\s\S]*)"\s*\]$/);
    if (inner) {
      try { unescaped.push(JSON.parse(`"${inner[1]}"`)); }
      catch { unescaped.push(inner[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")); }
    } else {
      unescaped.push(raw);
    }
  }
  const payload = unescaped.join("\n");

  // noteTitle
  const titleMatch = payload.match(/"noteTitle"\s*:\s*"([^"]+)"/);
  console.log(`noteTitle: ${titleMatch ? titleMatch[1] : "NONE"}`);

  // Memo
  const memoMatch = payload.match(/"memo"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  let memo = null;
  if (memoMatch) {
    try { memo = JSON.parse(`"${memoMatch[1]}"`); } catch { memo = memoMatch[1]; }
    memo = memo.replace(/&#x20;/g, " ").replace(/&amp;#x20;/g, " ");
  }
  console.log(`Memo: ${memo ? memo.length + " chars" : "NONE"}`);
  if (memo) console.log(`  Preview: "${memo.slice(0, 200)}"`);

  // Transcript from JSON array chunks
  const transcriptSegments = [];
  for (const chunk of unescaped) {
    if (chunk.startsWith("[{") && chunk.includes('"segments"') && chunk.includes('"text"')) {
      try {
        const parsed = JSON.parse(chunk);
        for (const group of parsed) {
          if (Array.isArray(group.segments)) {
            for (const seg of group.segments) {
              if (seg.text && seg.text.trim().length > 0) transcriptSegments.push(seg.text.trim());
            }
          }
        }
      } catch (e) { console.log("  JSON parse failed:", e.message); }
    }
  }
  console.log(`Transcript segments: ${transcriptSegments.length}`);
  if (transcriptSegments.length > 0) {
    const total = transcriptSegments.join(" ").length;
    console.log(`Transcript total: ${total} chars`);
    console.log(`First 3:`);
    for (const s of transcriptSegments.slice(0, 3)) {
      console.log(`  "${s.slice(0, 100)}"`);
    }
  }

  // PDF
  const pdfMatch = payload.match(/https?:\/\/[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/sign\/[^\s"']+/);
  console.log(`\nPDF URL: ${pdfMatch ? "FOUND" : "NONE"}`);

  // Verdict
  console.log("\n=== Verdict ===");
  const hasContent = memo || transcriptSegments.length > 0;
  if (memo) console.log("✓ Memo available");
  if (transcriptSegments.length > 0) console.log("✓ Transcript available: LLM can summarize");
  if (pdfMatch) console.log("✓ PDF slides available");
  if (!hasContent) console.log("✗ No usable content found");
}

main().catch(e => { console.error(e); process.exit(1); });
