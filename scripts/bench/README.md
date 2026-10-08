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
```

Options: `--model`, `--effort low|medium|high|xhigh|max`, `--concept-model` (default `haiku` for Claude), `--concept-effort` (default `low`), `--batch 8`, `--cap 1200` (transcript characters per slide), `--image-rule auto|text-only`, `--fewer-images`, `--bin /path/to/cli`, `--timeout 300`, `--title`, `--subject`, `--json` (machine-readable result).

The summary is a plain text file. The transcript is plain text (split evenly over the slides, like the URL source) or the plugin's transcript cache JSON (`{"v":1,"id":...,"segments":[[startMs,endMs,text],...]}`, in the plugin's cache folder under the note's `alt_local_id`): its timestamps align the transcript to the slides as the plugin does for a local import, and the result says which one ran (`transcript per slide`). With the Skill's scraper you can get them from an Alt URL: `node scripts/phase2/alt-scrape.mjs <url> > alt.json`, then save its `transcript` and `summary` fields.

Pass criteria (spec 5.6): 2.0 input tokens at most 50% of the 1.1.0 run on the same lecture, and a 1 to 5 rating of 10 random slides not lower than 1.1.0. The 1.1.0 Gemini baseline mode was removed with the Gemini provider in 2.0.0-beta.4; to compare against 1.1.0, run the bench from the 2.0.0-beta.3 source (commit `11987d1`).

`node test/test-bench.mjs` runs this harness against the fake CLIs in `test/fixtures/bin`.
