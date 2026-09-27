# Prompts

Single source for every LLM prompt used by the Alt2Obsidian plugin and the alt2obs Skill (spec 4.7). The plugin bundles these files as strings at build time (esbuild `.md` text loader) and renders them with `src/prompts/render.ts`. The Skill reads the same files.

## Template rules

- `{{name}}` is a placeholder filled by the caller. Rendering fails if a variable is missing.
- The final newline of each file is not part of the prompt.
- Text that depends on a condition (for example "only when a transcript exists") is computed in code and passed in as a variable, so an empty variable means that fragment is absent.

## Files

| File | Used by | Variables |
|---|---|---|
| `slide-commentary.system.md` | per-slide commentary (system) | none |
| `slide-commentary.user.md` | per-slide commentary (user) | `slideNum`, `totalSlides`, `conceptList`, `transcriptBlock` |
| `concept-extraction.md` | concept extraction | `subject`, `langInstruction`, `existingConceptHint`, `summary` |
| `concept-extraction.system.ko.md`, `concept-extraction.system.en.md` | concept extraction (system, by language) | none |
| `summary-from-transcript.md` (+ `.system.md`) | overview when the Alt summary is short | `memoContext`, `transcript` |
| `summary-enhance-transcript.md` (+ `.system.md`) | overview enrichment from the transcript | `summary`, `transcript` |
| `summary-enhance-material.md` (+ `.system.md`) | overview enrichment from PDF excerpts | `summary`, `pageCount`, `excerptPageCount`, `excerptScope`, `materialText` |
| `summary-from-material.md` (+ `.system.md`) | overview from PDF excerpts when Alt parsing is partial | `memoContext`, `pageCount`, `excerptPageCount`, `materialText` |
| `subject-detection.md` | subject code fallback | `title` |
