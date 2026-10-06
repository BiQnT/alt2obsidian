# Prompts

Single source for every LLM prompt used by the Alt2Obsidian plugin and the alt2obs Skill (spec 4.7). The plugin bundles these files as strings at build time (esbuild `.md` text loader) and renders them with `src/prompts/render.ts`. The Skill reads the same files.

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
| `overview-from-gists.md` (+ `.system.md`) | CLI path overview from slide gists + Alt summary (map-reduce) | `title`, `altSummary`, `gists` |
| `concept-extraction-gists.md` | CLI path concept extraction from gists (system: `concept-extraction.system.*.md`) | `subject`, `langInstruction`, `existingConceptHint`, `subjectTags`, `linkCandidates`, `gists` |
| `concept-extraction.md` | concept extraction | `subject`, `langInstruction`, `existingConceptHint`, `summary` |
| `concept-extraction.system.ko.md`, `concept-extraction.system.en.md` | concept extraction (system, by language) | none |
| `summary-from-transcript.md` (+ `.system.md`) | overview when the Alt summary is short | `memoContext`, `transcript` |
| `summary-enhance-transcript.md` (+ `.system.md`) | overview enrichment from the transcript | `summary`, `transcript` |
| `summary-enhance-material.md` (+ `.system.md`) | overview enrichment from PDF excerpts | `summary`, `pageCount`, `excerptPageCount`, `excerptScope`, `materialText` |
| `summary-from-material.md` (+ `.system.md`) | overview from PDF excerpts when Alt parsing is partial | `memoContext`, `pageCount`, `excerptPageCount`, `materialText` |
| `subject-detection.md` | subject code fallback | `title` |
| `note-verify.system.md` | note verification (system): verdict rules and answer format | none |
| `note-verify.user.md` | note verification: one batch of up to 20 claims | `title`, `claimCount`, `idList`, `claimBlocks` |
| `note-verify.claim.md` | one claim with its evidence inside `claimBlocks` | `id`, `claim`, `evidence` |
| `note-verify-missing.md` | note verification: slides no claim covers, the model picks the missing candidates | `title`, `slides` |
| `notion-fetch.md` | Notion MCP fetch (Claude CLI with only the Notion fetch tool): raw markdown or `UNCHANGED` | `url`, `cachedEdited` |
| `alignment-check.md` | optional LLM check of low-confidence transcript alignment spans (task "전사 정렬 확인", off by default) | `title`, `parts` |

## Batched prompt order (CLI path, spec 5.3)

Every batch call sends, in this order: the fixed instructions (`slide-commentary-batch.system.md`, as the Claude system prompt or the head of the Codex prompt), the lecture-wide context block, then the batch's slides. The first two parts are byte-identical for all batches of a lecture, so the CLI's prompt cache serves them from the second batch on. The answer is `{"slides":[{"slide","commentary","gist"}]}`: Codex enforces it with `--output-schema`; for Claude the schema is appended as text at the end of the prompt (a `--json-schema` answer would cost an extra model turn) and the answer is validated in code; the length rules (200 to 500 characters, visual slides up to 700, gist up to 60) are in the instructions and checked in code with some slack.

