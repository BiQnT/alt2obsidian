// Test entry: the lecture brief (src/brief, no obsidian import) and the layout paths it uses.
export * from "../../src/brief/lectureNote";
export * from "../../src/brief/lectureBrief";
export * from "../../src/brief/briefStore";
export * from "../../src/brief/briefAi";
export { formatSlideMeta } from "../../src/core/slideMeta";
export { briefPathForNote, subjectBriefPath, chatsFolderForNote, SUBJECT_SUBDIRS } from "../../src/vault/layout";
export { isLectureFrontmatter, isLectureNote } from "../../src/ui/pdfOpen";
export { estimateTextTokens } from "../../src/core/budget/estimate";
