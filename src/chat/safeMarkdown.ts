// What the panel renders of a model's answer (2.1.0 spec 5.4). The answer
// goes through Obsidian's MarkdownRenderer, which also runs other plugins'
// code block processors and loads remote resources, and an answer is
// untrusted text (the prompt carries lecture material that may hold
// anything). Guessing the Markdown structure (fences, comments, math,
// quote and list containers) the way Obsidian's parser reads it is not
// possible in full, and every wrong guess would show raw content. So each
// step below is harmless wherever it lands, in code, math or text:
// - every line that looks like a fence opener, after any quote marks
//   (`>`, callouts), list markers and indentation, keeps its language only
//   when that is a well-known code or markup language (an allow-list); any
//   other language, which another plugin might run or query the vault
//   with (Dataview, DataviewJS, JS Engine, Mermaid labels, ...), becomes
//   `text`. A closing line has no language, so no real fence changes;
// - in math (`$$...$$`, and `$...$` by Obsidian's rules: no space after the
//   opening `$` or before the closing one, no digit after it) every `<`
//   becomes `\lt `; elsewhere, code included, a `<` that could open a tag,
//   comment or declaration gets a zero-width space after it, so no raw
//   HTML is left (a wrong math guess shows `\lt` or a zero-width space);
// - `![` gets a zero-width space in it, so no image (remote, reference or
//   embed) is loaded;
// - `=` and `$=` get a zero-width space in front where they could open an
//   inline Dataview query: first on a line after its containers, or after
//   a backtick with only white space (line breaks too) between. Dataview
//   trims a code element's text with String.prototype.trim, which keeps
//   the zero-width space.
// Only invisible characters are added outside math. Pure: no obsidian import.

/** Fence languages kept as they are: code and markup that only display. */
export const SAFE_LANGUAGES = new Set([
  "",
  "text",
  "plain",
  "plaintext",
  "txt",
  "js",
  "javascript",
  "jsx",
  "ts",
  "typescript",
  "tsx",
  "py",
  "python",
  "c",
  "h",
  "cpp",
  "c++",
  "cc",
  "hpp",
  "cs",
  "csharp",
  "java",
  "kotlin",
  "kt",
  "go",
  "rust",
  "rs",
  "swift",
  "sh",
  "bash",
  "zsh",
  "shell",
  "console",
  "sql",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "md",
  "markdown",
  "latex",
  "tex",
  "math",
  "diff",
  "asm",
  "nasm",
  "x86asm",
  "verilog",
  "systemverilog",
  "sv",
  "vhdl",
  "scheme",
  "lisp",
  "haskell",
  "hs",
  "ocaml",
  "ml",
  "r",
  "matlab",
  "ruby",
  "rb",
  "php",
  "scala",
  "lua",
  "perl",
  "julia",
  "fortran",
  "prolog",
  "makefile",
  "dockerfile",
  "ini",
  "csv",
]);

/** Any run of quote marks, list markers and white space before a line's text. */
const PREFIXES = /^(?:[^\S\n]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=\s|$)))*[^\S\n]*/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** `$$...$$` blocks and `$...$` inline spans (on one line). */
const MATH = /\$\$[\s\S]*?\$\$|\$(?=[^\s$])[^\n$]*?[^\s$]\$(?!\d)/g;
const ZW = "\u200B";

/** A fence-like line whose language is not on the allow-list, with `text` instead; any other line as it is. */
function safeFenceLanguage(line: string): string {
  const lead = line.match(PREFIXES)?.[0] ?? "";
  const fence = line.slice(lead.length).match(FENCE);
  // A backtick fence's info string cannot hold a backtick (CommonMark): such a line is inline code.
  if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return line;
  const lang = fence[2].trim().split(/\s+/)[0] ?? "";
  return lang === "" || SAFE_LANGUAGES.has(lang.toLowerCase()) ? line : `${lead}${fence[1]}text`;
}

/** No tag, comment, declaration or processing instruction can start: `<` then a zero-width space. */
function noTags(text: string): string {
  return text.replace(/<(?=[A-Za-z!/?])/g, `<${ZW}`);
}

export function safeAnswerMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(safeFenceLanguage).join("\n");
  let out = "";
  let last = 0;
  for (const m of lines.matchAll(MATH)) {
    out += noTags(lines.slice(last, m.index)) + m[0].replace(/</g, "\\lt ");
    last = (m.index ?? 0) + m[0].length;
  }
  out = (out + noTags(lines.slice(last)))
    .replace(/!\[/g, `!${ZW}[`)
    .replace(/`(\s*)(?=\$?=)/g, `\`$1${ZW}`);
  return out
    .split("\n")
    .map((line) => {
      const lead = line.match(PREFIXES)?.[0] ?? "";
      return /^\$?=/.test(line.slice(lead.length)) ? `${lead}${ZW}${line.slice(lead.length)}` : line;
    })
    .join("\n");
}
