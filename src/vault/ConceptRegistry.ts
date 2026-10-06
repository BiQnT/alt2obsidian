import { sameConcept } from "../core/conceptNames";

/**
 * Tracks concept names currently being written to prevent
 * duplicate concept note creation during concurrent imports.
 * (Guards against interleaved async operations, not thread concurrency.)
 * Names match like concept notes do (`sameConcept` in
 * src/core/conceptNames.ts), so "Lottery Scheduling (로터리 스케줄링)" and
 * "로터리 스케줄링 (Lottery Scheduling)" count as the same concept.
 */
export class ConceptRegistry {
  private pending: string[] = [];

  acquire(name: string): boolean {
    if (this.has(name)) {
      return false;
    }
    this.pending.push(name.trim());
    return true;
  }

  release(name: string): void {
    const key = name.trim();
    this.pending = this.pending.filter((p) => p !== key);
  }

  releaseAll(names: string[]): void {
    for (const name of names) {
      this.release(name);
    }
  }

  has(name: string): boolean {
    return this.pending.some((p) => sameConcept(p, name));
  }
}
