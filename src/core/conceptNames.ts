// Concept note names (spec 5.4 concepts). Since 2.0.0-beta.5 a new concept
// is named "English (한국어)", e.g. "Lottery Scheduling (로터리 스케줄링)";
// notes made before are named "한국어 (English)". Both orders name the same
// concept (see `sameConcept`), ignoring case, spaces, "_", "-" and
// file-name characters. Existing files are never renamed; a concept that
// already has a note keeps that note's name. No obsidian import.

import type { ConceptData } from "../types";

const HANGUL = /[\uAC00-\uD7A3\u3131-\u318E]/;

export interface ConceptNameParts {
  full: string;
  /** The part without Hangul ("Lottery Scheduling"), null when there is none. */
  english: string | null;
  /** The part with Hangul ("로터리 스케줄링"), null when there is none. */
  korean: string | null;
  /**
   * Every English name of the concept: `english`, and for a name without
   * Hangul that pairs an acronym with its expansion ("PTE (Page Table
   * Entry)", "Completely Fair Scheduler (CFS)") both of them.
   */
  aliases: string[];
}

/** An acronym: capitals and digits (also "LR-SC", "LR/SC"), at least two characters with a letter. */
export function isAcronym(text: string): boolean {
  return /^[A-Z0-9][A-Z0-9/&-]*[A-Z0-9]$/.test(text) && /[A-Z]/.test(text);
}

/**
 * The parts of "A (B)": the side with Hangul is the Korean part. Two parts
 * without Hangul are one English name with a qualifier ("Mutator
 * (Operation)"), unless one of them is an acronym: then both are names of
 * the concept. A name without a trailing "(...)" is one part, Korean or
 * English by its letters.
 */
export function parseConceptName(name: string): ConceptNameParts {
  const full = name.trim();
  const m = full.match(/^(.+?)\s*\(([^()]+)\)$/);
  if (m) {
    const [a, b] = [m[1].trim(), m[2].trim()];
    const aKo = HANGUL.test(a);
    const bKo = HANGUL.test(b);
    if (aKo !== bKo) {
      const english = aKo ? b : a;
      return { full, english, korean: aKo ? a : b, aliases: [english] };
    }
    if (!aKo && (isAcronym(a) || isAcronym(b))) return { full, english: a, korean: null, aliases: [a, b] };
  }
  return HANGUL.test(full) ? { full, english: null, korean: full, aliases: [] } : { full, english: full, korean: null, aliases: [full] };
}

/**
 * Comparison key: lower case, without spaces, "_" and "-", without the
 * characters a file name cannot hold (a note named after "I/O" is "IO")
 * and without trailing dots, like the file name itself (sanitizeFilename).
 */
export function conceptKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\.+$/, "")
    .replace(/[\s_-]+/g, "");
}

/** Lower-case words that do not count in an acronym ("Translation Look-Aside Buffer"). */
const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);

/**
 * Initials of an expansion, an acronym word kept whole ("Dynamic RAM" is
 * DRAM). With `splitHyphens` each hyphenated piece counts ("Non-Uniform
 * Memory Access" is NUMA), without it a hyphenated word counts once
 * ("Translation Look-Aside Buffer" is TLB).
 */
function initials(expansion: string, splitHyphens: boolean): string {
  const words = expansion.split(splitHyphens ? /[\s/-]+/ : /[\s/]+/).filter((w) => w && !MINOR_WORDS.has(w));
  if (words.length < 2) return "";
  return words.map((w) => (isAcronym(w) ? w.replace(/[^A-Z0-9]/g, "") : /^\d+$/.test(w) ? w : w[0].toUpperCase())).join("");
}

/** The acronym stands for the expansion (its initials, hyphens split or not). */
function acronymOf(acronym: string, expansion: string): boolean {
  const a = acronym.replace(/[^A-Z0-9]/g, "");
  return a.length >= 2 && (initials(expansion, true) === a || initials(expansion, false) === a);
}

/** Acronyms spelled out when two expansions are compared ("Dynamic RAM" is "Dynamic Random Access Memory"). */
const SPELLED_OUT: Record<string, string> = {
  RAM: "Random Access Memory",
  ROM: "Read Only Memory",
  CPU: "Central Processing Unit",
  GPU: "Graphics Processing Unit",
};

/** The endings that keep a word the same word: plural and verb forms. */
const SAME_WORD_ENDINGS = ["s", "es", "ing", "ed", "d"];

/**
 * The same English name: equal keys (with the acronyms above spelled out),
 * or one is the other plus a plural or verb ending ("Cache", "Caches";
 * "Context Switch", "Context Switching"). Other endings make another word:
 * "Process" is not "Processor", "Point" not "Pointer".
 */
function sameWords(x: string, y: string): boolean {
  const spell = (s: string) => s.split(/\s+/).map((w) => SPELLED_OUT[w] ?? w).join(" ");
  const kx = conceptKey(spell(x));
  const ky = conceptKey(spell(y));
  if (kx === ky) return true;
  const [short, long] = kx.length <= ky.length ? [kx, ky] : [ky, kx];
  return short.length >= 3 && long.startsWith(short) && SAME_WORD_ENDINGS.includes(long.slice(short.length));
}

/**
 * Two English names that are not plainly different, for two names with the
 * same Korean part: the same words, or an acronym in one stands for the
 * other ("MESI Protocol", "Modified-Exclusive-Shared-Invalid").
 */
function englishRelated(x: string, y: string): boolean {
  if (sameWords(x, y)) return true;
  const tokens = (s: string) => s.split(/\s+/).filter(isAcronym);
  return tokens(x).some((t) => acronymOf(t, y)) || tokens(y).some((t) => acronymOf(t, x));
}

/**
 * Korean parts shared by names that are different concepts ("Latency
 * (지연)" and "Delay (지연)"): a Korean-only name ("지연") cannot tell which
 * one it is, so it matches neither.
 */
export function ambiguousKorean(names: Iterable<string>): Set<string> {
  const byKorean = new Map<string, string[]>();
  for (const n of names) {
    const p = parseConceptName(n);
    if (!p.korean || p.aliases.length === 0) continue;
    const k = conceptKey(p.korean);
    byKorean.set(k, [...(byKorean.get(k) ?? []), n]);
  }
  const out = new Set<string>();
  for (const [k, list] of byKorean) {
    if (list.some((a, i) => list.slice(i + 1).some((b) => !sameConcept(a, b)))) out.add(k);
  }
  return out;
}

/**
 * The same concept. A Korean part is strong evidence, a bare acronym weak
 * (PC is a Program Counter and a Personal Computer):
 * - the same whole name;
 * - the same Korean part: unless both have English names that are plainly
 *   different ("Latency (지연)", "Delay (지연)"); a Korean-only name does
 *   not match when its Korean part is in `ambiguous`;
 * - different Korean parts: only the same English name that is not a bare
 *   acronym ("Ticket (추첨권)" is "티켓 (Ticket)"); never by initials;
 * - otherwise (at most one Korean part): when both carry an expansion (an
 *   English name that is not an acronym) the expansions must be the same
 *   words, whatever the acronyms ("SM (Streaming Multiprocessor)" is not
 *   "SM (Shared Memory)"); else the same acronym, or an acronym of three or
 *   more letters for the other's expansion ("CPU", "Central Processing
 *   Unit").
 */
export function sameConcept(a: string, b: string, ambiguous?: Set<string>): boolean {
  if (conceptKey(a) === conceptKey(b)) return true;
  const pa = parseConceptName(a);
  const pb = parseConceptName(b);
  const acr = (p: ConceptNameParts) => p.aliases.filter(isAcronym);
  const exp = (p: ConceptNameParts) => p.aliases.filter((x) => !isAcronym(x));
  if (pa.korean && pb.korean) {
    const k = conceptKey(pa.korean);
    if (k === conceptKey(pb.korean)) {
      if (pa.aliases.length === 0 || pb.aliases.length === 0) return !ambiguous?.has(k);
      return pa.aliases.some((x) => pb.aliases.some((y) => englishRelated(x, y)));
    }
    return exp(pa).some((x) => exp(pb).some((y) => conceptKey(x) === conceptKey(y)));
  }
  const ea = exp(pa);
  const eb = exp(pb);
  if (ea.length > 0 && eb.length > 0) return ea.some((x) => eb.some((y) => sameWords(x, y)));
  const aa = acr(pa);
  const ab = acr(pb);
  if (aa.some((x) => ab.some((y) => conceptKey(x) === conceptKey(y)))) return true;
  const long = (x: string) => x.replace(/[^A-Z0-9]/g, "").length >= 3;
  return aa.some((x) => long(x) && eb.some((y) => acronymOf(x, y))) || ab.some((y) => long(y) && ea.some((x) => acronymOf(y, x)));
}

/** The existing name for the same concept, or null (first match in list order). */
export function findSameConcept(name: string, existing: Iterable<string>, ambiguous?: Set<string>): string | null {
  for (const e of existing) if (sameConcept(name, e, ambiguous)) return e;
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
  // A Korean-only note ("지연") takes a concept only when no other concept of this answer shares its Korean part.
  const ambiguous = ambiguousKorean(concepts.map((c) => c.name.trim()));
  const merged = new Map<string, ConceptData>();
  for (const concept of concepts) {
    const rawName = concept.name.trim();
    if (!rawName) continue;
    const canonicalName = findSameConcept(rawName, existing, ambiguous) ?? findSameConcept(rawName, merged.keys(), ambiguous) ?? rawName;
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
          .map((name) => findSameConcept(name.trim(), known, ambiguous))
          .filter((name): name is string => !!name && !sameConcept(name, concept.name))
      )
    ),
  }));
}
