// Skill-side re-import merge CLI. Runs the plugin's merge (src/core/merge.ts),
// so memos, text outside the overview block and orphaned slides are handled
// exactly as in a plugin re-import.
//
// Usage: node scripts/phase2/merge-note.mjs <existingNote> <newNote> [--summary]
// Without --summary prints the merged note. With --summary prints a JSON
// change summary instead: {mode, reorders, insertions, deletions, drifts,
// confirmDeckReplacement, notes}. Exits 1 (message on stderr) when a
// page-anchored note would be replaced by a single-block note.

import { readFile } from "node:fs/promises";
import { mergeNote } from "../../src/core/merge";
import { fail } from "./cli-common";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const summaryOnly = args.includes("--summary");
  const [existingPath, nextPath] = args.filter((a) => a !== "--summary");
  if (!existingPath || !nextPath) {
    process.stderr.write("Usage: node scripts/phase2/merge-note.mjs <existingNote> <newNote> [--summary]\n");
    process.exit(2);
  }
  const result = mergeNote(await readFile(existingPath, "utf8"), await readFile(nextPath, "utf8"));
  if (summaryOnly) {
    const { merged: _merged, ...summary } = result;
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    process.stdout.write(result.merged);
  }
}

main().catch((e: unknown) => fail(e, "merge-note"));
