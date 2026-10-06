// Test entry: the plugin class plus the stubbed obsidian classes it checks against.
export { default } from "../../src/main";
// @ts-ignore resolved to the test stub by test/helpers/bundle-ts.mjs
export { TFile, TFolder, notices } from "obsidian";
export { insertFrontmatterLine } from "../../src/generator/NoteGenerator";
export { SyncedViewerView, VIEW_TYPE_SYNCED_VIEWER } from "../../src/ui/SyncedViewerView";
