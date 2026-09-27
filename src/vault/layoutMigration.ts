// "Migrate 1.x vault layout" (spec 4.5, G6). Pure planning plus an apply
// step that only moves files through the given `rename` (the plugin passes
// app.fileManager.renameFile, so Obsidian updates every link to a moved
// file). Nothing is deleted or overwritten:
//
// - A lecture note directly in <base>/<Subject>/ moves to
//   <base>/<Subject>/Lectures/, with its sibling <stem>.pdf.
// - Concepts/ stays where it is (same place in both layouts).
// - <base>/Exam/ (1.x exam summaries) is left untouched.
// - A target that already exists is a collision: the move is skipped and
//   reported, and the note's PDF stays with the note.
// - Other markdown files in a subject folder (the user's own notes) stay.
// Running it again finds nothing to move: moved files are no longer
// directly in a subject folder.

import { EXAM_DIR, LECTURES_DIR, SUBJECT_SUBDIRS } from "./layout";

export interface VaultFileEntry {
  path: string;
  /** Markdown files: an Alt2Obsidian lecture note (from its frontmatter). */
  isLectureNote?: boolean;
}

export interface MigrationMove {
  from: string;
  to: string;
  kind: "note" | "pdf";
}

export interface MigrationSkip {
  from: string;
  to: string;
  reason: string;
}

export interface MigrationPlan {
  base: string;
  moves: MigrationMove[];
  skipped: MigrationSkip[];
  /** Markdown files in a subject folder that are not lecture notes (left in place). */
  otherNotes: string[];
  /** Files under <base>/Exam/, left in place. */
  examFiles: number;
}

export interface MigrationResult {
  moved: MigrationMove[];
  skipped: MigrationSkip[];
}

export const COLLISION_REASON = "옮길 위치에 같은 이름의 파일이 이미 있어 건너뜀";
export const NOTE_SKIPPED_REASON = "노트를 옮기지 않아 PDF도 그대로 둠";

function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

/** Moves for every 1.x lecture note under `base`, collisions skipped. */
export function planLayoutMigration(baseFolder: string, files: VaultFileEntry[]): MigrationPlan {
  const base = trimSlashes(baseFolder);
  const prefix = base ? `${base}/` : "";
  // Case-insensitive: macOS and Windows vaults are.
  const taken = new Set(files.map((f) => f.path.toLowerCase()));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const plan: MigrationPlan = { base, moves: [], skipped: [], otherNotes: [], examFiles: 0 };
  const skipped = new Set<string>(SUBJECT_SUBDIRS);

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length).split("/");
    if (rest[0] === EXAM_DIR) {
      plan.examFiles++;
      continue;
    }
    // Only files directly inside a subject folder: <Subject>/<file>.
    if (rest.length !== 2 || skipped.has(rest[0])) continue;
    const [subject, name] = rest;
    if (!name.toLowerCase().endsWith(".md")) continue;
    if (!f.isLectureNote) {
      plan.otherNotes.push(f.path);
      continue;
    }
    const stem = name.slice(0, -3);
    const target = `${prefix}${subject}/${LECTURES_DIR}/${name}`;
    const pdf = `${prefix}${subject}/${stem}.pdf`;
    const pdfTarget = `${prefix}${subject}/${LECTURES_DIR}/${stem}.pdf`;
    const hasPdf = byPath.has(pdf);
    if (taken.has(target.toLowerCase())) {
      plan.skipped.push({ from: f.path, to: target, reason: COLLISION_REASON });
      if (hasPdf) plan.skipped.push({ from: pdf, to: pdfTarget, reason: NOTE_SKIPPED_REASON });
      continue;
    }
    plan.moves.push({ from: f.path, to: target, kind: "note" });
    taken.add(target.toLowerCase());
    if (!hasPdf) continue;
    if (taken.has(pdfTarget.toLowerCase())) {
      plan.skipped.push({ from: pdf, to: pdfTarget, reason: COLLISION_REASON });
      continue;
    }
    plan.moves.push({ from: pdf, to: pdfTarget, kind: "pdf" });
    taken.add(pdfTarget.toLowerCase());
  }
  return plan;
}

export interface MigrationIO {
  exists(path: string): boolean;
  ensureFolder(path: string): Promise<void>;
  /** Must update links (Obsidian: app.fileManager.renameFile). */
  rename(from: string, to: string): Promise<void>;
}

/**
 * Applies a plan. Existence is checked again right before each move (the
 * vault may have changed since the dry run): a taken target or a missing
 * source is skipped and reported, never overwritten. A failed rename is
 * reported and the rest continues.
 */
export async function applyLayoutMigration(plan: MigrationPlan, io: MigrationIO): Promise<MigrationResult> {
  const result: MigrationResult = { moved: [], skipped: [...plan.skipped] };
  const skippedNotes = new Set<string>();
  for (const move of plan.moves) {
    const noteOfPdf = move.kind === "pdf" ? move.from.replace(/\.pdf$/, ".md") : null;
    if (noteOfPdf && skippedNotes.has(noteOfPdf)) {
      result.skipped.push({ from: move.from, to: move.to, reason: NOTE_SKIPPED_REASON });
      continue;
    }
    const skip = (reason: string) => {
      result.skipped.push({ from: move.from, to: move.to, reason });
      if (move.kind === "note") skippedNotes.add(move.from);
    };
    if (!io.exists(move.from)) {
      skip("원본 파일이 없어 건너뜀");
      continue;
    }
    if (io.exists(move.to)) {
      skip(COLLISION_REASON);
      continue;
    }
    try {
      await io.ensureFolder(move.to.slice(0, move.to.lastIndexOf("/")));
      await io.rename(move.from, move.to);
      result.moved.push(move);
    } catch (e) {
      skip(`옮기지 못함: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
