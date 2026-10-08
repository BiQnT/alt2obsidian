# Changelog

Condensed history of Alt2Obs (named Alt2Obsidian before 2.0.0). Release notes and files are on [GitHub releases](https://github.com/BiQnT/alt2obsidian/releases); the betas 2.0.0-beta.1 to beta.4 and beta.6 had no release of their own. Design decisions and measurements are in the [2.0 spec](docs/specs/2.0.0-spec.md) (Korean).

## 2.0.2 (2026-10-08)

- **Notes that read less like AI output.** Slide commentary, summary note sections, overviews and concept notes are written in the plain "~다" style, with academic terms in English. The commentary explains why, keeps the professor's examples and warnings from the transcript, structures itself with bold labels, nested bullets, small tables and inline code, adds a callout only where it helps (at most one per slide), does not talk about "this slide" and avoids a list of Korean AI tells. Slides with a lot to explain may run to 900 characters (diagram slides 1000); simple ones stay short. The lines written without a model call for cover, contents, closing and repeated animation slides no longer talk about the slide either, and a contents slide lists its items (without the PDF's running footers, page counters and bullet marks). More closing and Q&A slides get that line without a model call ("Thank you! Questions?", "감사합니다. 질문?"), and a short slide the model does explain (a closing, contents or summary slide with under 80 characters of text and no image) may answer in one sentence, transcript or not, instead of being asked again and listed as failed. Concept notes avoid the same list of AI tells.
- **Restyling an existing note.** A re-import keeps the commentary of unchanged slides as it is, so a note made before 2.0.2 mixes the older "~합니다" slides with the new "~다" ones. To rewrite a whole note in the new style, turn off **바뀐 슬라이드만 다시 생성** (regenerate only changed slides) for that import; summary notes regenerate every section the same way. With the setting off, a slide that fails now keeps its earlier commentary too; before, that commentary was lost.
- **More of the lecture in each slide's transcript.** **슬라이드당 전사 상한 (자)** (transcript cap per slide) now defaults to 1200 characters instead of 600. At 600 much of the professor's own explanations and examples was cut; in real runs 1200 kept them for about 4% more input tokens (8 to 10% in the estimate) and the same output. A saved 600, the old default, is moved to 1200 once on the first start of 2.0.2 (also when 2.0.0's settings are imported); any other value stays, and a 600 you set afterwards is kept. The Skill's `prep.mjs` and the benchmark use 1200 too.
- **A shorter overview.** The block at the top of a note is now 개요 (what the lecture covers and where it sits), 핵심 개념 (one-line definitions) and 흐름 (the topics with their slide or section ranges); the details stay in the slide commentary. The Skill's slide imports, which write their overview from the transcript or the PDF text, get the same shape and style, with page ranges such as `(p.3~5)` where the PDF has text, and extract their concept notes from that overview together with the summary, transcript and PDF text it was written from.
- **A full note where nothing else carries the details.** A lecture-level note (no slides and no transcript sections, or an Alt page read only in part) written from the transcript or the PDF text is the whole note, so it is not cut to an overview: 개요, 핵심 개념 and 상세 노트 with numbered topics in lecture order, in the same plain style, with bold labels, nested bullets, small tables, code, the professor's examples and cautions, 혼동하기 쉬운 점 where the lecture points one out, page ranges such as `(p.3~5)` on the topics where the PDF has text, at most two callouts and up to about 8000 characters. Its concept notes are extracted from the whole note.
- **An estimate closer to real output.** The output expected per generated slide was refitted on real runs (Claude CLI, sonnet, effort medium, reasoning included): about 1,000 tokens per slide instead of 420, diagram slides 1,480 instead of 620. The estimate before a run had been about half of the output the runs used; now it is within about 10% of it. Summary note sections count reasoning the same way, and a lecture-level note counts every call that writes the whole note (the pass that adds the PDF text too) at about 12,700 output tokens each. **강의당 토큰 상한** (token cap per lecture) is checked against this estimate before a run starts, so it now holds back the runs that would really go over it; a run that has started is not stopped at the cap.
- **Documentation in English.** README.md is now in English, with the Korean version in README.ko.md. A full user guide in both languages (docs/user-guide.md, docs/user-guide.ko.md) covers setup, importing, the notes, the viewer, note checking, settings and troubleshooting. The privacy section lists every network service, account and file outside the vault the plugin uses. New pixel logo and banner.
- **Settings search on Obsidian 1.13 and later.** The settings tab is drawn from Obsidian's setting definitions, so its settings show up in Obsidian's settings search (also under English words such as model, effort, folder, Claude, Codex and Notion). Older Obsidian keeps the previous screen. On 1.13 and later the number fields save on Enter or when you leave the field, a value below the minimum or with a fraction is refused, and an emptied field goes back to its default.
- **Claude Haiku 5.5 in the model lists**, as `Haiku 5.5 (claude-haiku-5-5)` with every effort level. The `haiku` alias's fallback name, shown until a run records what the alias resolved to, is Haiku 5.5 (기준일 2026-10), and a run's `claude-haiku-5-5` is shown as Haiku 5.5 in the settings and the Notion line even when Claude Code's model list was read before it listed Haiku 5.5. Haiku 4.5 stays selectable as an older model without effort levels. Saved settings stay as they are: `haiku` with effort low now runs Haiku 5.5 at low effort, and the estimate counts that level.
- **Detaching a PDF or switching to Alt slides** deletes the plugin's copy the way Obsidian's **Deleted files** setting says (system trash by default) instead of always moving it to the system trash. The confirmation now warns that this cannot be undone when Obsidian is set to delete files permanently.
- Timers use `window.setTimeout` in Obsidian and Node's timers under plain Node.
- In-app texts corrected: what happens when a CLI call times out, when the plugin copies Alt's database, and Alt's default data folder on Linux (`$XDG_CONFIG_HOME/alt`, else `~/.config/alt`).
- Directory scan: type checking now matches the scanner (TypeScript 6 with Node types), `npm run lint` includes `lint:directory`, a local run of the scanner's source rules, and the settings rows use a CSS `gap` instead of `column-gap`.
- The import benchmark (`scripts/bench`) also reads the plugin's transcript cache JSON and aligns it to the slides by its timestamps, like a local import.

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
