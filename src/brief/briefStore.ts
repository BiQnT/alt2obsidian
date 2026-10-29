// Reading and writing lecture briefs (2.1.0 spec 4.4) through a small file
// interface, so the same steps run in the plugin (the vault, written with
// vault.process / create) and in the Skill CLI (the file system). No
// obsidian import.

import { briefPathForNote, stemOf, subjectBriefPath, subjectFolderOfNote } from "../vault/layout";
import { fmString, parseLectureNote, readFrontmatter } from "./lectureNote";
import {
  BriefScript,
  BriefStatus,
  briefChatBody,
  briefStatus,
  buildBriefScript,
  oneLineOf,
  planBriefUpdate,
  planSubjectBriefUpdate,
  SubjectBriefEntry,
} from "./lectureBrief";

export interface BriefFiles {
  /** A file's text, null when there is none. */
  read(path: string): Promise<string | null>;
  /** Creates or replaces a file (and its folder). */
  write(path: string, text: string): Promise<void>;
  /** Paths of the markdown files directly in a folder. */
  list(folder: string): Promise<string[]>;
}

export interface BriefUpdate {
  path: string;
  /** written: (re)written now; same: already up to date; edited: the user's edits kept. */
  result: "written" | "same" | "edited";
}

/**
 * Builds a lecture note's brief (script part) and writes it when that is
 * what spec 4.4 says; then, when it was written, the subject brief again.
 * `force` is the user's "새로 만들기" / "다시 만들기".
 */
export async function updateLectureBrief(files: BriefFiles, notePath: string, opts: { today: string; force?: boolean }): Promise<BriefUpdate> {
  const noteText = await files.read(notePath);
  if (noteText === null) throw new Error(`강의 노트를 찾지 못했습니다: ${notePath}`);
  const script = await buildBriefScript(notePath, noteText);
  const path = briefPathForNote(notePath);
  const decision = await planBriefUpdate(await files.read(path), script, opts);
  if (decision.action === "keep") return { path, result: decision.reason };
  await files.write(path, decision.text);
  await updateSubjectBrief(files, notePath, script.subject, opts.today);
  return { path, result: "written" };
}

export interface LectureBriefState {
  path: string;
  status: BriefStatus;
  script: BriefScript;
  /** What a question sends (no frontmatter, no title); null without a file. */
  body: string | null;
}

/** The brief of a lecture note as the question panel sees it (nothing is written). */
export async function readLectureBrief(files: BriefFiles, notePath: string): Promise<LectureBriefState> {
  const noteText = await files.read(notePath);
  if (noteText === null) throw new Error(`강의 노트를 찾지 못했습니다: ${notePath}`);
  const script = await buildBriefScript(notePath, noteText);
  const path = briefPathForNote(notePath);
  const existing = await files.read(path);
  return { path, status: await briefStatus(existing, script), script, body: existing === null ? null : briefChatBody(existing) };
}

/**
 * The subject brief of the note's subject folder, assembled from every
 * lecture brief in its Briefs folder (no tokens): rewritten when a line
 * changed, never over the user's edits.
 */
export async function updateSubjectBrief(files: BriefFiles, notePath: string, subject: string, today: string): Promise<BriefUpdate> {
  const target = subjectBriefPath(subjectFolderOfNote(notePath), subject);
  const folder = briefPathForNote(notePath).replace(/\/?[^/]*$/, "");
  const entries: SubjectBriefEntry[] = [];
  for (const path of await files.list(folder)) {
    const text = await files.read(path);
    if (!text) continue;
    const fm = readFrontmatter(text);
    // Lecture briefs only (the subject brief has alt2obs_subject_brief instead).
    const lecture = fm.alt2obs_brief !== undefined ? fmString(fm, "lecture") : "";
    const note = lecture ? await files.read(lecture) : null;
    if (!note) continue;
    const parts = parseLectureNote(note);
    const altCreated = fmString(parts.frontmatter, "alt_created");
    entries.push({
      name: stemOf(lecture),
      date: (altCreated || fmString(parts.frontmatter, "date")).slice(0, 10),
      altCreated: altCreated || undefined,
      kind: parts.kind,
      count: parts.units.length,
      oneLine: oneLineOf(text),
    });
  }
  const decision = await planSubjectBriefUpdate(await files.read(target), subject, entries, today);
  if (decision.action === "keep") return { path: target, result: decision.reason };
  await files.write(target, decision.text);
  return { path: target, result: "written" };
}
