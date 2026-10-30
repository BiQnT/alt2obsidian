// What the panel renders of a model's answer (2.1.0 spec 5.4). The answer
// goes through Obsidian's MarkdownRenderer, which also runs other plugins'
// code block processors and loads remote resources, and an answer is
// untrusted text (the prompt carries lecture material that may hold
// anything). Guessing the Markdown structure (fences, comments, math,
// quote and list containers) the way Obsidian's parser reads it is not
// possible in full, and every wrong guess would show raw content. So each
// step below is harmless wherever it lands, in code, math or text:
// - every line that looks like a fence opener, after any quote marks
//   (`>`, callouts), a front matter's closing `---`, footnote labels
//   (`[^1]:`), list markers and indentation, keeps its language only when that is a well-known code or
//   markup language (an allow-list); any other language, which another
//   plugin might run or query the vault with (Dataview, DataviewJS, JS
//   Engine, Mermaid labels, ...), becomes `text`. A closing line has no
//   language, so no real fence changes;
// - a block comment cannot hide where a block starts (text after its
//   closing `%%` starts a new block): `%%` first on a line after its
//   containers gets a zero-width space in it, so no block comment opens
//   (its text shows; an inline `%%...%%` later in a line stays);
// - in math (`$$...$$`, and `$...$` by Obsidian's rules: no space after the
//   opening `$` or before the closing one, no digit after it) a `<` that
//   could open a tag, or a Templater command (`<%`), gets a space after it;
//   elsewhere, code included, it gets a zero-width space, so no raw HTML,
//   comment or declaration is left, and Templater (which reads the raw
//   text of a new file, code too, when "Trigger Templater on new file
//   creation" is on) finds no command;
// - `![` gets a zero-width space in it, so no image (remote, reference or
//   embed) is loaded;
// - an inline Dataview query prefix (`=`, `$=` and the ones set in
//   Dataview) gets a zero-width space in front where it could open a
//   query: first on a line after its containers (not a heading's `===`
//   underline, which cannot read as a query), or after a backtick with
//   only white space (line breaks too) between. Dataview trims a code element's text with
//   String.prototype.trim, which keeps the zero-width space.
// Only invisible characters are added outside math (the panel takes them
// out of what is copied). Pure: no obsidian import.

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

/**
 * Any run of quote marks, `---` (a front matter's end, which a block can
 * follow on the same line), footnote labels, list markers and white space
 * before a line's text.
 */
const PREFIXES = /^(?:[^\S\n]*(?:>|---|\[\^[^\]\n]+\]:|(?:[-*+]|\d{1,9}[.)])(?=\s|$)))*[^\S\n]*/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
/** `$$...$$` blocks and `$...$` inline spans (on one line). */
const MATH = /\$\$[\s\S]*?\$\$|\$(?=[^\s$])[^\n$]*?[^\s$]\$(?!\d)/g;
export const ZW = "\u200B";
/** Dataview's inline query prefixes as it ships them (`= ...` and `$= ...`). */
export const QUERY_PREFIXES: readonly string[] = ["=", "$="];

/** A fence-like line whose language is not on the allow-list, with `text` instead; any other line as it is. */
function safeFenceLanguage(line: string): string {
  const lead = line.match(PREFIXES)?.[0] ?? "";
  const fence = line.slice(lead.length).match(FENCE);
  // A backtick fence's info string cannot hold a backtick (CommonMark): such a line is inline code.
  if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return line;
  // Split as CommonMark does (spaces and tabs only): an info string with other white space or marks in its first word is not on the list.
  const lang = fence[2].replace(/^[ \t]+/, "").split(/[ \t]/)[0];
  return lang === "" || SAFE_LANGUAGES.has(lang.toLowerCase()) ? line : `${lead}${fence[1]}text`;
}

/** No tag, comment, declaration, processing instruction or Templater command (`<%`) can start: `<` then a zero-width space. */
function noTags(text: string): string {
  return text.replace(/<(?=[A-Za-z!/?%])/g, `<${ZW}`);
}

/**
 * The inline query prefixes set in Dataview (`inlineQueryPrefix`,
 * `inlineJsQueryPrefix`), read defensively from the app; none when it is
 * not there or they are not strings.
 */
export function dataviewQueryPrefixes(app: unknown): string[] {
  const settings = (app as { plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> } | undefined> } } | null)?.plugins?.plugins?.dataview?.settings;
  return [settings?.inlineQueryPrefix, settings?.inlineJsQueryPrefix].filter((p): p is string => typeof p === "string" && p.trim() !== "");
}

/**
 * Model text written into the vault (a saved memo, a brief's AI part):
 * made safe as an answer is, and every `%%` broken too, as the note's own
 * text before it may have left a block comment open that a `%%` in it
 * would close (what follows would start a new block).
 */
export function safeNoteMarkdown(text: string, queryPrefixes: readonly string[] = []): string {
  return safeAnswerMarkdown(text, queryPrefixes).replace(/%(?=%)/g, `%${ZW}`);
}

/** The answer made safe to render; `queryPrefixes` adds inline query prefixes to `=` and `$=` (Dataview's settings). */
export function safeAnswerMarkdown(text: string, queryPrefixes: readonly string[] = []): string {
  const prefixes = new Set([...QUERY_PREFIXES, ...queryPrefixes.filter((p) => p.trim() !== "")]);
  const anyPrefix = [...prefixes].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const queryAt = new RegExp(anyPrefix, "y");
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(safeFenceLanguage).join("\n");
  let out = "";
  let last = 0;
  for (const m of lines.matchAll(MATH)) {
    out += noTags(lines.slice(last, m.index)) + m[0].replace(/<(?=[A-Za-z!/?%])/g, "< ");
    last = (m.index ?? 0) + m[0].length;
  }
  const opensQuery = (whole: string, at: number) => {
    queryAt.lastIndex = at;
    return queryAt.test(whole);
  };
  /**
   * A heading's `===` underline: after a line of text (not a fence, whose
   * code it would start), indented less than 4 columns (not indented code),
   * and no query even so (what a query would read after its prefix still
   * starts with `=`; a lone `=` would read the lines after it).
   */
  const underline = (lead: string, rest: string, prev: string | undefined) => {
    if (!/^=+\s*$/.test(rest) || prev === undefined || !prev.trim()) return false;
    const indent = (lead.match(/[^\S\n]*$/)?.[0] ?? "").replace(/\t/g, "    ").length;
    const prevText = prev.slice(prev.match(PREFIXES)?.[0].length ?? 0);
    return indent < 4 && !FENCE.test(prevText) && [...prefixes].every((p) => !rest.startsWith(p) || rest.slice(p.length).trim().startsWith("="));
  };
  out = (out + noTags(lines.slice(last)))
    .replace(/!\[/g, `!${ZW}[`)
    .replace(/`(\s*)/g, (tick: string, space: string, at: number, whole: string) => (opensQuery(whole, at + tick.length) ? `\`${space}${ZW}` : tick));
  return out
    .split("\n")
    .map((line, i, all) => {
      const lead = line.match(PREFIXES)?.[0] ?? "";
      const rest = line.slice(lead.length);
      // A block comment opened here could hide where the next block starts.
      if (rest.startsWith("%%")) return `${lead}%${ZW}${rest.slice(1)}`;
      return opensQuery(rest, 0) && !underline(lead, rest, all[i - 1]) ? `${lead}${ZW}${rest}` : line;
    })
    .join("\n");
}
