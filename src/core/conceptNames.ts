// Concept note names (spec 5.4 concepts). Since 2.0.0-beta.5 a new concept
// is named "English (한국어)", e.g. "Lottery Scheduling (로터리 스케줄링)";
// notes made before are named "한국어 (English)". Both orders name the same
// concept: names match on the English part or the Korean part, ignoring
// case, spaces, "_", "-" and file-name characters. Existing files are never
// renamed; a concept that already has a note keeps that note's name. No
// obsidian import.

import type { ConceptData } from "../types";

const HANGUL = /[가-힣ㄱ-ㆎ]/;

export interface ConceptNameParts {
  full: string;
  /** The part without Hangul ("Lottery Scheduling"), null when there is none. */
  english: string | null;
  /** The part with Hangul ("로터리 스케줄링"), null when there is none. */
  korean: string | null;
}

/**
 * The parts of "A (B)": the side with Hangul is the Korean part. A name
 * without a trailing "(...)" is one part, Korean or English by its letters.
 */
export function parseConceptName(name: string): ConceptNameParts {
  const full = name.trim();
  const m = full.match(/^(.+?)\s*\(([^()]+)\)$/);
  if (m) {
    const [a, b] = [m[1].trim(), m[2].trim()];
    const aKo = HANGUL.test(a);
    const bKo = HANGUL.test(b);
    if (aKo !== bKo) return { full, english: aKo ? b : a, korean: aKo ? a : b };
  }
  return HANGUL.test(full) ? { full, english: null, korean: full } : { full, english: full, korean: null };
}

/**
 * Comparison key: lower case, without spaces, "_" and "-", and without the
 * characters a file name cannot hold (a note named after "I/O" is "IO").
 */
export function conceptKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/[\s_-]+/g, "");
}

/**
 * The same concept: the same whole name or English part, or the same Korean
 * part unless both names have English parts that are plainly different
 * ("Latency (지연)" and "Delay (지연)" stay two concepts; "Context Switch"
 * and "Context Switching" with one Korean name are one, since one English
 * key starts with the other).
 */
export function sameConcept(a: string, b: string): boolean {
  if (conceptKey(a) === conceptKey(b)) return true;
  const pa = parseConceptName(a);
  const pb = parseConceptName(b);
  const ea = pa.english ? conceptKey(pa.english) : "";
  const eb = pb.english ? conceptKey(pb.english) : "";
  if (ea && eb && ea === eb) return true;
  if (!pa.korean || !pb.korean || conceptKey(pa.korean) !== conceptKey(pb.korean)) return false;
  return !ea || !eb || ea.startsWith(eb) || eb.startsWith(ea);
}

/** The existing name for the same concept, or null (first match in list order). */
export function findSameConcept(name: string, existing: Iterable<string>): string | null {
  for (const e of existing) if (sameConcept(name, e)) return e;
  return null;
}

/**
 * Concepts as written to the vault: a concept that already has a note
 * takes that note's name, in either name order ("English (한국어)" or the
 * older "한국어 (English)", matched on either part), so the note is reused
 * and never renamed. Duplicates within the answer are merged, and related
 * concepts keep only names of this lecture's or existing concepts, under
 * their canonical names.
 */
export function normalizeConcepts(concepts: ConceptData[], existingConceptNames: Iterable<string>): ConceptData[] {
  const existing = Array.from(existingConceptNames);
  const merged = new Map<string, ConceptData>();
  for (const concept of concepts) {
    const rawName = concept.name.trim();
    if (!rawName) continue;
    const canonicalName = findSameConcept(rawName, existing) ?? findSameConcept(rawName, merged.keys()) ?? rawName;
    const current = merged.get(canonicalName);
    const next = { ...concept, name: canonicalName, relatedConcepts: [...concept.relatedConcepts] };
    if (current) {
      current.relatedConcepts.push(...next.relatedConcepts);
      current.definition = current.definition || next.definition;
      current.example = current.example || next.example;
      current.caution = current.caution || next.caution;
      current.lectureContext = current.lectureContext || next.lectureContext;
    } else {
      merged.set(canonicalName, next);
    }
  }
  const known = [...existing, ...merged.keys()];
  return Array.from(merged.values()).map((concept) => ({
    ...concept,
    relatedConcepts: Array.from(
      new Set(
        concept.relatedConcepts
          .map((name) => findSameConcept(name.trim(), known))
          .filter((name): name is string => !!name && !sameConcept(name, concept.name))
      )
    ),
  }));
}
