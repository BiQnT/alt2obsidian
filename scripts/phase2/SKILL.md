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
tags: [<subject lowercased>]
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

## Error handling

- `alt-scrape.mjs` exits 1 with stderr message → relay to user, stop.
- `parseQuality: "partial"` or `pdfUrl: null` → tell user the Alt note isn't a full lecture and stop.
- `Read` of a PDF page fails → log the slide as `## ⚠️ 처리 실패 슬라이드 N` footer at the end of the markdown (matches the plugin's failure-footer convention), continue with the rest.
- Vault path doesn't exist → ask the user; do NOT create it without consent.
- A file already exists at the target `.md` path → tell the user and ask before overwriting (matches the plugin's confirm-on-update flow).

## Out of scope (Phase 2 Stage B)

- Concept extraction into separate `Concepts/<name>.md` files. Stage A inlines `[[Concept]]` wikilinks but does not produce concept notes. (Plugin does both.)
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
