# Phase 2 Stage A — Claude Code Skill MVP

Skill that imports an Alt lecture into the Obsidian vault using Claude Code Max's session vision instead of the plugin's Gemini call. Output is byte-compatible with the Alt2Obsidian 1.1.0 plugin's page-anchored format — Synced Viewer works on it, regen preserves your `> [!note] 내 메모` callouts.

## Files

- `alt-scrape.mjs` — pure Node Alt URL scraper. Port of `src/scraper/{AltScraper,RscParser}.ts` with no Obsidian deps. Reads an `https://altalt.io/note/<id>` URL, prints metadata JSON to stdout: `{title, summary, pdfUrl, transcript, noteId, createdAt, parseQuality}`.
- `slide-hashes.mjs`: per-page slide hashes for a PDF, `node scripts/phase2/slide-hashes.mjs <pdfPath> <sourceId>` prints `{"pages":[{"page":1,"hash":"xxxxxxxx","textChars":123}, ...]}`. Generated from `scripts/src/slide-hashes.ts` by `npm run build:scripts` (also part of `npm run build`); it imports the plugin's `src/core/slideHash.ts`, so hashes are identical to the plugin's. `pdfjs-dist` is loaded from the repo's `node_modules`, so run `npm install` once.
- `lecture-material.mjs`: the PDF excerpt for `prompts/summary-enhance-material.md`, computed by the plugin's `src/core/lectureMaterial.ts`. `node scripts/phase2/lecture-material.mjs <pdfPath> <seedTextFile>` prints `{"material":{...}}` or `{"material":null}`.
- `overview-block.mjs`: the `## 📋 전체 요약` section built by the plugin's `src/core/markdown.ts` (headings demoted one level, concept names linked). `node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile]`.
- `link-concepts.mjs`: wraps concept names in `[[...]]` with the plugin's `linkConceptNames`. `node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> <file>...` rewrites the files in place.
- `merge-note.mjs`: re-import merge with the plugin's `src/core/merge.ts` (memos follow their slides, text outside managed blocks kept, deleted slides orphaned). `node scripts/phase2/merge-note.mjs <existingNote> <newNote>` prints the merged note; with `--summary` it prints the change summary as JSON instead.
- `SKILL.md` — orchestration. Drives Claude Code through scrape → download PDF → read each slide via `Read(pages: "N-N")` → write Korean commentary → assemble page-anchored markdown → write to vault.

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

The full plan (`.omc/plans/alt2obsidian-page-anchored-redesign.md`) calls for `packages/core` + `packages/cli` + npm-publish + `requestUrl` decoupling — multi-week work. Stage A skips the refactor and gets a working Claude-Code import path on disk in one session. Stage B is the real monorepo restructure, scheduled per user when they're ready.

## Hash compatibility

The plugin and the Skill compute the same slide hash from the same code in `src/core/slideHash.ts`: `sha1(normalized page text)` truncated to 8 hex, with no page number, so inserting or deleting a slide does not change any other slide's hash and memos follow their slides on re-import. Pages without a text layer use `sha1(noteId + ":" + page)`. A lecture imported with one tool and re-imported with the other matches every slide by hash.

Notes written by 1.x (plugin PNG-byte hash or the old Skill `sha1(noteId:page)` hash) show every slide as `slideDrift` once on their first re-import. Memos are preserved through the N-match-with-drift branch, and hashes are stable afterwards.

`node test/test-slide-hash.mjs [pdfPath]` checks that the committed CLI bundles are fresh and that the hash output is deterministic and follows the rule; `node test/test-skill-clis.mjs [pdfPath]` checks that `lecture-material`, `overview-block` and `link-concepts` match the plugin code, and `node test/test-merge.mjs` checks `merge-note` against the plugin merge. The tests use the committed fixture `test/fixtures/text-deck.pdf` and also check a real Alt deck when one is present.
