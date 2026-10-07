import { requestUrl } from "obsidian";
import { AltNoteData } from "../types";
import { isAltUrl } from "../utils/helpers";
import { RscParser } from "./RscParser";

export class AltScraper {
  private parser = new RscParser();

  async fetch(url: string): Promise<AltNoteData> {
    if (!isAltUrl(url)) {
      throw new Error("올바른 Alt 노트 URL을 입력해주세요");
    }

    let html: string;
    try {
      const response = await requestUrl({ url });
      html = response.text;
    } catch {
      throw new Error("네트워크 연결을 확인해주세요");
    }

    // Check format version
    const format = this.parser.detectFormatVersion(html);
    if (!format.hasRscPush) {
      console.warn(
        "[Alt2Obs] RSC push format not detected: Alt may have updated their frontend"
      );
    }

    // Try primary RSC parsing
    const rscResult = this.parser.parseRscPayload(html);

    // Supplement RSC result with OG meta tags for missing fields
    const metaResult = this.parser.parseMetaTags(html);
    const ogTitle = metaResult.title
      ? metaResult.title.replace(/\s*\|\s*Alt$/, "").trim()
      : null;

    const noteId = rscResult.noteId || this.extractNoteIdFromUrl(url);
    // Prefer OG title, strip " | Alt" suffix
    const title = ogTitle || rscResult.title || `Alt Note ${noteId}`;

    // Determine best available content: summary > memo > transcript
    const bestSummary = rscResult.summary || rscResult.memo || "";
    const hasContent = bestSummary || rscResult.transcript;

    if (hasContent) {
      return {
        title,
        summary: bestSummary,
        pdfUrl: rscResult.pdfUrl,
        transcript: rscResult.transcript,
        metadata: {
          noteId,
          createdAt: rscResult.createdAt,
          visibility: null,
        },
        parseQuality: "full",
      };
    }

    // Fallback to OG meta tags only
    console.warn(
      "[Alt2Obs] RSC parse incomplete, falling back to OG meta tags"
    );

    if (!metaResult.title && !metaResult.summary) {
      throw new Error(
        "Alt 노트 데이터를 추출할 수 없습니다. 페이지 형식이 변경되었을 수 있습니다."
      );
    }

    return {
      title: metaResult.title || `Alt Note ${noteId}`,
      summary: metaResult.summary || "",
      pdfUrl: null,
      transcript: null,
      metadata: {
        noteId,
        createdAt: null,
        visibility: null,
      },
      parseQuality: "partial",
    };
  }

  private extractNoteIdFromUrl(url: string): string {
    const parts = url.split("/");
    return parts[parts.length - 1] || "unknown";
  }
}
