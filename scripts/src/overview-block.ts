// Skill-side overview block CLI. Builds the "## 📋 전체 요약" section exactly
// as the plugin does (src/core/markdown.ts): headings demoted one level,
// concept names linked, wrapped in the overview markers.
//
// Usage: node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile]
// <conceptNamesJsonFile> holds a JSON array of concept names. Prints the
// section markdown ("" for an empty summary).

import { readFile } from "node:fs/promises";
import { buildOverviewSection } from "../../src/core/markdown";
import { fail } from "./node-pdf";

async function main(): Promise<void> {
  const [summaryFile, namesFile] = process.argv.slice(2);
  if (!summaryFile) {
    process.stderr.write("Usage: node scripts/phase2/overview-block.mjs <summaryFile> [conceptNamesJsonFile]\n");
    process.exit(2);
  }
  const summary = await readFile(summaryFile, "utf8");
  const names: unknown = namesFile ? JSON.parse(await readFile(namesFile, "utf8")) : [];
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
    throw new Error("concept names file must be a JSON array of strings");
  }
  process.stdout.write(buildOverviewSection(summary, names));
}

main().catch((e: unknown) => fail(e, "overview-block"));
