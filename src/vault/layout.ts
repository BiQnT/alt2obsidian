// Vault folder layout (spec 4.5, D3). Pure: no obsidian import, so the
// plugin, the migration planner and the Skill CLIs build the same paths.
//
//   <base>/<Subject>/Lectures/<lecture>.md + <lecture>.pdf
//   <base>/<Subject>/Concepts/<concept>.md
//   <base>/<Subject>/Verification/<lecture> verification.md
//   <base>/<Subject>/Attachments/<lecture>-<page>.png
//
// 1.x kept the lecture note and its PDF directly in <base>/<Subject>/ and
// exam summaries in <base>/Exam/ (left untouched: they are not generated
// any more, spec G5).

import { sanitizeFilename } from "../utils/helpers";

export const LECTURES_DIR = "Lectures";
export const CONCEPTS_DIR = "Concepts";
export const VERIFICATION_DIR = "Verification";
export const ATTACHMENTS_DIR = "Attachments";
/** 1.x exam summaries, never moved or written. */
export const EXAM_DIR = "Exam";

/** Folder names inside a subject folder that are not lectures. */
export const SUBJECT_SUBDIRS = [LECTURES_DIR, CONCEPTS_DIR, VERIFICATION_DIR, ATTACHMENTS_DIR];

function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export function subjectFolder(base: string, subject: string): string {
  return join(base, sanitizeFilename(subject));
}

export function lecturesFolder(base: string, subject: string): string {
  return join(subjectFolder(base, subject), LECTURES_DIR);
}

/** `<base>/<Subject>/Lectures/<stem>.md`; `stem` is sanitized. */
export function lecturePath(base: string, subject: string, stem: string): string {
  return join(lecturesFolder(base, subject), `${sanitizeFilename(stem)}.md`);
}

export function conceptsFolder(base: string, subject: string): string {
  return join(subjectFolder(base, subject), CONCEPTS_DIR);
}

export function verificationPath(base: string, subject: string, lectureStem: string): string {
  return join(subjectFolder(base, subject), VERIFICATION_DIR, `${sanitizeFilename(lectureStem)} verification.md`);
}

export function attachmentPath(base: string, subject: string, lectureStem: string, page: number): string {
  return join(subjectFolder(base, subject), ATTACHMENTS_DIR, `${sanitizeFilename(lectureStem)}-${page}.png`);
}

/** File name without folder and extension. */
export function stemOf(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.[^.]+$/, "");
}

/**
 * The subject folder a lecture note lives in: the parent of `Lectures/`
 * for the 2.0 layout, else the note's own folder (1.x, or a note the user
 * moved). Used for the sibling Verification and Attachments folders.
 */
export function subjectFolderOfNote(notePath: string): string {
  const parts = notePath.split("/");
  parts.pop();
  if (parts.length > 0 && parts[parts.length - 1] === LECTURES_DIR) parts.pop();
  return parts.join("/");
}

/** Verification note next to a lecture note: `<subject folder>/Verification/<stem> verification.md`. */
export function verificationPathForNote(notePath: string): string {
  return join(subjectFolderOfNote(notePath), VERIFICATION_DIR, `${stemOf(notePath)} verification.md`);
}

/** Diagram image of a lecture note's page: `<subject folder>/Attachments/<stem>-<page>.png`. */
export function attachmentPathForNote(notePath: string, page: number): string {
  return join(subjectFolderOfNote(notePath), ATTACHMENTS_DIR, `${stemOf(notePath)}-${page}.png`);
}
