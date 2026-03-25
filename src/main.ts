import { Plugin } from "obsidian";
import {
  PluginData,
  DEFAULT_PLUGIN_DATA,
  ImportRecord,
  ImportPreview,
  LLMProvider as ILLMProvider,
} from "./types";
import { AltScraper } from "./scraper/AltScraper";
import { PdfProcessor } from "./pdf/PdfProcessor";
import { createProvider } from "./llm/index";
import { ConceptExtractor } from "./generator/ConceptExtractor";
import { NoteGenerator } from "./generator/NoteGenerator";
import { ExamSummaryGenerator } from "./generator/ExamSummaryGenerator";
import { VaultManager } from "./vault/VaultManager";
import { Alt2ObsidianSettingsTab } from "./ui/SettingsTab";
import {
  Alt2ObsidianSidebarView,
  VIEW_TYPE_SIDEBAR,
} from "./ui/SidebarView";
import { sanitizeFilename, formatDate } from "./utils/helpers";

export default class Alt2ObsidianPlugin extends Plugin {
  data: PluginData = DEFAULT_PLUGIN_DATA;
  vaultManager: VaultManager | null = null;

  private scraper = new AltScraper();
  private pdfProcessor: PdfProcessor | null = null;

  async onload(): Promise<void> {
    await this.loadPluginData();

    // Initialize vault manager
    this.vaultManager = new VaultManager(
      this.app,
      this.data.settings.baseFolderPath
    );

    // Initialize PDF processor with worker path
    const vaultBasePath =
      (this.app.vault.adapter as any).getBasePath?.() || "";
    this.pdfProcessor = new PdfProcessor(this.manifest.dir || "", vaultBasePath);

    // Register sidebar view
    this.registerView(VIEW_TYPE_SIDEBAR, (leaf) => {
      return new Alt2ObsidianSidebarView(leaf, this);
    });

    // Add ribbon icon
    this.addRibbonIcon("book-open", "Alt2Obsidian", () => {
      this.activateSidebarView();
    });

    // Add command
    this.addCommand({
      id: "open-sidebar",
      name: "Open Alt2Obsidian sidebar",
      callback: () => this.activateSidebarView(),
    });

    this.addCommand({
      id: "import-note",
      name: "Import Alt note from URL",
      callback: () => this.activateSidebarView(),
    });

    // Register settings tab
    this.addSettingTab(new Alt2ObsidianSettingsTab(this.app, this));
  }

  onunload(): void {
    // Views are automatically cleaned up by Obsidian
  }

  updateBasePath(): void {
    this.vaultManager?.setBasePath(this.data.settings.baseFolderPath);
  }

  /**
   * Phase 1: Preview — scrape page, download PDF, render thumbnails.
   * Returns preview data for the user to select slides before import.
   */
  async previewImport(
    url: string,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<ImportPreview> {
    onProgress?.("Alt 노트 페이지 가져오는 중...", 10);
    const altData = await this.scraper.fetch(url);
    onProgress?.("Alt 노트 파싱 완료", 30);

    let pdfData: ArrayBuffer | null = null;
    const slideThumbnails: string[] = [];

    if (altData.pdfUrl && this.pdfProcessor) {
      onProgress?.("PDF 다운로드 중...", 40);
      try {
        pdfData = await this.pdfProcessor.downloadPdf(altData.pdfUrl);
        onProgress?.("슬라이드 미리보기 생성 중...", 55);

        this.pdfProcessor.initWorker();
        const thumbs = await this.pdfProcessor.renderThumbnails(pdfData, (p, t) => {
          onProgress?.(`미리보기 생성 (${p}/${t})...`, 55 + Math.floor((p / t) * 40));
        });
        slideThumbnails.push(...thumbs);
      } catch (e) {
        console.warn("[Alt2Obsidian] PDF preview failed:", e);
      }
    }

    // Quick subject detection from title
    const codeMatch = altData.title.match(/([A-Z]{2,}[\s-]?\d{2,})/i);
    const suggestedSubject = codeMatch
      ? codeMatch[1].replace(/\s+/g, "").toUpperCase()
      : altData.title.split(/[\s-_]/)[0];

    onProgress?.("미리보기 준비 완료", 100);

    return {
      altData,
      pdfData,
      slideThumbnails,
      suggestedSubject,
      slideCount: slideThumbnails.length,
    };
  }

  /**
   * Phase 2: Import — process with LLM and save to vault.
   * Takes preview data + user's slide selection.
   */
  async importNote(
    url: string,
    preview: ImportPreview,
    selectedSlides: number[], // 0-based indices of selected slides
    subjectOverride?: string,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<ImportRecord> {
    const settings = this.data.settings;
    if (!settings.apiKey) {
      throw new Error("API 키를 설정에서 입력해주세요");
    }

    const llm = createProvider(
      settings.provider,
      settings.apiKey,
      settings.geminiModel,
      settings.rateDelayMs
    );

    const altData = preview.altData;

    // For partial quality, skip LLM processing
    if (altData.parseQuality === "partial") {
      const subject = subjectOverride || "Unknown";
      return this.savePartialNote(altData, subject, url, llm, onProgress);
    }

    // Enhance summary with transcript if available
    if (altData.transcript) {
      const transcriptText = altData.transcript.slice(0, 15000);
      const summaryTooShort = !altData.summary || altData.summary.length < 500;

      if (summaryTooShort) {
        onProgress?.("트랜스크립트에서 강의 노트 생성 중...", 10);
        const memoContext = altData.summary
          ? `\n\n[학생 메모]\n${altData.summary}`
          : "";

        altData.summary = await llm.generateText(
          `다음은 강의 트랜스크립트입니다. 이 내용을 구조화된 강의 노트로 정리해주세요.

규칙:
- 마크다운 형식으로, ## 섹션 헤더를 사용
- 핵심 개념을 **볼드**로 표시
- 한국어로 작성하되, 전문 용어는 영어 병기 (예: **파이프라인 해저드(Pipeline Hazard)**)
- 각 섹션에 핵심 포인트를 불릿 리스트로 정리
- 수식이나 예시가 있으면 포함
${memoContext}

트랜스크립트:
${transcriptText}`,
          {
            systemPrompt: "You are an academic note-taking assistant. Create well-structured, comprehensive lecture notes in Korean with markdown formatting.",
            maxOutputTokens: 4096,
          }
        );
      } else {
        onProgress?.("트랜스크립트로 요약 보강 중...", 10);

        altData.summary = await llm.generateText(
          `다음은 강의 요약본과 실제 강의 트랜스크립트입니다.
요약본을 기반으로 하되, 트랜스크립트에서 빠진 부연설명, 예시, 세부 내용을 추가하여 더 풍부한 강의 노트를 만들어주세요.

규칙:
- 기존 요약본의 구조와 핵심 내용을 유지
- 트랜스크립트에서 추가 설명, 예시, 교수 코멘트 등을 보강
- 마크다운 형식, ## 섹션 헤더 사용
- 핵심 개념을 **볼드**로, 전문 용어는 영어 병기
- 트랜스크립트에만 있는 중요 내용은 새 섹션이나 불릿으로 추가

[기존 요약본]
${altData.summary}

[강의 트랜스크립트]
${transcriptText}`,
          {
            systemPrompt: "You are an academic note-taking assistant. Enhance lecture summaries with additional details from transcripts.",
            maxOutputTokens: 8192,
          }
        );
      }
    }

    onProgress?.("LLM으로 개념 추출 중...", 30);

    // LLM: Extract concepts + detect subject
    const conceptExtractor = new ConceptExtractor(llm);
    const subject = subjectOverride || preview.suggestedSubject;

    const conceptResult = await conceptExtractor.extract(
      altData.summary,
      subject
    );

    onProgress?.("개념 추출 완료", 50);

    // Render only SELECTED slides to full images
    let images: import("./types").SlideImage[] = [];
    if (preview.pdfData && this.pdfProcessor && selectedSlides.length > 0) {
      onProgress?.("선택된 슬라이드 변환 중...", 55);
      const titleSlug = sanitizeFilename(altData.title)
        .replace(/\s+/g, "_")
        .toLowerCase();

      try {
        images = await this.pdfProcessor.renderSelectedPages(
          preview.pdfData,
          selectedSlides,
          titleSlug,
          (page, total) => {
            const pct = 55 + Math.floor((page / total) * 20);
            onProgress?.(`슬라이드 변환 (${page}/${total})...`, pct);
          }
        );
      } catch (e) {
        console.warn("[Alt2Obsidian] PDF rendering failed:", e);
      }
    }

    onProgress?.("이미지 배치 결정 중...", 75);

    // Get image placements from LLM
    const noteGenerator = new NoteGenerator(llm);
    const imagePlacements =
      images.length > 0
        ? await noteGenerator
            .getImagePlacements(altData.summary, images.length)
            .catch(() => [])
        : [];

    // Generate markdown
    onProgress?.("마크다운 노트 생성 중...", 80);

    const llmResult = {
      processedSummary: altData.summary,
      concepts: conceptResult.concepts,
      tags: conceptResult.tags,
      subjectSuggestion: subject,
      imagePlacements,
    };

    const { lectureMarkdown, conceptNotes } = await noteGenerator.generate(
      altData,
      images,
      llmResult,
      subject
    );

    // Save everything to vault
    onProgress?.("Vault에 저장 중...", 90);

    const vm = this.vaultManager!;
    const subjectFolder = `${vm.getBasePath()}/${sanitizeFilename(subject)}`;
    const assetsFolder = `${subjectFolder}/assets`;

    for (const img of images) {
      await vm.saveImage(img, assetsFolder);
    }

    const noteFilename = sanitizeFilename(altData.title);
    const notePath = `${subjectFolder}/${noteFilename}.md`;
    await vm.saveNote(lectureMarkdown, notePath);
    await vm.saveConceptNotes(conceptNotes, noteFilename, subject);

    onProgress?.("완료!", 100);

    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "full",
    };
    this.data.recentImports.unshift(record);
    if (this.data.recentImports.length > 50) {
      this.data.recentImports = this.data.recentImports.slice(0, 50);
    }
    await this.savePluginData();

    return record;
  }

  async generateExamSummary(subject: string): Promise<string> {
    const settings = this.data.settings;
    if (!settings.apiKey) {
      throw new Error("API 키를 설정에서 입력해주세요");
    }

    const llm = createProvider(
      settings.provider,
      settings.apiKey,
      settings.geminiModel,
      settings.rateDelayMs
    );

    const generator = new ExamSummaryGenerator(llm, this.vaultManager!);
    return generator.generate(subject);
  }

  private async savePartialNote(
    altData: import("./types").AltNoteData,
    subject: string,
    url: string,
    llm: ILLMProvider,
    onProgress?: (stage: string, percent: number) => void
  ): Promise<ImportRecord> {
    onProgress?.("부분 노트 생성 중...", 50);

    const noteGenerator = new NoteGenerator(llm);
    const { lectureMarkdown } = await noteGenerator.generate(
      altData,
      [],
      {
        processedSummary: altData.summary,
        concepts: [],
        tags: [],
        subjectSuggestion: subject,
        imagePlacements: [],
      },
      subject
    );

    const vm = this.vaultManager!;
    const subjectFolder = `${vm.getBasePath()}/${sanitizeFilename(subject)}`;
    const noteFilename = sanitizeFilename(altData.title);
    const notePath = `${subjectFolder}/${noteFilename}.md`;

    await vm.saveNote(lectureMarkdown, notePath);
    onProgress?.("완료!", 100);

    const record: ImportRecord = {
      url,
      title: altData.title,
      subject,
      path: notePath,
      date: formatDate(),
      parseQuality: "partial",
    };
    this.data.recentImports.unshift(record);
    await this.savePluginData();

    return record;
  }

  private async detectSubject(
    llm: ILLMProvider,
    title: string,
    _summary: string
  ): Promise<string> {
    // First try regex extraction from title (most reliable)
    const codeMatch = title.match(/([A-Z]{2,}[\s-]?\d{2,})/i);
    if (codeMatch) {
      return codeMatch[1].replace(/\s+/g, "").toUpperCase();
    }

    // Fallback to LLM only if no code found
    try {
      const prompt = `Lecture title: "${title}"

Extract the course code (like "CSED311", "MATH230", "CS101") from this title.
If there is no course code, return the first meaningful word or abbreviation from the title.
Rules:
- Return ONLY the course code or short name (1-10 characters)
- No explanation, no quotes, no extra text
- Examples: "CSED311 Lec7-pipeline" → "CSED311", "데이터구조 3강" → "데이터구조"`;

      const result = await llm.generateText(prompt, {
        maxOutputTokens: 20,
      });
      const cleaned = result.trim().replace(/['"*\n]/g, "").slice(0, 20);
      return cleaned || title.split(/[\s-_]/)[0];
    } catch {
      return title.split(/[\s-_]/)[0];
    }
  }

  private async activateSidebarView(): Promise<void> {
    const existing =
      this.app.workspace.getLeavesOfType(VIEW_TYPE_SIDEBAR);

    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({
        type: VIEW_TYPE_SIDEBAR,
        active: true,
      });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadPluginData(): Promise<void> {
    const saved = await this.loadData();
    this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved || {});
    // Merge settings with defaults
    this.data.settings = Object.assign(
      {},
      DEFAULT_PLUGIN_DATA.settings,
      this.data.settings || {}
    );
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }
}
