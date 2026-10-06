// Test entry: the transcript summary path for lectures without slides (spec 4.10), obsidian stubbed.
export * from "../../src/core/sections";
export * from "../../src/core/prep/TranscriptSections";
export * from "../../src/pipeline/transcriptPlan";
export * from "../../src/pipeline/transcriptPipeline";
export * from "../../src/generator/SectionSummaryGenerator";
export { NoteGenerator } from "../../src/generator/NoteGenerator";
export { mergeNote, splitSectionNote, hasMultiManagedMarkers, TRANSCRIPT_TO_SLIDES_NOTE, TRANSCRIPT_MIGRATION_NOTE } from "../../src/core/merge";
export { computeSlideHash } from "../../src/core/slideHash";
export * from "../../src/core/noteStatus";
export * from "../../src/core/pdfAttach";
export { readPickedFile } from "../../src/ui/attachPdf";
export { lectureNoteForPdf } from "../../src/ui/pdfOpen";
export { ClaudeCliProvider } from "../../src/llm/cli/ClaudeCliProvider";
export { createJobDir, removeJobDir } from "../../src/llm/cli/CliRunner";
export { UsageTracker } from "../../src/llm/usage";
export * from "../../src/verify/NoteVerifier";
export { normalizeConcepts } from "../../src/core/conceptNames";
export { timedSegments } from "../../src/pipeline/alignment";
