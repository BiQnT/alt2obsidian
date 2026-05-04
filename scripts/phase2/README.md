# Phase 2 Stage A — Claude Code Skill MVP

Skill that imports an Alt lecture into the Obsidian vault using Claude Code Max's session vision instead of the plugin's Gemini call. Output is byte-compatible with the Alt2Obsidian 1.1.0 plugin's page-anchored format — Synced Viewer works on it, regen preserves your `> [!note] 내 메모` callouts.

## Files

- `alt-scrape.mjs` — pure Node Alt URL scraper. Port of `src/scraper/{AltScraper,RscParser}.ts` with no Obsidian deps. Reads an `https://altalt.io/note/<id>` URL, prints metadata JSON to stdout: `{title, summary, pdfUrl, transcript, noteId, createdAt, parseQuality}`.
- `SKILL.md` — orchestration. Drives Claude Code through scrape → download PDF → read each slide via `Read(pages: "N-N")` → write Korean commentary → assemble page-anchored markdown → write to vault.

## Install

```bash
mkdir -p ~/.claude/skills/alt2obs
ln -sf "$(pwd)/scripts/phase2/SKILL.md" ~/.claude/skills/alt2obs/SKILL.md
```

(Or copy if you don't want a symlink.) The Skill is then available globally to Claude Code; project-local discovery would need `.claude/skills/alt2obs/SKILL.md` inside the target project (`.claude/` is git-ignored in this repo).

## Use

```
/alt2obs https://altalt.io/note/b7472c41-…  subject=CSED232  title=8강-claude
```

Vault path is auto-detected from `~/Library/Application Support/obsidian/obsidian.json` if a single vault is configured; otherwise the Skill asks.

## Why Phase 2 Stage A only

The full plan (`.omc/plans/alt2obsidian-page-anchored-redesign.md`) calls for `packages/core` + `packages/cli` + npm-publish + `requestUrl` decoupling — multi-week work. Stage A skips the refactor and gets a working Claude-Code import path on disk in one session. Stage B is the real monorepo restructure, scheduled per user when they're ready.

## Hash caveat

Skill computes `SHA-1("{noteId}:{slide}").slice(0,8)`. Plugin computes `SHA-1(rendered_PNG_bytes).slice(0,8)`. Both produce 8-hex hashes that are **deterministic within their respective tool**, but the two tools' hashes don't match for the same lecture. Implication: if you import a lecture via Skill, then later re-import it via the plugin, every slide surfaces as `slideDrift` once (memos still preserved through the N-match-with-drift branch). Stage B will share the plugin's hash function via a node-canvas render path so the two are interchangeable.
