// Test entry: the management comment hider plus the CodeMirror classes the
// test drives it with, bundled together so they share one @codemirror copy.
export * from "../../src/editor/managedComments";
export { EditorSelection, EditorState } from "@codemirror/state";
export { EditorView } from "@codemirror/view";
