// Optional real deck for the CLI tests: the PDF path given on the command
// line, else the first PDF in Alt's local slide storage copied to a temp dir
// (the storage folder is only read), else null.

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ALT_SLIDES = join(homedir(), "Library/Application Support/alt/data/storage/slides");

export function optionalRealDeck() {
  if (process.argv[2]) return { pdf: process.argv[2], label: process.argv[2], cleanup: () => {} };
  let name;
  try {
    name = readdirSync(ALT_SLIDES).find((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    return null;
  }
  if (!name) return null;
  const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-deck-"));
  const pdf = join(dir, "deck.pdf");
  copyFileSync(join(ALT_SLIDES, name), pdf);
  return { pdf, label: `Alt deck "${name}"`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
