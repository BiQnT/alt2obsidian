import { AltNoteData, AltNoteMetadata } from "../types";

const RSC_PUSH_REGEX = /self\.__next_f\.push\(\s*(\[[\s\S]*?\])\s*\)/g;
// Alt migrated from Supabase to Cloudflare R2 for slide storage.
// Primary extraction targets the "slides_url" JSON field; this regex is a fallback.
const SLIDES_URL_REGEX =
  /https?:\/\/(?:[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/sign|[a-z0-9-]+\.r2\.cloudflarestorage\.com)\/[^\s"'\\]+/g;
const OG_TITLE_REGEX =
  /<meta\s+property="og:title"\s+content="([^"]*?)"\s*\/?>/i;
const OG_DESC_REGEX =
  /<meta\s+property="og:description"\s+content="([^"]*?)"\s*\/?>/i;

interface ParseResult {
  summary: string | null;
  pdfUrl: string | null;
  transcript: string | null;
  memo: string | null;
  title: string | null;
  createdAt: string | null;
  noteId: string | null;
}

export class RscParser {
  parseRscPayload(html: string): ParseResult {
    // Extract raw chunks from self.__next_f.push() calls
    const rawChunks: string[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(RSC_PUSH_REGEX.source, "g");
    while ((match = regex.exec(html)) !== null) {
      rawChunks.push(match[1]);
    }

    if (rawChunks.length === 0) {
      return this.emptyResult();
    }

    console.log(
      `[Alt2Obsidian] RSC chunks found: ${rawChunks.length}, sizes: [${rawChunks.map((c) => c.length).join(", ")}]`
    );

    // Unescape chunks: each is [chunkType, "escaped_content"]
    // Join both raw and unescaped versions for pattern matching
    const unescapedChunks: string[] = [];
    for (const raw of rawChunks) {
      // Try to extract the string content from [1,"...content..."]
      const innerMatch = raw.match(/^\[\s*\d+\s*,\s*"([\s\S]*)"\s*\]$/);
      if (innerMatch) {
        try {
          const unescaped = JSON.parse(`"${innerMatch[1]}"`);
          unescapedChunks.push(unescaped);
        } catch {
          // Fallback: manual unescape
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

    let summary: string | null = null;
    let pdfUrl: string | null = null;
    let transcript: string | null = null;
    let memo: string | null = null;
    let title: string | null = null;
    let createdAt: string | null = null;
    let noteId: string | null = null;

    // === Extract from UNESCAPED payload ===

    // 1. Extract noteTitle
    const titleMatch = unescapedPayload.match(/"noteTitle"\s*:\s*"([^"]+)"/);
    if (titleMatch) {
      title = titleMatch[1];
    }

    // 2. Extract createdAt
    const createdMatch = unescapedPayload.match(/"createdAt"\s*:\s*"(\d{4}-[^"]+)"/);
    if (createdMatch) {
      createdAt = createdMatch[1];
    }

    // 3. Extract memo content
    const memoMatch = unescapedPayload.match(/"memo"\s*:\s*"((?:[^"\\]|\\.)+)"/);
    if (memoMatch) {
      try {
        memo = JSON.parse(`"${memoMatch[1]}"`);
      } catch {
        memo = memoMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
      }
      // Clean up HTML entities
      if (memo) {
        memo = memo
          .replace(/&amp;#x20;/g, " ")
          .replace(/&#x20;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">");
      }
    }

    // 4. Extract slides PDF URL
    // Primary: read the "slides_url" field from the note data component
    const slidesFieldMatch = unescapedPayload.match(
      /"slides_url"\s*:\s*"([^"]+)"/
    );
    if (slidesFieldMatch) {
      pdfUrl = this.cleanUrl(slidesFieldMatch[1]);
    }

    // Fallback: scan for any Supabase or Cloudflare R2 URL (handles escaped raw payload too)
    if (!pdfUrl) {
      const urlMatches =
        unescapedPayload.match(SLIDES_URL_REGEX) ||
        rawPayload.match(SLIDES_URL_REGEX);
      if (urlMatches) {
        for (const url of urlMatches) {
          const cleaned = this.cleanUrl(url);
          if (cleaned.includes("slides") || cleaned.includes(".pdf")) {
            pdfUrl = cleaned;
            break;
          }
        }
        if (!pdfUrl && urlMatches.length > 0) {
          pdfUrl = this.cleanUrl(urlMatches[0]);
        }
      }
    }

    // 5. Extract summary (markdown with ## headers)
    const markdownCandidates = this.extractLongStrings(unescapedPayload);
    for (const candidate of markdownCandidates) {
      if (
        candidate.length > 200 &&
        (candidate.includes("##") || candidate.includes("**"))
      ) {
        if (!summary || candidate.length > summary.length) {
          summary = candidate;
        }
      }
    }

    // 6. Extract transcript segments from unescaped chunks
    const transcriptSegments: string[] = [];
    for (const chunk of unescapedChunks) {
      // Look for transcript JSON arrays: [{"createdAt":...,"segments":[{"text":"..."}]}]
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
          // Try regex fallback on this chunk
          const textMatches = chunk.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.){5,})"/g);
          for (const tm of textMatches) {
            try {
              const text = JSON.parse(`"${tm[1]}"`);
              if (text.length > 5 && !text.includes("/_next/")) {
                transcriptSegments.push(text.trim());
              }
            } catch {
              // skip
            }
          }
        }
      }
    }

    if (transcriptSegments.length > 0) {
      transcript = transcriptSegments.join(" ");
    }

    // 7. Extract note ID
    const idMatch = unescapedPayload.match(/"token"\s*:\s*"([0-9a-f-]{36})"/);
    if (idMatch) {
      noteId = idMatch[1];
    }

    // Fallback title from summary heading
    if (!title && summary) {
      const headingMatch = summary.match(/^#\s+(.+)$/m);
      if (headingMatch) {
        title = headingMatch[1].trim();
      }
    }

    console.log(
      `[Alt2Obsidian] RSC parse — title: ${!!title}, summary: ${summary?.length ?? 0} chars, ` +
      `memo: ${memo?.length ?? 0} chars, transcript: ${transcriptSegments.length} segments (${transcript?.length ?? 0} chars), pdfUrl: ${!!pdfUrl}`
    );

    return { summary, pdfUrl, transcript, memo, title, createdAt, noteId };
  }

  parseMetaTags(html: string): { title: string | null; summary: string | null } {
    const titleMatch = html.match(OG_TITLE_REGEX);
    const descMatch = html.match(OG_DESC_REGEX);

    return {
      title: titleMatch ? this.decodeHtmlEntities(titleMatch[1]) : null,
      summary: descMatch ? this.decodeHtmlEntities(descMatch[1]) : null,
    };
  }

  detectFormatVersion(html: string): {
    hasRscPush: boolean;
    nextVersion: string | null;
  } {
    const hasRscPush = html.includes("self.__next_f.push");
    const versionMatch = html.match(/\/_next\/static\/([^/]+)\//);
    return {
      hasRscPush,
      nextVersion: versionMatch ? versionMatch[1] : null,
    };
  }

  private extractLongStrings(payload: string): string[] {
    const results: string[] = [];
    const stringRegex = /"((?:[^"\\]|\\.){100,})"/g;
    let match: RegExpExecArray | null;
    while ((match = stringRegex.exec(payload)) !== null) {
      try {
        const decoded = JSON.parse(`"${match[1]}"`);
        // Filter out non-content strings
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

  private emptyResult(): ParseResult {
    return {
      summary: null,
      pdfUrl: null,
      transcript: null,
      memo: null,
      title: null,
      createdAt: null,
      noteId: null,
    };
  }

  private cleanUrl(url: string): string {
    return url.replace(/\\u0026/g, "&").replace(/\\"/g, "").replace(/"+$/, "");
  }

  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
}
