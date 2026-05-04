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

### 1. Scrape Alt metadata

Run the scraper helper. The repo lives at `/Users/biqnt/dev_project/alt2obsidian` (adjust if invoked elsewhere).

```bash
node /Users/biqnt/dev_project/alt2obsidian/scripts/phase2/alt-scrape.mjs "<url>"
```

Stdout is a single-line JSON object: `{title, summary, pdfUrl, transcript, noteId, createdAt, parseQuality}`. Capture and parse it.

If `parseQuality === "partial"` or `pdfUrl === null`, stop and tell the user — Phase 2 needs the PDF.

### 2. Download the PDF

```bash
curl -sSL -o "/tmp/alt-deck-<noteId>.pdf" "<pdfUrl>"
```

Quote the URL (it has `&` query params). Verify the file is non-empty (`ls -l`).

### 3. Read each slide and compose commentary

Use `Read` with the `pages` parameter to walk through the deck, **20 pages at a time** (the tool's max). Example:

```
Read(file_path="/tmp/alt-deck-<noteId>.pdf", pages="1-20")
Read(file_path="/tmp/alt-deck-<noteId>.pdf", pages="21-40")
…
```

Reading a PDF returns the page contents as images you can see directly. For each page N, write a Korean commentary section following these rules (these mirror the plugin's `PerSlideCommentaryGenerator` prompt — match the tone so plugin and Skill outputs feel uniform):

- Output is the section body only — never include the section heading (`## …`); the assembler step adds it.
- 200–500 한글 문자.
- 정의/개념: `> [!definition] 개념명` callout.
- 예시/공식/코드: `> [!example]` callout.
- 시험 출제 포인트: `> [!important]` callout.
- 음성 전사가 있으면 (see step 4) 교수님 강조 1–2 포인트만 인용 형태로 — raw 덤프 금지.
- 핵심 개념은 `[[개념명]]` wikilink (관련 개념이 반복되면 모든 슬라이드에서 일관되게 wrap).
- 표지/목차/Thank you 같은 비실질 슬라이드는 한 줄로 간단히.

### 4. (optional) Curate transcript per slide

If `transcript` is non-empty, split it evenly by character count across the slide count and pass the chunk that corresponds to slide N as additional context for the commentary. The transcript is from Alt's audio capture; lecturers' verbal asides go here. Even-split is the same heuristic the plugin uses — segment timestamps are dropped by Alt's RSC payload.

### 5. Compute the slide hash

For each page N, compute `sha1("{noteId}:{N}").slice(0, 8)`. In Bash:

```bash
HASH=$(printf "%s:%d" "<noteId>" "<N>" | shasum -a 1 | cut -c1-8)
```

This is **deterministic but different from the plugin's hash** (the plugin hashes the rendered PNG bytes; the Skill cannot reproduce that hash without a Node canvas dependency). Document this caveat in the writeup at the bottom — see "Hash compat caveat" below.

### 6. Assemble the markdown

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

Marker format must match exactly: `<!-- alt2obs:slide:N hash:HHHHHHHH start -->` (with single spaces) — this is what `VaultManager.splitMultiManagedNote` parses.

### 6.5 Extract concepts (NEW — required for parity with the plugin)

After all per-slide commentary is written and the assembled lecture markdown is in your buffer, run a final pass to extract academic concepts from the whole lecture. This produces separate `Concepts/<name>.md` files that the lecture's `[[wikilinks]]` resolve to — without this step the wikilinks dangle.

**Concept extraction prompt (mirror this exactly — same quality bar as the plugin's `ConceptExtractor`):**

```
LANGUAGE: 모든 concept 필드 (definition, lectureContext, example, caution)는 한국어로. 영어 설명을 한국어 필드에 섞지 마. 단, 전문 용어는 괄호로 영어 병기 OK (예: **명세(Specification)**).

For each concept provide:
- name: 1-4 words. 한국어 + 영어 병기 패턴 "한국어 (English)", e.g. "데이터 추상화 (Data Abstraction)".
- definition: 3-5 sentences. 개념이 무엇이고, 무엇과 구별되며, 이 강의 맥락에서 왜 중요한지 다 다뤄. 한 줄짜리 정의는 거부.
- lectureContext: 2-3 sentences. 이번 강의에서 어떻게 도입되고 사용되었는지. "교수님이 이 슬라이드에서 X를 설명하기 위해 도입했다", "전 강의의 Y와 대비해 소개되었다"같이 narrative와 연결.
- example: 강의에 있던 구체적 예시 (숫자, 코드, 공식, 특정 케이스). 2-3 sentences. 강의에 진짜 예시가 없으면 비워둬.
- caution: 학생이 자주 하는 실수, 시험 함정, 미묘한 구분. 진짜 떠오르지 않으면 비워둬 — 패딩하지 마.
- relatedConcepts: 같은 강의에서 추출한 다른 concept 이름들 (또는 기존 concepts/ 폴더에 있는 이름들). 2개 이상의 concept을 추출했으면 모든 concept은 적어도 1개의 relatedConcept을 가져야 해. 정확한 이름 사용, 새 이름 만들지 마.

기존 concepts/ 폴더에 같은 의미의 노트가 있으면 그 정확한 이름을 재사용 — concept 그래프 분열 방지.

분량: 4-8 concepts 추출 (보통 강의 기준). 좁은 강의면 더 적게, 광범위한 surveys면 더 많이. 패딩 금지.
```

**Workflow:**

1. List existing concept names by globbing `<vault>/Alt2Obsidian/<subject>/Concepts/*.md` (use `Bash` `ls`). These are reuse candidates.
2. Apply the prompt above to the assembled lecture content. Output JSON shape:
   ```json
   {
     "concepts": [
       {
         "name": "데이터 추상화 (Data Abstraction)",
         "definition": "...",
         "lectureContext": "...",
         "example": "...",
         "caution": "...",
         "relatedConcepts": ["객체 명세 (Object Specification)", "..."]
       }
     ],
     "tags": ["..."]
   }
   ```
3. For each concept, generate a markdown file at `<vault>/Alt2Obsidian/<subject>/Concepts/<sanitized-name>.md` using the **plugin's exact template** (mirror `src/vault/VaultManager.ts:250-277`):

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

   Skip the `**예시:**` line entirely if `example` is empty; same for `**주의:**` and `**관련 개념:**`. Do NOT emit empty-value lines — match how the plugin elides them.

4. **Skip-if-exists with append behaviour**: if `<vault>/Alt2Obsidian/<subject>/Concepts/<sanitized-name>.md` already exists from a prior import:
   - Read it.
   - If `**관련 강의:**` already contains `[[{lectureTitle}]]`, leave the file untouched.
   - Otherwise append `, [[{lectureTitle}]]` to the existing `**관련 강의:**` line. This matches `VaultManager.appendLectureReference` (`src/vault/VaultManager.ts:295-310`) — same lecture cross-linking semantics.
   - Optionally enrich missing fields (e.g., the prior concept note has no `**예시:**` and the new lecture has a good one) by appending the new field above the `**관련 강의:**` line. Mirrors `VaultManager.appendMissingConceptField` (`:312-324`).

5. **Filename sanitization**: replace `/`, `\`, `:`, `?`, `*`, `"`, `<`, `>`, `|` with `_` (mirrors `src/utils/helpers.ts:sanitizeFilename`). Korean characters and parentheses are valid in vault filenames.

6. After writing all concept notes, append a brief summary in the completion message: "{N} concept notes written to Concepts/ — {a few names}".

### 7. Write to the vault

```
mkdir -p "<vault>/Alt2Obsidian/<subject>"
```

Then `Write` the assembled markdown to:

```
<vault>/Alt2Obsidian/<subject>/<title>.md
```

And copy the PDF to its sibling location (Task 1.4 layout):

```bash
cp "/tmp/alt-deck-<noteId>.pdf" "<vault>/Alt2Obsidian/<subject>/<title>.pdf"
```

### 8. Report completion

Tell the user: file path written, slide count, any slides where you found the content was unusually thin (e.g. a totally blank slide), and a one-line note that the Synced Viewer can be opened from Obsidian's command palette.

## Hash compat caveat (always include in completion message)

The hash field uses `SHA-1("{noteId}:{slideNum}").slice(0, 8)`. This is **deterministic per (lecture, slide)** — re-running the Skill on the same Alt URL produces matching hashes, so the Round 5 invariant (per-slide free-space preservation across regen) holds **within Skill outputs**. But the plugin's Gemini path uses `SHA-1(rendered_PNG_bytes).slice(0, 8)`, which is different. **If the user later re-imports the same lecture via the plugin, every section will surface as `slideDrift` once** — memos are still preserved (via the N-match-with-drift branch), but a confirmation modal will list every slide as "drifted." A future Stage B (real monorepo + node-canvas) can produce the same byte-hashes as the plugin and eliminate this.

## Retroactive fix for existing Skill-generated notes

If you already imported a lecture via the Skill before this exam-period fix, the note's `tags:` line may contain Korean strings like `기말고사범위` instead of the English `final`. The plugin's exam-summary extractor will skip those notes. To fix, run:

```bash
# Replace Korean period strings with English equivalents in a single note's frontmatter.
# Adjust path. Backup first if you've manually edited the file.
sed -i '' 's/기말고사범위/final/g; s/기말고사/final/g; s/중간고사범위/midterm/g; s/중간고사/midterm/g' "<vault>/Alt2Obsidian/<subject>/<title>.md"
```

Or just re-run the Skill against the same Alt URL with `period=final` (or `midterm`) — the multi-managed merge preserves your `> [!note] 내 메모` callouts via the hash-match path, and the corrected tag gets written.

## Error handling

- `alt-scrape.mjs` exits 1 with stderr message → relay to user, stop.
- `parseQuality: "partial"` or `pdfUrl: null` → tell user the Alt note isn't a full lecture and stop.
- `Read` of a PDF page fails → log the slide as `## ⚠️ 처리 실패 슬라이드 N` footer at the end of the markdown (matches the plugin's failure-footer convention), continue with the rest.
- Vault path doesn't exist → ask the user; do NOT create it without consent.
- A file already exists at the target `.md` path → tell the user and ask before overwriting (matches the plugin's confirm-on-update flow).

## Out of scope (Phase 2 Stage B)

- Hash compat with plugin (needs node-canvas + same pdfjs render path).
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
