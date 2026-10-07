// Test entry: bundles the note pipeline pieces with the obsidian stub.
export { VaultManager } from "../../src/vault/VaultManager";
export { NoteGenerator } from "../../src/generator/NoteGenerator";
export { computeSlideHash } from "../../src/core/slideHash";
// @ts-ignore resolved to the test stub by test/helpers/bundle-ts.mjs
export { notices, TFile } from "obsidian";
