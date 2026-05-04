#!/usr/bin/env node
// scripts/phase2/alt-scrape.mjs
//
// Pure-Node port of src/scraper/{AltScraper,RscParser}.ts. Designed to be
// invoked from Claude Code's `Bash` tool by the alt2obs Skill, so the SKILL
// can drive a Phase 2 Claude-Code-Max import without depending on the
// Obsidian plugin runtime.
//
// Usage:
//   node alt-scrape.mjs <alt-url>
//
// Output (stdout): single JSON object on one line, e.g.
//   {"title":"8강","summary":"...","pdfUrl":"https://...","transcript":"...",
//    "noteId":"b7472c41-...","createdAt":"2026-05-03T11:15:22Z","parseQuality":"full"}
// Errors go to stderr; exit 1 on failure, 0 on success.

const RSC_PUSH_REGEX = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
const SLIDES_URL_REGEX =
  /https?:\/\/(?:[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/sign|[a-z0-9-]+\.r2\.cloudflarestorage\.com)\/[^\s"'\\]+/g;
const OG_TITLE_REGEX = /<meta\s+property="og:title"\s+content="([^"]*?)"\s*\/?>/i;
const OG_DESC_REGEX = /<meta\s+property="og:description"\s+content="([^"]*?)"\s*\/?>/i;

function isAltUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)altalt\.io$/i.test(u.hostname) && /^\/note\//.test(u.pathname);
  } catch {
    return false;
  }
}

function cleanUrl(url) {
  return url.replace(/\\u0026/g, "&").replace(/\\"/g, "").replace(/"+$/, "");
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractLongStrings(payload) {
  const results = [];
  const stringRegex = /"((?:[^"\\]|\\.){100,})"/g;
  let match;
  while ((match = stringRegex.exec(payload)) !== null) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      if (
        !decoded.includes("/_next/") &&
        !decoded.includes("chunks/") &&
        !decoded.includes(".js?dpl=") &&
        !decoded.includes("$Sreact") &&
        !decoded.includes("I[")
      ) {
        results.push(decoded);
      }
    } catch {
      const manual = match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      if (!manual.includes("/_next/") && !manual.includes("chunks/")) {
        results.push(manual);
      }
    }
  }
  return results.sort((a, b) => b.length - a.length);
}

function parseRscPayload(html) {
  const rawChunks = [];
  let match;
  const regex = new RegExp(RSC_PUSH_REGEX.source, "g");
  while ((match = regex.exec(html)) !== null) {
    rawChunks.push(match[1]);
  }
  if (rawChunks.length === 0) {
    return { summary: null, pdfUrl: null, transcript: null, memo: null, title: null, createdAt: null, noteId: null };
  }

  const unescapedChunks = [];
  for (const raw of rawChunks) {
    const innerMatch = raw.match(/^\[\s*\d+\s*,\s*"([\s\S]*)"\s*\]$/);
    if (innerMatch) {
      try {
        unescapedChunks.push(JSON.parse(`"${innerMatch[1]}"`));
      } catch {
        unescapedChunks.push(
          innerMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\\/g, "\\")
        );
      }
    } else {
      unescapedChunks.push(raw);
    }
  }
  const rawPayload = rawChunks.join("\n");
  const unescapedPayload = unescapedChunks.join("\n");

  let summary = null, pdfUrl = null, transcript = null, memo = null, title = null, createdAt = null, noteId = null;

  const titleMatch = unescapedPayload.match(/"noteTitle"\s*:\s*"([^"]+)"/);
  if (titleMatch) title = titleMatch[1];

  const createdMatch = unescapedPayload.match(/"createdAt"\s*:\s*"(\d{4}-[^"]+)"/);
  if (createdMatch) createdAt = createdMatch[1];

  const memoMatch = unescapedPayload.match(/"memo"\s*:\s*"((?:[^"\\]|\\.)+)"/);
  if (memoMatch) {
    try {
      memo = JSON.parse(`"${memoMatch[1]}"`);
    } catch {
      memo = memoMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    if (memo) {
      memo = memo
        .replace(/&amp;#x20;/g, " ")
        .replace(/&#x20;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
    }
  }

  const slidesFieldMatch = unescapedPayload.match(/"slides_url"\s*:\s*"([^"]+)"/);
  if (slidesFieldMatch) pdfUrl = cleanUrl(slidesFieldMatch[1]);

  if (!pdfUrl) {
    const urlMatches = unescapedPayload.match(SLIDES_URL_REGEX) || rawPayload.match(SLIDES_URL_REGEX);
    if (urlMatches) {
      for (const url of urlMatches) {
        const cleaned = cleanUrl(url);
        if (cleaned.includes("slides") || cleaned.includes(".pdf")) {
          pdfUrl = cleaned;
          break;
        }
      }
      if (!pdfUrl && urlMatches.length > 0) pdfUrl = cleanUrl(urlMatches[0]);
    }
  }

  const markdownCandidates = extractLongStrings(unescapedPayload);
  for (const candidate of markdownCandidates) {
    if (candidate.length > 200 && (candidate.includes("##") || candidate.includes("**"))) {
      if (!summary || candidate.length > summary.length) summary = candidate;
    }
  }

  const transcriptSegments = [];
  for (const chunk of unescapedChunks) {
    if (chunk.startsWith("[{") && chunk.includes('"segments"') && chunk.includes('"text"')) {
      try {
        const parsed = JSON.parse(chunk);
        if (Array.isArray(parsed)) {
          for (const group of parsed) {
            if (Array.isArray(group.segments)) {
              for (const seg of group.segments) {
                if (seg.text && typeof seg.text === "string" && seg.text.trim().length > 0) {
                  transcriptSegments.push(seg.text.trim());
                }
              }
            }
          }
        }
      } catch {
        const textMatches = chunk.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.){5,})"/g);
        for (const tm of textMatches) {
          try {
            const text = JSON.parse(`"${tm[1]}"`);
            if (text.length > 5 && !text.includes("/_next/")) transcriptSegments.push(text.trim());
          } catch {
            // skip
          }
        }
      }
    }
  }
  if (transcriptSegments.length > 0) transcript = transcriptSegments.join(" ");

  const idMatch = unescapedPayload.match(/"token"\s*:\s*"([0-9a-f-]{36})"/);
  if (idMatch) noteId = idMatch[1];

  if (!title && summary) {
    const headingMatch = summary.match(/^#\s+(.+)$/m);
    if (headingMatch) title = headingMatch[1].trim();
  }

  return { summary, pdfUrl, transcript, memo, title, createdAt, noteId };
}

function parseMetaTags(html) {
  const titleMatch = html.match(OG_TITLE_REGEX);
  const descMatch = html.match(OG_DESC_REGEX);
  return {
    title: titleMatch ? decodeHtmlEntities(titleMatch[1]) : null,
    summary: descMatch ? decodeHtmlEntities(descMatch[1]) : null,
  };
}

function extractNoteIdFromUrl(url) {
  const parts = url.split("/");
  return parts[parts.length - 1] || "unknown";
}

async function scrape(url) {
  if (!isAltUrl(url)) {
    throw new Error("Not a valid Alt note URL (expected https://altalt.io/note/<id>)");
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 alt2obs-phase2-skill/0.1" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const html = await response.text();

  const rsc = parseRscPayload(html);
  const meta = parseMetaTags(html);
  const ogTitle = meta.title ? meta.title.replace(/\s*\|\s*Alt$/, "").trim() : null;
  const noteId = rsc.noteId || extractNoteIdFromUrl(url);
  const title = ogTitle || rsc.title || `Alt Note ${noteId}`;
  const bestSummary = rsc.summary || rsc.memo || "";
  const hasContent = bestSummary || rsc.transcript;

  if (hasContent) {
    return {
      title,
      summary: bestSummary,
      pdfUrl: rsc.pdfUrl,
      transcript: rsc.transcript,
      noteId,
      createdAt: rsc.createdAt,
      parseQuality: "full",
    };
  }
  if (!meta.title && !meta.summary) {
    throw new Error("Alt note data could not be extracted (page format may have changed)");
  }
  return {
    title: meta.title || `Alt Note ${noteId}`,
    summary: meta.summary || "",
    pdfUrl: null,
    transcript: null,
    noteId,
    createdAt: null,
    parseQuality: "partial",
  };
}

const url = process.argv[2];
if (!url) {
  process.stderr.write("Usage: node alt-scrape.mjs <alt-url>\n");
  process.exit(2);
}

scrape(url)
  .then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
  })
  .catch((e) => {
    process.stderr.write(`alt-scrape error: ${e.message}\n`);
    process.exit(1);
  });
