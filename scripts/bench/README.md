# Import benchmark (spec 5.6)

Runs a whole lecture import headless, with the same pipeline code as the plugin, and prints the numbers the 2.0 acceptance criteria use: calls, input tokens, cached input tokens (cache hit rate), output tokens, images sent, and wall time. Nothing is written to a vault; `--out` saves the generated note so you can rate its quality.

Needs `npm install` (esbuild bundles `bench-core.ts` on the fly) and `pdftoppm` (`brew install poppler`) for slide renders.

```bash
# Plan and estimate only, no LLM call
node scripts/bench/bench.mjs --pdf deck.pdf --transcript transcript.txt --dry-run

# 2.0 Claude CLI
node scripts/bench/bench.mjs --pdf deck.pdf --transcript transcript.txt --summary alt-summary.md \
  --provider claude-cli --effort medium --out /tmp/claude.md

# 2.0 Codex CLI
node scripts/bench/bench.mjs --pdf deck.pdf --transcript transcript.txt --summary alt-summary.md \
  --provider codex-cli --effort medium --out /tmp/codex.md

# 1.1.0 baseline: Gemini, one multimodal call per slide plus the summary passes
GEMINI_API_KEY=... node scripts/bench/bench.mjs --pdf deck.pdf --transcript transcript.txt \
  --summary alt-summary.md --provider gemini --model gemini-2.5-flash
```

Options: `--model`, `--effort low|medium|high|xhigh|max`, `--concept-model` (default `haiku` for Claude), `--concept-effort` (default `low`), `--batch 8`, `--cap 600` (transcript characters per slide), `--image-rule auto|text-only`, `--fewer-images`, `--bin /path/to/cli`, `--timeout 300`, `--title`, `--subject`, `--json` (machine-readable result).

The transcript and summary are plain text files. With the Skill's scraper you can get them from an Alt URL: `node scripts/phase2/alt-scrape.mjs <url> > alt.json`, then save its `transcript` and `summary` fields.

Pass criteria (spec 5.6): 2.0 input tokens at most 50% of the 1.1.0 run on the same lecture, and a 1 to 5 rating of 10 random slides not lower than 1.1.0. The Gemini provider also prints a 1.1.0 estimate (same prompt builders as 1.1.0, even-split raw transcript, one 1024px image per slide), so `--dry-run --provider gemini` gives the baseline without an API key. The Gemini baseline reports Gemini's own token counts (`usageMetadata`), which use a different tokenizer from Claude and Codex, so compare orders of magnitude and the per-slide cost rather than exact numbers.

`node test/test-bench.mjs` runs this harness against the fake CLIs in `test/fixtures/bin`.
