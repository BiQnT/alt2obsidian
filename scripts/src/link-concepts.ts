// Skill-side concept wikilink CLI. Runs the plugin's linkConceptNames
// (src/core/markdown.ts) over slide commentary files.
//
// Usage: node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> [--known <knownNamesJsonFile>] <file>...
// Rewrites each file in place with concept names wrapped in [[...]]. The
// known names (concept notes already in the vault) retarget links the model
// wrote to one of them under another name.

import { readFile, writeFile } from "node:fs/promises";
import { linkConceptNames } from "../../src/core/markdown";
import { fail } from "./cli-common";

async function readNames(file: string): Promise<string[]> {
  const names: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new Error("concept names file must be a JSON array of strings");
  }
  return names;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const k = args.indexOf("--known");
  const knownFile = k >= 0 ? args[k + 1] : undefined;
  if (k >= 0) args.splice(k, 2);
  const [namesFile, ...files] = args;
  if (!namesFile || files.length === 0 || (k >= 0 && !knownFile)) {
    process.stderr.write("Usage: node scripts/phase2/link-concepts.mjs <conceptNamesJsonFile> [--known <knownNamesJsonFile>] <file>...\n");
    process.exit(2);
  }
  const names = await readNames(namesFile);
  const known = knownFile ? await readNames(knownFile) : [];
  for (const file of files) {
    await writeFile(file, linkConceptNames(await readFile(file, "utf8"), names, known));
  }
}

main().catch((e: unknown) => fail(e, "link-concepts"));
