---
name: alt2obs
description: Import an Alt (altalt.io) lecture into the user's Obsidian vault as page-anchored markdown compatible with the Alt2Obsidian 1.1.0 plugin. Uses Claude Code's native PDF vision (Read with pages parameter) to generate per-slide Korean commentary, sidestepping the Gemini API quota the plugin's full path needs. Output works in the plugin's Synced Viewer.
---

# alt2obs Skill (Phase 2 Stage A — Claude Code Max import path)

This Skill produces a page-anchored Obsidian lecture note from an Alt URL. The output is byte-compatible with Alt2Obsidian 1.1.0's storage format (`## 📚 슬라이드 N` sections, `<!-- alt2obs:slide:N hash:H start --> ... <!-- end -->` managed markers, `> [!note] 내 메모` callouts), so the plugin's Synced Viewer renders it correctly and re-imports preserve user free-space via the multi-managed merge.

The Skill exists because the plugin's per-slide Gemini multimodal call hits free-tier RPD limits on long decks. This path uses Claude Code's own session vision instead.

## When to use

- User provides an Alt URL and asks to "import" / "alt2obs" / "Phase 2 import" / "Claude Code 버전으로 import".
- Gemini quota is exhausted or the user wants Claude commentary quality.
- User wants a one-off import without waiting for plugin's per-slide rate-limited loop.

## Required inputs

Parse from the user's message (or ask if missing):

| Input | Example | Required |
|---|---|---|
| `url` | `https://altalt.io/note/b7472c41-…` | yes |
| `vault` | absolute path, e.g. `/Users/biqnt/Documents/lecture-vault` | yes — read from `~/Library/Application Support/obsidian/obsidian.json` if a single vault, else ask |
| `subject` | folder under `Alt2Obsidian/`, e.g. `CSED232` | yes — ask if not in user's message |
| `title` | filename stem, e.g. `8강` | optional — falls back to scraped Alt note title |
| `period` | `midterm` / `final` (or Korean equivalents — see mapping below) | optional — required if the user wants this lecture to appear in the plugin's "시험대비 요약" extraction |

**Exam-period tag mapping (CRITICAL — the plugin's `VaultManager.readNotesForSubject` filters with strict English match):**

| User says | Map to tag |
|---|---|
| `midterm`, `중간`, `중간고사`, `중간고사범위` | `midterm` |
| `final`, `기말`, `기말고사`, `기말고사범위` | `final` |
| (omitted) | no period tag — note will not appear in exam-summary extraction |

The plugin checks `tags.includes("midterm")` or `tags.includes("final")` literally. Writing the Korean phrase verbatim (e.g., `기말고사범위`) breaks the filter. Always normalize to the English value before adding to the frontmatter `tags:` array.

## Workflow

### 0. Resolve the repo root

This skill is installed as a symlink to `scripts/phase2/SKILL.md` inside the Alt2Obsidian repo. Resolve the repo from the link target:

```bash
REPO="$(cd "$(dirname "$(readlink -f ~/.claude/skills/alt2obs/SKILL.md)")/../.." && pwd)"
test -f "$REPO/prompts/slide-commentary.user.md" && test -d "$REPO/node_modules/pdfjs-dist" && echo "$REPO"
```

If the check fails (skill copied instead of linked, or repo moved), ask the user for the repo path. If only `node_modules` is missing, run `npm install` in `$REPO` first. Every `$REPO/...` path below uses this value.

### 1. Scrape Alt metadata

```bash
node "$REPO/scripts/phase2/alt-scrape.mjs" "<url>"
```

Stdout is a single-line JSON object: `{title, summary, pdfUrl, transcript, noteId, createdAt, parseQuality}`. Capture and parse it.

If `parseQuality === "partial"` or `pdfUrl === null`, stop and tell the user — Phase 2 needs the PDF.

### 2. Download the PDF

```bash
curl -sSL -o "/tmp/alt-deck-<noteId>.pdf" "<pdfUrl>"
```

Quote the URL (it has `&` query params). Verify the file is non-empty (`ls -l`).

The steps follow the plugin's import pipeline (`importNote` in `$REPO/src/main.ts`) in the same order, with the same prompt files and the same deterministic helpers, so a Skill import and a plugin import of the same lecture have the same structure. The prompt files in `$REPO/prompts/` are the single source for every generation rule; `$REPO/prompts/README.md` explains the `{{variable}}` rules. Keep scratch files under `/tmp/alt2obs-<noteId>/`.

### 3. Build the lecture summary (overview source)

Start from the scraped `summary` (call it `S`) and `transcript` (use only its first 15000 characters, `T`). Whenever a variable below says "`X` truncated", apply the plugin's `truncateForPrompt(X, 18000)`: if `X` is longer than 18000 characters, use its first 12600 characters + `\n\n[...중간 내용 생략...]\n\n` + its last 5400 characters.

a. **Transcript pass** (only if `T` is non-empty):
   - `S.length < 500`: generate with `$REPO/prompts/summary-from-transcript.system.md` + `summary-from-transcript.md`, `{{memoContext}}` = `\n\n[학생 메모]\n` + `S` when `S` is non-empty (else empty), `{{transcript}}` = `T`. The result replaces `S`.
   - `500 <= S.length < 2500`: generate with `summary-enhance-transcript.system.md` + `summary-enhance-transcript.md`, `{{summary}}` = `S`, `{{transcript}}` = `T`. The result replaces `S`.
   - `S.length >= 2500`: keep `S`.

b. **Lecture-material pass** (always attempted): write the seed text `<title>\n\n<summary as scraped, before step a>` to `/tmp/alt2obs-<noteId>/seed.txt`, then

   ```bash
   node "$REPO/scripts/phase2/lecture-material.mjs" "/tmp/alt-deck-<noteId>.pdf" "/tmp/alt2obs-<noteId>/seed.txt"
   ```

   If it prints `{"material":null}`, keep `S`. Otherwise generate with `summary-enhance-material.system.md` + `summary-enhance-material.md`, `{{summary}}` = `S` truncated, and `{{pageCount}}`, `{{excerptPageCount}}`, `{{excerptScope}}`, `{{materialText}}` taken verbatim from the JSON. The result replaces `S`.

`S` is now the enhanced summary. Save it to `/tmp/alt2obs-<noteId>/summary.md`.

### 4. Extract concepts

Concepts are extracted from the enhanced summary `S` (not from the slide commentary), exactly like the plugin's `ConceptExtractor`. The concept notes are what the lecture's `[[wikilinks]]` resolve to; without this step the wikilinks dangle.

1. List existing concept names by globbing `<vault>/Alt2Obsidian/<subject>/Concepts/*.md` (use `Bash` `ls`). These are reuse candidates.
2. Generate with `$REPO/prompts/concept-extraction.system.ko.md` + `concept-extraction.md`: `{{subject}}` = subject, `{{langInstruction}}` = the Korean (`ko`) branch of `langInstruction` in `$REPO/src/generator/ConceptExtractor.ts`, `{{existingConceptHint}}` = empty if there are no existing names, else `\nExisting concept notes in this course (REUSE these exact names when the same concept appears):\n` + one `- <name>` line per name + `\n`, `{{summary}}` = `S`. The prompt defines the JSON shape (`concepts[]` with `name`, `definition`, `lectureContext`, `example`, `caution`, `relatedConcepts`, plus `tags[]`).
3. Save the concept names as a JSON array to `/tmp/alt2obs-<noteId>/concepts.json`.

**Concept note files:**

1. For each concept, generate a markdown file at `<vault>/Alt2Obsidian/<subject>/Concepts/<sanitized-name>.md` using the **plugin's exact template** (mirror `VaultManager.buildConceptNoteContent` in `src/vault/VaultManager.ts`):

   ```markdown
   ---
   tags: [concept]
   ---

   # {name}

   **정의:** {definition}

   **강의 맥락:** {lectureContext}

   **예시:** {example}

   **주의:** {caution}

   **관련 강의:** [[{lectureTitle}]]

   **관련 개념:** [[{relatedConcept1}]], [[{relatedConcept2}]]
   ```

   Skip the `**예시:**` line entirely if `example` is empty; same for `**주의:**` and `**관련 개념:**`. Do NOT emit empty-value lines; match how the plugin elides them.

2. **Skip-if-exists with append behaviour**: if `<vault>/Alt2Obsidian/<subject>/Concepts/<sanitized-name>.md` already exists from a prior import:
   - Read it.
   - If `**관련 강의:**` already contains `[[{lectureTitle}]]`, leave the file untouched.
   - Otherwise append `, [[{lectureTitle}]]` to the existing `**관련 강의:**` line. This matches `VaultManager.appendLectureReference` (`src/vault/VaultManager.ts`), same lecture cross-linking semantics.
   - Optionally enrich missing fields (e.g., the prior concept note has no `**예시:**` and the new lecture has a good one) by appending the new field above the `**관련 강의:**` line. Mirrors `VaultManager.appendMissingConceptField` (`:312-324`).

3. **Filename sanitization**: replace `/`, `\`, `:`, `?`, `*`, `"`, `<`, `>`, `|` with `_` (mirrors `src/utils/helpers.ts:sanitizeFilename`). Korean characters and parentheses are valid in vault filenames.

4. After writing all concept notes, append a brief summary in the completion message: "{N} concept notes written to Concepts/: {a few names}".

### 5. Compute the slide hashes

Run the hash CLI once for the whole deck. It uses the same code as the plugin (`src/core/slideHash.ts`), so hashes match a plugin import of the same PDF:

```bash
node "$REPO/scripts/phase2/slide-hashes.mjs" "/tmp/alt-deck-<noteId>.pdf" "<noteId>"
```

Stdout is `{"pages":[{"page":1,"hash":"xxxxxxxx","textChars":123}, ...]}`. Use `pages[N-1].hash` in the markers for slide N. Do not compute hashes any other way. `textChars` is the normalized text length; `0` means an image-only page (its hash is derived from `noteId` and the page number).

### 6. Read each slide and compose commentary

If `transcript` is non-empty, split the full transcript evenly by character count across the slide count (chunk size = ceil(length / slideCount), each chunk trimmed, empty chunk = none), exactly like `splitTranscriptEvenly` in `$REPO/src/generator/PerSlideCommentaryGenerator.ts`. Chunk N is slide N's transcript context.

Use `Read` with the `pages` parameter to walk through the deck, **20 pages at a time** (the tool's max). Example:

```
Read(file_path="/tmp/alt-deck-<noteId>.pdf", pages="1-20")
Read(file_path="/tmp/alt-deck-<noteId>.pdf", pages="21-40")
…
```

Reading a PDF returns the page contents as images you can see directly. For each page N, generate the commentary with `$REPO/prompts/slide-commentary.system.md` + `slide-commentary.user.md`: `{{slideNum}}` = N, `{{totalSlides}}` = page count, `{{conceptList}}` = the existing concept names from step 4.1 (not the newly extracted ones), `{{transcriptBlock}}` = slide N's transcript chunk. Both fragments are empty when there is nothing to show and are otherwise formatted as in `buildSlidePrompt` in `PerSlideCommentaryGenerator.ts`.

**Token saving (same prep as the plugin 2.0 CLI path).** Before writing commentary, save the full transcript to `/tmp/alt2obs-<noteId>/transcript.txt` and run the plugin's deterministic prep:

```bash
node "$REPO/scripts/phase2/prep.mjs" "/tmp/alt-deck-<noteId>.pdf" "<noteId>" --title "<title>" --transcript "/tmp/alt2obs-<noteId>/transcript.txt"
```

It prints `{"pages":[{"page","hash","kind","dupOf","mode","template","transcript",...}],"batches":[[...]]}` (renders with `pdftoppm` when installed; add `--no-render` to skip). For every page with `"mode":"template"` (cover, table of contents, closing slide, or an animation step whose `dupOf` page carries the explanation) use its `template` string verbatim as the slide body and do not generate or read it. For `"mode":"llm"` pages use their `transcript` field (fillers and repeats removed, capped, preferring sentences that match the slide) as the transcript chunk instead of the even split above. The `hash` values equal `slide-hashes.mjs`.

Save each commentary to `/tmp/alt2obs-<noteId>/slide-<N>.md`, then link the extracted concept names (step 4) in all of them with the plugin's own code (`linkConceptNames` in `$REPO/src/core/markdown.ts`). The files are rewritten in place:

```bash
node "$REPO/scripts/phase2/link-concepts.mjs" "/tmp/alt2obs-<noteId>/concepts.json" /tmp/alt2obs-<noteId>/slide-*.md
```

Use the linked files verbatim as the slide bodies in step 7. Do not add or remove wikilinks by hand.

### 7. Assemble the markdown

Build the overview section with the plugin's own code (headings in the summary are demoted one level and concept names are linked):

```bash
node "$REPO/scripts/phase2/overview-block.mjs" "/tmp/alt2obs-<noteId>/summary.md" "/tmp/alt2obs-<noteId>/concepts.json" > "/tmp/alt2obs-<noteId>/overview.md"
```

Insert `overview.md` verbatim between `# <title>` and the first slide section (it is empty when the summary is empty). Do not edit it.

```markdown
---
title: "<title>"
subject: "<subject>"
tags: [<subject lowercased>, <englishPeriodIfSpecified>, <conceptTag1>, <conceptTag2>, ...]
date: "<YYYY-MM-DD>"
source: "alt2obsidian-cc-skill"
slide_count: <N>
alt_id: "<noteId>"
alt_created: "<createdAt>"
---

# <title>

<overview section printed by overview-block.mjs, verbatim>
## 📚 슬라이드 1

<!-- alt2obs:slide:1 hash:<8-hex> start -->
<commentary for slide 1>
<!-- alt2obs:slide:1 hash:<8-hex> end -->

> [!note] 내 메모
> 

## 📚 슬라이드 2

<!-- alt2obs:slide:2 hash:<8-hex> start -->
<commentary for slide 2>
<!-- alt2obs:slide:2 hash:<8-hex> end -->

> [!note] 내 메모
> 

… (repeat for all N slides) …
```

Marker format must match exactly:

- 슬라이드: `<!-- alt2obs:slide:N hash:HHHHHHHH start -->` (single spaces), parsed by `VaultManager.splitMultiManagedNote`. No `dup:` suffix.
- Overview: `<!-- alt2obs:overview start -->` / `<!-- alt2obs:overview end -->` (printed by `overview-block.mjs`). On re-import only the text between these markers is replaced; text the user writes above or below the block is kept. Tell the user edits inside the block are overwritten if they ask.

### 8. Write to the vault

Save the assembled markdown to `/tmp/alt2obs-<noteId>/note.md` first. The target is `<vault>/Alt2Obsidian/<subject>/<title>.md`.

**If the target does not exist:**

```
mkdir -p "<vault>/Alt2Obsidian/<subject>"
```

Then `Write` `note.md` to the target unchanged.

**If the target already exists (re-import), never overwrite it directly.** Merge with the plugin's own merge code, which keeps every `> [!note] 내 메모` callout on its slide (matched by hash), keeps text outside the managed blocks, and moves memos of deleted slides to a `## 🗑️ 삭제된 슬라이드 (orphan)` section:

1. Preview the changes:

   ```bash
   node "$REPO/scripts/phase2/merge-note.mjs" "<target>" "/tmp/alt2obs-<noteId>/note.md" --summary
   ```

   It prints `{"mode","reorders","insertions","deletions","drifts","confirmDeckReplacement","notes"}`. Show the user the counts (drift = content changed at the same position, reorder = moved, insertion = new slide, deletion = orphaned slide, with slide numbers) and every entry of `notes`, then ask whether to update. Stop if they decline.
2. If `confirmDeckReplacement` is `true`, more than half of the existing slides would be orphaned, which usually means a different lecture is being imported onto this note. Say so explicitly and require a separate, explicit confirmation before continuing.
3. Write the merged note:

   ```bash
   node "$REPO/scripts/phase2/merge-note.mjs" "<target>" "/tmp/alt2obs-<noteId>/note.md" > "/tmp/alt2obs-<noteId>/merged.md"
   ```

   then copy `merged.md` over the target (`cp`). If `merge-note.mjs` exits non-zero, relay its message and leave the target untouched.

Copy the PDF to its sibling location (Task 1.4 layout):

```bash
cp "/tmp/alt-deck-<noteId>.pdf" "<vault>/Alt2Obsidian/<subject>/<title>.pdf"
```

### 9. Report completion

Tell the user: file path written, whether it was a new note or a merge (with the change counts), slide count, the concept notes written, any slides where you found the content was unusually thin (e.g. a totally blank slide), and a one-line note that the Synced Viewer can be opened from Obsidian's command palette.

## Hash compat caveat (always include in completion message)

The plugin and this Skill produce identical slide hashes: both run `src/core/slideHash.ts` (`sha1(normalized page text)`, first 8 hex, no page number; pages without text use `sha1(noteId + ":" + page)`). Because the hash does not depend on the page number, and both tools merge re-imports with the same code (`src/core/merge.ts`, run by `merge-note.mjs` in step 8), inserting or deleting slides keeps every `> [!note] 내 메모` callout on its own slide when the lecture is re-imported with either tool.

Notes written by 1.x (plugin PNG hash, or the old Skill `sha1(noteId:page)` hash) will show every slide as `slideDrift` once on their first re-import with this version. Memos are still preserved through the N-match-with-drift branch, and the new hashes are stable after that.

## Retroactive fix for existing Skill-generated notes

If you already imported a lecture via the Skill before this exam-period fix, the note's `tags:` line may contain Korean strings like `기말고사범위` instead of the English `final`. The plugin's exam-summary extractor will skip those notes. To fix, run:

```bash
# Replace Korean period strings with English equivalents in a single note's frontmatter.
# Adjust path. Backup first if you've manually edited the file.
sed -i '' 's/기말고사범위/final/g; s/기말고사/final/g; s/중간고사범위/midterm/g; s/중간고사/midterm/g' "<vault>/Alt2Obsidian/<subject>/<title>.md"
```

Or re-run the Skill against the same Alt URL with `period=final` (or `midterm`). Step 8 merges the re-import with `merge-note.mjs`, which preserves your `> [!note] 내 메모` callouts via the hash-match path, and the corrected tag gets written.

## Error handling

- `alt-scrape.mjs` exits 1 with stderr message → relay to user, stop.
- Any `scripts/phase2/*.mjs` helper exits non-zero → relay its stderr to the user and stop. Do not recreate their output by hand. If a `scripts/phase2/*.mjs` file is missing, run `npm run build:scripts` in `$REPO` first.
- `parseQuality: "partial"` or `pdfUrl: null` → tell user the Alt note isn't a full lecture and stop.
- `Read` of a PDF page fails → log the slide as `## ⚠️ 처리 실패 슬라이드 N` footer at the end of the markdown (matches the plugin's failure-footer convention), continue with the rest.
- Vault path doesn't exist → ask the user; do NOT create it without consent.
- A file already exists at the target `.md` path → merge it as in step 8 (preview, confirm, `merge-note.mjs`); never overwrite it with `Write`.

## Out of scope (Phase 2 Stage B)

- npm-publishable CLI. The script is repo-local for now.
- requestUrl decoupling in the plugin's `src/llm/`, `src/scraper/`, `src/pdf/` (Task 2.3).
- Cross-platform PDF.js spike (Task 2.5).

## Quick test target

The user's existing 8강 URL should work end-to-end:

```
url: https://altalt.io/note/b7472c41-f585-4109-a076-2d8925dd9e7d
vault: /Users/biqnt/Documents/lecture-vault
subject: 8강
title: 8강-claude
```

This avoids overwriting the existing `8강.md` (Gemini-generated). Compare side-by-side after import to evaluate Skill commentary quality vs Gemini's.
