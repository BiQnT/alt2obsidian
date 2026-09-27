// Skill-side concept wikilink CLI. Runs the plugin's linkConceptNames
// (src/core/markdown.ts) over slide commentary files.
//
// Usage: node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> <file>...
// Rewrites each file in place with concept names wrapped in [[...]].

import { readFile, writeFile } from "node:fs/promises";
import { linkConceptNames } from "../../src/core/markdown";
import { fail } from "./cli-common";

async function main(): Promise<void> {
  const [namesFile, ...files] = process.argv.slice(2);
  if (!namesFile || files.length === 0) {
    process.stderr.write("Usage: node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> <file>...\n");
    process.exit(2);
  }
  const names: unknown = JSON.parse(await readFile(namesFile, "utf8"));
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new Error("concept names file must be a JSON array of strings");
  }
  for (const file of files) {
    await writeFile(file, linkConceptNames(await readFile(file, "utf8"), names));
  }
}

main().catch((e: unknown) => fail(e, "link-concepts"));
