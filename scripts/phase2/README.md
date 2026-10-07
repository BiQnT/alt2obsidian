# Phase 2 Stage A: Claude Code Skill MVP

Skill that imports an Alt lecture into the Obsidian vault using Claude Code Max's session vision instead of the plugin's Gemini call. Output is byte-compatible with the Alt2Obs plugin's page-anchored format (the plugin was named Alt2Obsidian before 2.0.0). The Synced Viewer works on it, regen preserves your `> [!note] 내 메모` callouts.

## Files

- `alt-scrape.mjs`: pure Node Alt URL scraper. Port of `src/scraper/{AltScraper,RscParser}.ts` with no Obsidian deps. Reads an `https://altalt.io/note/<id>` URL, prints metadata JSON to stdout: `{title, summary, pdfUrl, transcript, noteId, createdAt, parseQuality}`.
- `slide-hashes.mjs`: per-page slide hashes for a PDF, `node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>` prints `{"pages":[{"page":1,"hash":"xxxxxxxx","textChars":123}, ...]}`. Generated from `scripts/src/slide-hashes.ts` by `npm run build:scripts` (also part of `npm run build`); it imports the plugin's `src/core/slideHash.ts`, so hashes are identical to the plugin's. `pdfjs-dist` is loaded from the repo's `node_modules`, so run `npm install` once.
- `lecture-material.mjs`: the PDF excerpt for `prompts/summary-enhance-material.md`, computed by the plugin's `src/core/lectureMaterial.ts`. `node scripts/phase2/lecture-material.mjs <pdfPath> <seedTextFile>` prints `{"material":{...}}` or `{"material":null}`.
- `overview-block.mjs`: the `## 📋 전체 요약` section built by the plugin's `src/core/markdown.ts` (headings demoted one level, concept names linked). `node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile]`.
- `link-concepts.mjs`: wraps concept names in `[[...]]` with the plugin's `linkConceptNames`. `node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> <file>...` rewrites the files in place.
- `prep.mjs`: the plugin's deterministic prep (`src/core/prep`, `src/pipeline/batchPlan.ts`): slide kind (cover, toc, thanks, content, visual), near-duplicate animation steps, template lines for slides that need no LLM call, compressed per-slide transcript, and the batches the plugin would send. With `--bundle` (an `alt-local.mjs export`) the timestamped transcript is aligned to the slides like the plugin (`src/core/prep/TranscriptAligner.ts`) and the output carries the `alt_alignment` value. `node scripts/phase2/prep.mjs <pdfPath> <sourceId> [--title T] [--transcript F | --bundle bundle.json] [--cap 600] [--batch 8] [--renders DIR | --no-render] [--existing note.md]`. Uses `pdftoppm` for the image ratio and image signal when installed.
- `merge-note.mjs`: re-import merge with the plugin's `src/core/merge.ts` (memos follow their slides, text outside managed blocks kept, deleted slides orphaned). `node scripts/phase2/merge-note.mjs <existingNote> <newNote>` prints the merged note; with `--summary` it prints the change summary as JSON instead.
- `alt-local.mjs`: Alt notes on this Mac through the plugin's `src/sources` (local HTTP API when Alt runs and the port's owner is verified as Alt, else a private copy of the signed-in account's database; read only, the API token is never printed). `node scripts/phase2/alt-local.mjs status | list [--query T] | export <noteId> [outDir] [--alt-dir DIR] [--source auto|api|db]`; `export` writes `bundle.json` (the LectureBundle without PDF bytes, with `pdfPath` and the guessed `subject`) and `transcript.txt` into a new private folder (0700, files 0600) made inside `outDir`, or inside the OS temp folder when `outDir` is omitted, and prints its path as `dir`. Delete it after use. Needs Node 22.5+ for the database fallback (`node:sqlite`).
- `verify-prep.mjs`: the plugin's note verifier (`src/verify`): `prep <pdfPath> <noteFile> --lecture <name> --out <dir> [--bundle bundle.json] [--alignment V]` splits the note into claims, finds the evidence (BM25 over slides and the aligned transcript) and writes the judge prompts the plugin would send (`system.md`, `batch-<n>.md`, `missing.md`, `plan.json`, folder 0700, files 0600); `render <dir> --answers answers.json --source <label> [--missing missing.json] [--existing note.md]` checks the answers like the plugin and prints the verification note.
- `transcript-note.mjs`: the summary note of a lecture without slides (spec 4.10), with the plugin's `src/pipeline/transcriptPlan.ts`, `src/generator/SectionSummaryGenerator.ts` and `NoteGenerator.generateTranscriptNote`. `prep <bundle.json|transcript.txt> --title T --out DIR [--known names.json] [--tags tags.json] [--existing note.md]` cuts the transcript into sections and writes the section prompts (`system.md`, `batch-<n>.md`, `plan.json`; folder 0700, files 0600); `followup DIR --answers answers.json` checks the answers like the plugin and writes the overview and concept prompts; `render DIR --answers ... --overview ... --concepts ... --subject S --id ID [--local]` prints the note. `verify-prep.mjs prep - <noteFile> ... --bundle B --lecture-note NOTE` verifies against such a note's transcript sections.
- `carry-frontmatter.mjs`: the frontmatter a re-import keeps, with the plugin's `preservedFrontmatterLines` (a linked note's other identity, `alt_pdf_source: "attached"`), plus the attached PDF to use as the deck. `node scripts/phase2/carry-frontmatter.mjs <target note> --local|--url [--alignment V]` prints `{"lines","attachedPdf"}` (the `alt_pdf_source` line only while the attached PDF is there, like the plugin).
- `SKILL.md`: orchestration. Drives Claude Code through scrape → download PDF → read each slide via `Read(pages: "N-N")` → write Korean commentary → assemble page-anchored markdown → write to vault.

## Install

From the repo root:

```bash
npm install
mkdir -p ~/.claude/skills/alt2obs
ln -sf "$(pwd)/scripts/phase2/SKILL.md" ~/.claude/skills/alt2obs/SKILL.md
```

Use a symlink, not a copy: the Skill finds the repo (prompts, scripts, `node_modules`) by resolving the link target, and it reads its commentary, overview and concept rules from `prompts/*.md` so the plugin and the Skill share one source. The CLIs in `scripts/phase2/*.mjs` are committed; after changing `scripts/src` or `src/core`, run `npm run build:scripts`. The Skill is then available globally to Claude Code; project-local discovery would need `.claude/skills/alt2obs/SKILL.md` inside the target project (`.claude/` is git-ignored in this repo).

## Use

```
/alt2obs https://altalt.io/note/b7472c41-…  subject=CSED232  title=8강-claude
```

Vault path is auto-detected from `~/Library/Application Support/obsidian/obsidian.json` if a single vault is configured; otherwise the Skill asks.

## Why Phase 2 Stage A only

The full plan (`.omc/plans/alt2obsidian-page-anchored-redesign.md`) calls for `packages/core` + `packages/cli` + npm-publish + `requestUrl` decoupling, multi-week work. Stage A skips the refactor and gets a working Claude-Code import path on disk in one session. Stage B is the real monorepo restructure, scheduled per user when they're ready.

## Hash compatibility

The plugin and the Skill compute the same slide hash from the same code in `src/core/slideHash.ts`: `sha1(normalized page text)` truncated to 8 hex, with no page number, so inserting or deleting a slide does not change any other slide's hash and memos follow their slides on re-import. Pages without a text layer use `sha1(noteId + ":" + page)`. A lecture imported with one tool and re-imported with the other matches every slide by hash.

Notes written by 1.x (plugin PNG-byte hash or the old Skill `sha1(noteId:page)` hash) show every slide as `slideDrift` once on their first re-import. Memos are preserved through the N-match-with-drift branch, and hashes are stable afterwards.

`node test/test-slide-hash.mjs [pdfPath]` checks that the committed CLI bundles are fresh and that the hash output is deterministic and follows the rule; `node test/test-skill-clis.mjs [pdfPath]` checks that `lecture-material`, `overview-block`, `link-concepts`, `prep`, `verify-prep`, `transcript-note` and `carry-frontmatter` match the plugin code, and `node test/test-merge.mjs` checks `merge-note` against the plugin merge; `node test/test-sources.mjs` checks `alt-local.mjs` against a fake Alt server and synthetic databases. The tests use the committed fixture `test/fixtures/text-deck.pdf` and also check a real Alt deck when one is present.
