// "Migrate 1.x vault layout" (spec 4.5, G6). Pure planning plus an apply
// step that only moves files through the given `rename` (the plugin passes
// app.fileManager.renameFile, so Obsidian updates every link to a moved
// file). Nothing is deleted or overwritten:
//
// - A lecture note directly in <base>/<Subject>/ moves to
//   <base>/<Subject>/Lectures/, with its sibling <stem>.pdf.
// - Concepts/ stays where it is (same place in both layouts).
// - <base>/Exam/ (1.x exam summaries) is left untouched.
// - A note and its PDF are one unit: when either target is taken, both
//   stay and are reported. The PDF moves first, then the note; if the note
//   cannot move, the PDF is moved back.
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

export interface MigrationUnit {
  note: MigrationMove;
  pdf: MigrationMove | null;
}

export interface MigrationPlan {
  base: string;
  /** A note with its sibling PDF, moved together. */
  units: MigrationUnit[];
  /** Every move of `units` in order (note, then its PDF): the dry-run list. */
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
export const PDF_TAKEN_REASON = "PDF를 옮길 위치에 같은 이름의 파일이 있어 노트도 그대로 둠";

function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

/** Moves for every 1.x lecture note under `base`, collisions skipped. */
export function planLayoutMigration(baseFolder: string, files: VaultFileEntry[]): MigrationPlan {
  const base = trimSlashes(baseFolder);
  const prefix = base ? `${base}/` : "";
  // Case-insensitive: macOS and Windows vaults are.
  const taken = new Set(files.map((f) => f.path.toLowerCase()));
  // Sibling PDFs by lowercased path (".PDF" too).
  const pdfByLower = new Map(files.filter((f) => /\.pdf$/i.test(f.path)).map((f) => [f.path.toLowerCase(), f.path]));
  const plan: MigrationPlan = { base, units: [], moves: [], skipped: [], otherNotes: [], examFiles: 0 };
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
    const found = pdfByLower.get(`${prefix}${subject}/${stem}.pdf`.toLowerCase());
    const hasPdf = found !== undefined;
    const pdf = found ?? `${prefix}${subject}/${stem}.pdf`;
    const pdfTarget = `${prefix}${subject}/${LECTURES_DIR}/${pdf.slice(pdf.lastIndexOf("/") + 1)}`;
    const noteTaken = taken.has(target.toLowerCase());
    const pdfTaken = hasPdf && taken.has(pdfTarget.toLowerCase());
    if (noteTaken || pdfTaken) {
      plan.skipped.push({ from: f.path, to: target, reason: noteTaken ? COLLISION_REASON : PDF_TAKEN_REASON });
      if (hasPdf) plan.skipped.push({ from: pdf, to: pdfTarget, reason: pdfTaken ? COLLISION_REASON : NOTE_SKIPPED_REASON });
      continue;
    }
    const unit: MigrationUnit = { note: { from: f.path, to: target, kind: "note" }, pdf: hasPdf ? { from: pdf, to: pdfTarget, kind: "pdf" } : null };
    plan.units.push(unit);
    taken.add(target.toLowerCase());
    if (hasPdf) taken.add(pdfTarget.toLowerCase());
  }
  plan.moves = plan.units.flatMap((u) => (u.pdf ? [u.note, u.pdf] : [u.note]));
  return plan;
}

export interface MigrationIO {
  exists(path: string): boolean;
  ensureFolder(path: string): Promise<void>;
  /** Must update links (Obsidian: app.fileManager.renameFile). */
  rename(from: string, to: string): Promise<void>;
}

/**
 * Applies a plan, one note and PDF unit at a time. Existence is checked
 * again right before each unit (the vault may have changed since the dry
 * run): a taken target or a missing source skips the whole unit, never
 * overwriting. The PDF moves first, then the note; when the note cannot
 * move, the PDF is moved back, so a note and its PDF never end up apart.
 */
export async function applyLayoutMigration(plan: MigrationPlan, io: MigrationIO): Promise<MigrationResult> {
  const result: MigrationResult = { moved: [], skipped: [...plan.skipped] };
  const skipUnit = (u: MigrationUnit, reason: string, pdfReason = NOTE_SKIPPED_REASON) => {
    result.skipped.push({ from: u.note.from, to: u.note.to, reason });
    if (u.pdf) result.skipped.push({ from: u.pdf.from, to: u.pdf.to, reason: pdfReason });
  };
  for (const u of plan.units) {
    if (!io.exists(u.note.from)) {
      skipUnit(u, "원본 파일이 없어 건너뜀");
      continue;
    }
    if (io.exists(u.note.to)) {
      skipUnit(u, COLLISION_REASON);
      continue;
    }
    if (u.pdf && !io.exists(u.pdf.from)) {
      // The PDF went away since the dry run: the note moves alone.
      u.pdf = null;
    }
    if (u.pdf && io.exists(u.pdf.to)) {
      skipUnit(u, PDF_TAKEN_REASON, COLLISION_REASON);
      continue;
    }
    try {
      await io.ensureFolder(u.note.to.slice(0, u.note.to.lastIndexOf("/")));
    } catch (e) {
      skipUnit(u, `옮기지 못함: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (u.pdf) {
      try {
        await io.rename(u.pdf.from, u.pdf.to);
      } catch (e) {
        skipUnit(u, "PDF를 옮기지 못해 노트도 그대로 둠", `옮기지 못함: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
    }
    try {
      await io.rename(u.note.from, u.note.to);
    } catch (e) {
      const why = `옮기지 못함: ${e instanceof Error ? e.message : String(e)}`;
      if (u.pdf) {
        try {
          await io.rename(u.pdf.to, u.pdf.from);
          skipUnit(u, why, "노트를 옮기지 못해 PDF를 제자리로 되돌림");
        } catch (back) {
          result.moved.push(u.pdf);
          result.skipped.push({ from: u.note.from, to: u.note.to, reason: `${why}. PDF는 ${u.pdf.to}에 있고 되돌리지 못했습니다: ${back instanceof Error ? back.message : String(back)}` });
        }
      } else {
        skipUnit(u, why);
      }
      continue;
    }
    result.moved.push(u.note);
    if (u.pdf) result.moved.push(u.pdf);
  }
  return result;
}
