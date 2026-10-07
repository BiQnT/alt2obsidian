# Prompts

Single source for every LLM prompt used by the Alt2Obs plugin (named Alt2Obsidian before 2.0.0) and the alt2obs Skill (spec 4.7). The plugin bundles these files as strings at build time (esbuild `.md` text loader) and renders them with `src/prompts/render.ts`. The Skill reads the same files.

## Template rules

- `{{name}}` is a placeholder filled by the caller. Rendering fails if a variable is missing.
- The final newline of each file is not part of the prompt.
- Text that depends on a condition (for example "only when a transcript exists") is computed in code and passed in as a variable, so an empty variable means that fragment is absent.

## Files

| File | Used by | Variables |
|---|---|---|
| `slide-commentary.system.md` | per-slide commentary (system), alt2obs Skill via `scripts/phase2/slide-prompt.mjs`; its 문체 block is identical to the batch prompt (checked by test-skill-prompts) | none |
| `slide-commentary.user.md` | per-slide commentary (user), alt2obs Skill | `slideNum`, `totalSlides`, `conceptList`, `transcriptBlock` |
| `slide-commentary-batch.system.md` | batched commentary, CLI path (fixed instructions, cached prefix) | none |
| `slide-commentary-batch.context.md` | batched commentary: lecture-wide context, identical for every batch | `title`, `slideCount`, `subjectTags`, `knownConcepts`, `slideTitles` |
| `slide-commentary-batch.user.md` | batched commentary: this batch, always last | `slideList`, `slideBlocks` |
| `slide-commentary-batch.slide.md` | one slide inside `slideBlocks` | `slideNum`, `kind`, `slideText`, `transcriptBlock`, `imageNote` |
| `overview-from-gists.md` (+ `.system.md`) | CLI path overview from slide gists + Alt summary (map-reduce): `## 개요`, `## 핵심 개념`, `## 흐름` (demoted to `###` under `## 📋 전체 요약`) | `title`, `altSummary`, `gists` |
| `concept-extraction-gists.md` | CLI path concept extraction from gists (system: `concept-extraction.system.*.md`) | `subject`, `langInstruction`, `existingConceptHint`, `subjectTags`, `linkCandidates`, `gists` |
| `concept-extraction.md` | concept extraction | `subject`, `langInstruction`, `existingConceptHint`, `summary` |
| `concept-extraction.system.ko.md`, `concept-extraction.system.en.md` | concept extraction (system, by language) | none |
| `summary-from-transcript.md` (+ `.system.md`) | overview from the transcript when the Alt summary is short (lecture-level note without slide gists, and the Skill's slide path), in the shape of `overview-from-gists.md` without ranges | `memoContext`, `transcript` |
| `summary-enhance-transcript.md` (+ `.system.md`) | overview from the Alt summary and the transcript, same shape without ranges | `summary`, `transcript` |
| `summary-enhance-material.md` (+ `.system.md`) | the overview rewritten in the same shape with what only the PDF excerpts hold, and page ranges `(p.3~5)` in `## 흐름` | `summary`, `pageCount`, `excerptPageCount`, `excerptScope`, `materialText` |
| `summary-from-material.md` (+ `.system.md`) | overview from PDF excerpts when Alt parsing is partial, same shape with page ranges in `## 흐름` | `memoContext`, `pageCount`, `excerptPageCount`, `materialText` |
| `subject-detection.md` | subject code fallback | `title` |
| `note-verify.system.md` | note verification (system): verdict rules and answer format | none |
| `note-verify.user.md` | note verification: one batch of up to 20 claims | `title`, `claimCount`, `idList`, `claimBlocks` |
| `note-verify.claim.md` | one claim with its evidence inside `claimBlocks` | `id`, `claim`, `evidence` |
| `note-verify-missing.md` | note verification: slides no claim covers, the model picks the missing candidates | `title`, `slides` |
| `transcript-section-batch.system.md` | section summaries of a lecture without slides, CLI path (fixed instructions, cached prefix); the Skill gets it from `transcript-note.mjs prep` | none |
| `transcript-section-batch.context.md` | section summaries: lecture-wide context, identical for every batch | `title`, `duration`, `sectionCount`, `subjectTags`, `knownConcepts`, `sectionList` |
| `transcript-section-batch.user.md` | section summaries: this batch, always last | `sectionNums`, `sectionBlocks` |
| `transcript-section-batch.section.md` | one section inside `sectionBlocks` | `heading`, `text` |
| `overview-from-sections.md` (+ `.system.md`) | overview of a lecture without slides from the section gists + Alt summary, in the shape of `overview-from-gists.md` | `title`, `altSummary`, `gists` |
| `concept-extraction-sections.md` | concept extraction from the section gists (system: `concept-extraction.system.*.md`) | `subject`, `langInstruction`, `existingConceptHint`, `subjectTags`, `linkCandidates`, `gists` |
| `note-verify-transcript.system.md` | note verification of a lecture without slides (system): the evidence is STT transcript sections only | none |
| `note-verify-missing-sections.md` | note verification of a lecture without slides: sections no claim covers, with their gist | `title`, `sections` |
| `notion-fetch.md` | Notion MCP fetch (Claude CLI with only the Notion fetch tool): raw markdown or `UNCHANGED` | `url`, `cachedEdited` |
| `alignment-check.md` | optional LLM check of low-confidence transcript alignment spans (task "전사 정렬 확인", off by default) | `title`, `parts` |

## Batched prompt order (CLI path, spec 5.3)

Every batch call sends, in this order: the fixed instructions (`slide-commentary-batch.system.md`, as the Claude system prompt or the head of the Codex prompt), the lecture-wide context block, then the batch's slides. The first two parts are byte-identical for all batches of a lecture, so the CLI's prompt cache serves them from the second batch on. The answer is `{"slides":[{"slide","commentary","gist"}]}`: Codex enforces it with `--output-schema`; for Claude the schema is appended as text at the end of the prompt (a `--json-schema` answer would cost an extra model turn) and the answer is validated in code; the length rules (100 to 900 characters by how much the slide and transcript hold, visual slides up to 1000, gist up to 60) are in the instructions and checked in code with some slack (at least 40 characters, or 5 for a slide with under 80 characters of text and no transcript, so a one-sentence closing slide passes; at most 1.6 times the upper bound).

## Writing style

The Korean text the notes get from these prompts ends its sentences in "~다": slide commentary, section summaries, gists, overviews (their `## 흐름` items are noun phrases) and Korean concept notes. Academic terms and concept names stay in English inside Korean sentences, general words in Korean. Concept links are `[[English (한국어)|English]]`: the commentary and section prompts ask for them, and the code links the rest (`linkConceptNames` in `src/core/markdown.ts`).

Every overview prompt (`overview-from-gists.md`, `overview-from-sections.md` and the four `summary-*.md`) asks for the same shape: `## 개요` (2 to 4 sentences), `## 핵심 개념` (4 to 8 `**Term:** definition` bullets) and `## 흐름` (3 to 7 numbered topics), with slide, section or page ranges only in `## 흐름` and only where the input has them, no callouts and at most 1200 characters. The commentary allows at most one callout per slide, the section summaries one per section.

The commentary, section and overview prompts share one list of Korean AI tells to avoid (filler and inflation, stock closings, translationese, enumeration preambles, repeated sentence openers, the "A가 아니라 B다" frame, quote marks for emphasis, emoji, em and en dashes); test-skill-prompts checks that the list is identical in all of them. The commentary and section prompts also ban talk about the slide or the section itself ("이 슬라이드는", "이 구간에서는"). The style block of `slide-commentary-batch.system.md` and `slide-commentary.system.md` is identical (test-skill-prompts), and no prompt contains an em or en dash (test-prompts).
