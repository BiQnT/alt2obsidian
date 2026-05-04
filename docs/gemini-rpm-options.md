# Gemini Free-Tier RPM — Options & Workarounds

**Last updated:** 2026-05-04

The Alt2Obsidian plugin's per-slide path makes one Gemini API call per slide image. With a 30-slide deck and free-tier `gemini-2.5-flash` at ~5 RPM, a single import can stretch to 6+ minutes and burn most of the free quota. This document lists every legitimate way to avoid that, ranked by recommendation.

> **Why "legitimate"?** A common temptation is to scrape Google's Gemini chat web UI (gemini.google.com) for free unlimited use. We **do not** recommend or implement this — see the bottom of this doc.

## Free-tier reality (as of 2026-05-04)

Google has stopped publishing exact rate-limit numbers on their public docs and instead routes you to AI Studio's per-account dashboard. Reported community values for the free tier:

| Model | RPM (reported) | RPD (reported) | Multimodal |
|---|---|---|---|
| `gemini-2.5-flash` | ~5–15 (variable) | ~250 | ✅ |
| `gemini-2.5-flash-lite` | ~30 | ~1,000 | ✅ (lower quality) |
| `gemini-1.5-flash` (legacy) | ~15 | ~1,500 | ✅ |
| `gemma-3-27b-it` | ~30 | (not published) | ✅ Gemma 3 is multimodal |
| `gemma-3-12b-it` | ~30 | (not published) | ✅ |
| `gemma-3-4b-it` | ~30 | (not published) | ✅ |

Source: Google AI for Developers Forum, [Gemma 3 27b rate limits thread](https://discuss.ai.google.dev/t/gemma-3-27b-rate-limits/73700) (Google staff: "Gemma is free of cost, even if you use paid tier the rate limit, context window will remain same"). Specific numbers should be verified at <https://aistudio.google.com/app/usage> for your account.

## Workarounds — ranked

### 1. **Switch to Gemma 3 (recommended for free use)** — 0 minutes

Gemma 3 (Google's open model family) is served via the **same** AI Studio API endpoint (`generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`) with the **same** `inlineData` multimodal format the plugin already uses.

**No code change required** — change the model name in plugin settings:

> Settings → Alt2Obsidian → 모델명 → `gemma-3-27b-it` (or `gemma-3-12b-it` / `gemma-3-4b-it`)

Trade-offs vs `gemini-2.5-flash`:
- ✅ ~6× higher RPM on the free tier (≈30 vs ≈5)
- ✅ Same multimodal API surface
- ✅ Free regardless of paid tier
- ⚠️ Slightly lower image-understanding quality (Gemma 3 is open-weights and not tuned as aggressively as Flash)
- ⚠️ Korean-Korean fluency about on par; English-Korean code-switching slightly less polished

For a typical 30-slide lecture, `gemma-3-27b-it` should complete in ~2 minutes without 429s. Drop to `gemma-3-12b-it` if 27B latency hurts; drop to `gemma-3-4b-it` for speed at minor quality cost.

### 2. **Phase 2 Stage A Skill (Claude Code Max)** — 0 minutes setup

Already shipped (`scripts/phase2/SKILL.md`, installed at `~/.claude/skills/alt2obs/`). Uses Claude Code's session vision instead of any Google API. Free for Claude Code Max subscribers; quality is generally higher than Gemini Flash for Korean academic commentary.

```
/alt2obs <alt-url> subject=<...> title=<...>
```

Trade-off: hashes don't match the plugin's PNG-bytes hashes (cross-tool re-import surfaces every section as `slideDrift` once). Stage B (monorepo + node-canvas) will fix this.

### 3. **Multi-key rotation** — 5 minutes

If you have multiple Google accounts, register a free API key on each and configure them all. The plugin (after WS2.B in [phase2-stageb-and-concepts.md](../.omc/plans/phase2-stageb-and-concepts.md)) accepts a comma-separated list:

> Settings → API 키 → `AIza...keyA, AIza...keyB, AIza...keyC`

Provider rotates round-robin and falls through on 429. Three keys × ~5 RPM = ~15 effective RPM, comparable to a Tier 1 paid account at $0 cost. Operational pain: you maintain N free accounts.

### 4. **Paid Gemini API (Tier 1)** — 10 minutes, ≈ $0.01/lecture

Register a payment method at <https://aistudio.google.com/app/billing>. The free-tier-vs-Tier-1 jump is dramatic:

| | Free | Tier 1 (after card) |
|---|---|---|
| `gemini-2.5-flash` RPM | ~5–15 | 1,000 |
| `gemini-2.5-flash` RPD | ~250 | 10,000 |

A 30-slide lecture: ~$0.007 (Gemini 2.5 Flash, image input + ~1.5K output tokens × 30 slides). One semester of import (e.g., 100 lectures): ~$0.70.

Cheapest reliable path if you don't mind a credit card. RPM ~1000 means you'll never wait.

### 5. **Ollama local** — 30 minutes setup

Run a vision-capable open model locally. After WS2.C in the phase2 plan, the plugin's settings will have a Ollama option again:

- Endpoint: `http://localhost:11434`
- Recommended models (multimodal, run on Apple Silicon or NVIDIA GPU):
  - `llama3.2-vision:11b` — best quality at 11B
  - `gemma3:4b` (text-only fallback if vision quality insufficient)

Trade-offs:
- ✅ Free, unlimited, offline
- ✅ Privacy — slides never leave your machine
- ⚠️ Quality slightly below cloud Flash/Gemma
- ⚠️ Needs decent hardware (Apple M-series 16GB+ or NVIDIA 8GB+)
- ⚠️ Slower than cloud in wall time

## Why **NOT** Gemini chat web-UI scraping

You may have seen people use the Gemini chat at <https://gemini.google.com> for "unlimited" generation. We deliberately do not implement this:

1. **TOS violation** — Google's [Generative AI Additional Terms](https://policies.google.com/terms/generative-ai/use-policy) prohibits automated/programmatic access to consumer products (the chat is consumer; the API is the supported developer surface). Account suspension risk is real.
2. **Frontend instability** — The chat UI ships JS bundle changes weekly. Scrapers break silently; you'd be debugging integration drift instead of studying.
3. **Anti-bot defenses** — Captcha, Cloudflare challenges, fingerprinting. A scraper works for a day, then needs maintenance.
4. **No structured JSON output** — Chat is freeform text. The plugin's `generateJSON` path needs reliable schema-conformant output, which the chat doesn't provide.
5. **All cheaper paths above exist** — Gemma 3 + multi-key rotation gets you ~6× the RPM at zero risk. Paid Tier 1 costs less than a coffee per semester.

If you genuinely need free unlimited multimodal commentary, **option 2 (Phase 2 Stage A Skill via Claude Code Max)** is the legitimate analog — it uses your existing CC subscription quota, not Google's.

## Quick decision tree

```
Need to import RIGHT NOW with free quota?
  └─ Switch to gemma-3-27b-it in settings (option 1). Done in 30 seconds.

Doing this regularly (≥ 2 lectures/day)?
  └─ Pay $5 for Tier 1, never think about quota again (option 4).

Have multiple Google accounts already?
  └─ Multi-key rotation (option 3) once it lands in the plugin.

Privacy-sensitive / want offline?
  └─ Ollama local (option 5) once it lands.

Already on Claude Code Max?
  └─ Phase 2 Stage A Skill (option 2). Already works.
```

## Settings UI hints (after WS2.B / WS2.C land)

The settings tab will be updated to surface these options:
- 모델명 default unchanged (`gemini-2.5-flash`), but description will mention `gemma-3-27b-it` as a recommended free-tier alternative.
- API 키 description will mention comma-separated multi-key support.
- Provider dropdown will re-include Ollama.
