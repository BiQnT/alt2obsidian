# Changelog

Condensed history of Alt2Obs (named Alt2Obsidian before 2.0.0). Release notes and files are on [GitHub releases](https://github.com/BiQnT/alt2obsidian/releases); the betas 2.0.0-beta.1 to beta.4 and beta.6 had no release of their own. Design decisions and measurements are in the [2.0 spec](docs/specs/2.0.0-spec.md) (Korean).

## 2.0.2 (2026-10-08)

- **Documentation in English.** README.md is now in English, with the Korean version in README.ko.md. A full user guide in both languages (docs/user-guide.md, docs/user-guide.ko.md) covers setup, importing, the notes, the viewer, note checking, settings and troubleshooting. The privacy section lists every network service, account and file outside the vault the plugin uses. New pixel logo and banner.
- **Settings search on Obsidian 1.13 and later.** The settings tab is drawn from Obsidian's setting definitions, so its settings show up in Obsidian's settings search (also under English words such as model, effort, folder, Claude, Codex and Notion). Older Obsidian keeps the previous screen. On 1.13 and later the number fields save on Enter or when you leave the field, a value below the minimum is refused, and an emptied field goes back to its default.
- **Detaching a PDF** deletes the plugin's copy the way Obsidian's **Deleted files** setting says (system trash by default) instead of always moving it to the system trash.
- Timers use the window they run in, for popout windows.
- In-app texts corrected: what happens when a CLI call times out, and when the plugin copies Alt's database.
- Directory scan: type checking now matches the scanner (TypeScript 6 with Node types), `npm run lint` includes `lint:directory`, a local run of the scanner's source rules, and the settings rows use a CSS `gap` instead of `column-gap`.

## 2.0.1 (2026-10-07)

- **Plugin id back to `alt2obsidian`.** A directory admin confirmed that the id already listed can stay, so 2.0.0's id `alt-to-obs` was reverted. The name stays Alt2Obs and the features are those of 2.0.0. The plugin folder is `<vault>/.obsidian/plugins/alt2obsidian/` again.
- Updating from 1.x or a 2.0.0 beta is an in-place update: settings, records, hotkeys and open tabs stay.
- Coming from 2.0.0: on its first start 2.0.1 imports 2.0.0's settings and records once (read only, without old API keys, with the attachment records), then asks you to disable and delete 2.0.0. If its own `data.json` changed after 2.0.0's, it keeps that data and names the file it left out; the new command **Import settings from version 2.0.0 (alt-to-obs)** imports it anyway. An unreadable file is retried on every start.
- While 2.0.0 is still enabled, every start shows a warning and neither plugin turns lecture PDFs into the viewer. Once 2.0.0 is off, its open tabs are reopened as 2.0.1 views.
- View types and command ids are those of 1.x and the betas again (`alt2obsidian-sidebar`, `alt2obsidian-synced-viewer`, `alt2obsidian:...`); CSS classes stay `alt-to-obs-*`. Hotkeys set on 2.0.0's commands need to be set again.
- The `/alt2obs` Skill reads the settings from whichever plugin folder holds the current data.

## 2.0.0 (2026-10-07)

All changes of 2.0.0-beta.1 to beta.6, plus:

- **Renamed to Alt2Obs** for the community plugin directory, released under the id `alt-to-obs` (reverted in 2.0.1). It imported the settings and records of the `alt2obsidian` folder once.
- Unchanged by the rename: note markers (`alt2obs:*`, older `alt2obsidian:start/end`), frontmatter `source` values, the default folder `Alt2Obsidian/` and the cache folder name `alt2obsidian`.
- CSS classes became `alt-to-obs-*`. Commands were renamed to **Open sidebar**, **Import lecture note (local list or URL)** and **Open synced viewer (PDF + lecture .md)**.
- **PDF.js worker bundled into `main.js`**: a release is `main.js`, `manifest.json` and `styles.css` only.
- **Obsidian plugin guidelines**: passes the official ESLint rules (`npm run lint`), sentence case UI text, settings headings in Obsidian's style, the viewer's CSS in `styles.css`, note edits through `Vault.process`, a normalized save folder, and the viewer and attach commands shown only while a note or PDF is open.
- Minimum Obsidian version 1.7.2.

## 2.0.0-beta.6

- **Lecture kinds** in the Alt note list: `슬라이드`, `노트(전사만)`, `슬라이드(미첨부)`, `슬라이드(PDF 첨부)`, `슬라이드(저장된 PDF)`, with buttons that fit each kind. An import without a slide PDF stops before spending tokens and offers the choices instead of silently making a note without slides.
- **Summary notes** for lectures without slides: the transcript is cut into sections of about 12 minutes where the topic changes, each summarized with `[mm:ss]` times, plus an overview and concept notes in 3 calls for a 2-hour lecture. Memos follow their section on re-import.
- **PDF attach** from the vault or the computer, with **Alt 슬라이드로 바꾸기** (switch to Alt slides) and **첨부 해제** (detach). Only an unchanged copy made by the plugin ever goes to the trash.
- **Note verification** for summary notes, against the transcript sections.
- The Synced Viewer explains why a note without slides has no viewer and offers **PDF 첨부**.
- The `/alt2obs` Skill handles lectures without slides the same way.

## 2.0.0-beta.5 (2026-10-06)

- **Model choice per run** in the import and verification estimate panels, with **기본값으로 저장** (save as default).
- **Model names with versions**, such as `Opus 5.5 (claude-opus-5-5)`, read from the CLIs' own model lists. Aliases show the model they pointed to on the last run.
- **Opening a lecture PDF opens the Synced Viewer** (setting **강의 PDF를 열면 뷰어로 열기**), with **PDF만 보기** (PDF only) for the plain PDF.
- The CLI cards in the settings no longer collapse in Obsidian 1.14's separate settings window.
- **Academic terms in English** in commentary, overviews, concept notes and verification reasons. New concept notes are named `English (한국어)`; older `한국어 (English)` notes keep their names and are matched as the same concept.

## 2.0.0-beta.4

- Importing a slide lecture opens the **Synced Viewer**; **뷰어로 열기** (open in viewer) in the sidebar.
- **Scroll sync** follows the current slide of either pane, including large jumps.
- **관리 주석 숨기기** (hide managed comments) in Live Preview and the viewer.
- **Claude CLI and Codex CLI only**: Gemini API and Ollama were removed. Their tasks move to a logged-in Claude CLI (or an installed Codex CLI) with a notice; old keys stay in `data.json` until you remove them with **이전 API 키 지우기**.
- Provider, model and effort as dropdowns; empty values were filled once with the task defaults.
- Writing rules for commentary, concept notes and overviews (one tone, no filler, consistent concept names).

## 2.0.0-beta.3

- **New folder layout**: `Lectures/`, `Concepts/`, `Verification/`, `Attachments/` under each subject, and the command **Migrate 1.x vault layout**.
- **Note verification** of your own notes (vault file, Notion MCP or paste) against the slides and the transcript, with `맞음` / `틀림` / `근거 없음` / `전사 불확실` verdicts and missing-slide candidates.
- **Key diagram images** saved to `Attachments/` and embedded in the commentary.
- Exam summaries removed (Alt's quiz and flashcard plugins cover them); existing `Exam/` files stay.

## 2.0.0-beta.2

- **Alt note list**: lectures of the Alt desktop app on this computer, through Alt's local API or a copy of its database, with search, status chips and a guessed subject. Share links became the fallback.
- **Transcript aligned to slides** by a script, stored in `alt_alignment`.
- **Transcript panel** in the Synced Viewer.
- **Linking** a 1.x or share link note to its Alt lecture, only after you confirm.

## 2.0.0-beta.1

- **Generation through your Claude Code or Codex CLI**, no API key.
- Provider, model and effort per task, with the presets `절약` (saving) and `품질` (quality).
- **Fewer tokens**: slides sent in batches, no model call for cover, contents and closing slides or duplicate animation steps, images only for diagram slides, a compressed transcript per slide, and a shared prompt prefix the CLI can cache.
- **Re-import** reuses the commentary of unchanged slides.
- **Estimate before import**, a token cap per lecture, progress and cancel.
- **Usage record** in the note (`alt2obs_usage`) and in the settings.

## 1.x

Alt2Obsidian 1.0.0 (2026-03-25) and 1.1.0 (2026-05-04) generated notes with the Gemini API (or a local Ollama model) from public Alt share links. Use [1.1.0](https://github.com/BiQnT/alt2obsidian/releases/tag/1.1.0) if you need that workflow.
