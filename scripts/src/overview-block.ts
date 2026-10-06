// Skill-side overview block CLI. Builds the "## 📋 전체 요약" section exactly
// as the plugin does (src/core/markdown.ts): headings demoted one level,
// concept names linked, wrapped in the overview markers.
//
// Usage: node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile] [--known <knownNamesJsonFile>]
// <conceptNamesJsonFile> holds a JSON array of concept names; the known names
// (concept notes already in the vault) retarget links written under another
// name. Prints the section markdown ("" for an empty summary).

import { readFile } from "node:fs/promises";
import { buildOverviewSection } from "../../src/core/markdown";
import { fail } from "./cli-common";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const k = args.indexOf("--known");
  const knownFile = k >= 0 ? args[k + 1] : undefined;
  if (k >= 0) args.splice(k, 2);
  const [summaryFile, namesFile] = args;
  if (!summaryFile || (k >= 0 && !knownFile)) {
    process.stderr.write("Usage: node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile] [--known <knownNamesJsonFile>]\n");
    process.exit(2);
  }
  const summary = await readFile(summaryFile, "utf8");
  const read = async (file: string | undefined): Promise<string[]> => {
    const names: unknown = file ? JSON.parse(await readFile(file, "utf8")) : [];
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
      throw new Error("concept names file must be a JSON array of strings");
    }
    return names;
  };
  process.stdout.write(buildOverviewSection(summary, await read(namesFile), await read(knownFile)));
}

main().catch((e: unknown) => fail(e, "overview-block"));
