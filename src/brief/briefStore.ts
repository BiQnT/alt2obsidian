// Reading and writing lecture briefs (2.1.0 spec 4.4) through a small file
// interface, so the same steps run in the plugin (the vault, written with
// vault.process / create) and in the Skill CLI (the file system). No
// obsidian import.

import { parseAlignment } from "../core/prep/TranscriptAligner";
import type { TimedText } from "../chat/contextPack";
import { briefPathForNote, stemOf, subjectBriefPath, subjectFolderOfNote } from "../vault/layout";
import { fmString, parseLectureNote, readFrontmatter } from "./lectureNote";
import {
  aiOf,
  BriefScript,
  BriefStatus,
  briefChatBody,
  briefStatus,
  buildBriefScript,
  CarriedAi,
  composeBrief,
  isEditedBrief,
  oneLineOf,
  planBriefUpdate,
  planSubjectBriefUpdate,
  SubjectBriefEntry,
  subjectBriefBody,
} from "./lectureBrief";
import { aiPartStatus, BriefAi, briefAiInput, BriefAiInput, formatAiPart, renderAiSections, validateBriefAi } from "./briefAi";

export interface BriefFiles {
  /** A file's text, null when there is none. */
  read(path: string): Promise<string | null>;
  /** Creates or replaces a file (and its folder). */
  write(path: string, text: string): Promise<void>;
  /** Paths of the markdown files directly in a folder. */
  list(folder: string): Promise<string[]>;
}

/** The AI part's step (spec 4.5): the lecture's transcript and the one call. */
export interface BriefAiStep {
  /** The lecture's timestamped transcript ([] without one: no call). */
  transcript: TimedText[];
  /** One call with the prompt; resolves with the checked answer, its model and tokens, or throws. */
  run(prompt: { system: string; user: string }, validate: (raw: unknown) => BriefAi): Promise<{ ai: BriefAi; model: string; input: number; output: number }>;
}

export interface BriefUpdate {
  path: string;
  /** written: (re)written now; same: already up to date; edited: the user's edits kept. */
  result: "written" | "same" | "edited";
  /**
   * The AI part, when a step was given: made now, reused (same input, a
   * good part already there), none (no candidates), or failed (the script
   * part was written with ai_part.status "failed").
   */
  ai?: "ok" | "reused" | "none" | "failed";
  aiError?: string;
}

/** The AI input of a note (null without candidates); exported for the estimates. */
export async function aiInputFor(script: BriefScript, transcript: TimedText[]): Promise<BriefAiInput | null> {
  return briefAiInput({ title: script.title, subject: script.subject, kind: script.kind, map: script.map, units: script.units, transcript, spans: parseAlignment(script.alignment) });
}

/**
 * Builds a lecture note's brief and writes it when that is what spec 4.4
 * says; then, when it was written, the subject brief again. `force` is the
 * user's "새로 만들기" / "다시 만들기". With `ai` and a transcript, the AI
 * part is made when its input changed (`ai_hash`) or the last one did not
 * succeed; a failed call writes the script part with ai_part.status
 * "failed" and never throws. `queryPrefixes`: Dataview's own inline query
 * prefixes, made safe in the AI part's texts too.
 */
export async function updateLectureBrief(
  files: BriefFiles,
  notePath: string,
  opts: { today: string; force?: boolean; ai?: BriefAiStep; queryPrefixes?: readonly string[] }
): Promise<BriefUpdate> {
  const noteText = await files.read(notePath);
  if (noteText === null) throw new Error(`강의 노트를 찾지 못했습니다: ${notePath}`);
  const script = await buildBriefScript(notePath, noteText);
  const path = briefPathForNote(notePath);
  const existing = await files.read(path);
  const edited = existing !== null && (await isEditedBrief(existing));
  if (edited && !opts.force) return { path, result: "edited" };
  let ai: CarriedAi | undefined;
  let aiState: BriefUpdate["ai"];
  let aiError: string | undefined;
  if (opts.ai && opts.ai.transcript.length > 0) {
    const input = await aiInputFor(script, opts.ai.transcript);
    const old = existing !== null && !edited ? aiOf(existing) : null;
    if (!input) {
      ai = { sections: "", hash: "", part: formatAiPart("none"), oneLine: "" };
      aiState = "none";
    } else if (old && old.hash === input.hash && aiPartStatus(old.part) === "ok" && !opts.force) {
      aiState = "reused";
    } else {
      try {
        const r = await opts.ai.run({ system: input.system, user: input.user }, (raw) => validateBriefAi(raw, input, opts.queryPrefixes));
        ai = { sections: renderAiSections(r.ai, script.kind), hash: input.hash, part: formatAiPart("ok", r), oneLine: r.ai.oneLine };
        aiState = "ok";
      } catch (e) {
        ai = { sections: "", hash: input.hash, part: formatAiPart("failed"), oneLine: "" };
        aiState = "failed";
        aiError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  const decision = await planBriefUpdate(existing, script, { today: opts.today, force: opts.force, ai });
  const done = (result: BriefUpdate["result"]): BriefUpdate => ({ path, result, ...(aiState ? { ai: aiState } : {}), ...(aiError ? { aiError } : {}) });
  if (decision.action === "keep") return done(decision.reason);
  await files.write(path, decision.text);
  await updateSubjectBrief(files, notePath, script.subject, opts.today);
  return done("written");
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
    if (note) entries.push(subjectEntry(lecture, note, text));
  }
  const decision = await planSubjectBriefUpdate(await files.read(target), subject, entries, today);
  if (decision.action === "keep") return { path: target, result: decision.reason };
  await files.write(target, decision.text);
  return { path: target, result: "written" };
}

/** A lecture's line in the subject brief: from its note and its brief. */
function subjectEntry(notePath: string, noteText: string, briefText: string): SubjectBriefEntry {
  const parts = parseLectureNote(noteText);
  const altCreated = fmString(parts.frontmatter, "alt_created");
  return {
    name: stemOf(notePath),
    date: (altCreated || fmString(parts.frontmatter, "date")).slice(0, 10),
    altCreated: altCreated || undefined,
    kind: parts.kind,
    count: parts.units.length,
    oneLine: oneLineOf(briefText),
  };
}

/**
 * The subject brief a question sends (spec 5.10): the file's body without
 * its frontmatter and title; without a file, the same lines assembled in
 * memory from the subject's lecture notes (no tokens, nothing written),
 * each from its lecture brief, or from the script part its note gives when
 * it has none.
 */
export async function subjectBriefForChat(files: BriefFiles, notePath: string, subject: string, lectureNotes: string[], today: string): Promise<string> {
  const existing = await files.read(subjectBriefPath(subjectFolderOfNote(notePath), subject));
  if (existing !== null) return briefChatBody(existing);
  const entries: SubjectBriefEntry[] = [];
  for (const path of lectureNotes) {
    const note = await files.read(path);
    if (!note) continue;
    const brief = (await files.read(briefPathForNote(path))) ?? (await composeBrief(await buildBriefScript(path, note), null, today));
    entries.push(subjectEntry(path, note, brief));
  }
  return briefChatBody(subjectBriefBody(subject, entries));
}

/**
 * The timestamped part of an import's transcript (the brief's AI part
 * reads it, spec 4.5); null when no segment has both times. The plugin's
 * import and the Skill use this one rule, so their `ai_hash` agree.
 */
export function timedTranscript(segments: Array<{ startMs: number | null; endMs: number | null; text: string }> | undefined): TimedText[] | null {
  const timed = (segments ?? [])
    .filter((s) => s.startMs !== null && s.endMs !== null)
    .map((s) => ({ startMs: s.startMs as number, endMs: s.endMs as number, text: s.text }));
  return timed.length > 0 ? timed : null;
}
