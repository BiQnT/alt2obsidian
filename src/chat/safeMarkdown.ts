// What the panel renders of a model's answer (2.1.0 spec 5.4). The answer
// goes through Obsidian's MarkdownRenderer, which also runs other plugins'
// code block processors and loads remote resources, and an answer is
// untrusted text (the prompt carries lecture material that may hold
// anything). So before rendering:
// - every line that looks like a fence opener, after any quote marks
//   (`>`, callouts), list markers and indentation, inside a fence or not,
//   keeps its language only when that is a well-known code or markup
//   language (an allow-list); any other language, which another plugin
//   might run or query the vault with (Dataview, DataviewJS, JS Engine,
//   Mermaid labels, ...), becomes `text`. A closing line has no language,
//   so no real fence changes;
// - inline code that Dataview would run (`= ...`, `$= ...`, also when the
//   span starts at the end of the line before) gets a zero-width space in
//   front, so it stays code;
// - raw HTML is shown as text: every tag but a few plain ones without
//   attributes (br, sub, sup, b, i, em, strong, u, s, kbd, mark), and
//   comments and declarations;
// - remote and reference-style images become plain links, so nothing is
//   fetched from the network.
// The lines inside a fence keep their text (only a fence-like line's
// language changes). A fence opener counts when it is indented at most 3
// columns from its quote or list item; one indented more is not a fence,
// so the lines after it are made safe too. Pure: no obsidian import.

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

/** A line's containers: blockquote marks (`>`, also nested and callouts), its indent, a list marker, then its text. */
const CONTAINERS = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*)((?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))?(.*)$/;
/** Any run of quote marks, list markers and indentation before a line's text (for the language rule). */
const PREFIXES = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)))*[ \t]*/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const REMOTE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi;
/** `![alt][ref]`, `![alt][]` and the shortcut `![alt]` (never a `![[wikilink]]` embed or an inline `![alt](..)`). */
const REFERENCE_IMAGE = /!\[(?!\[)([^\]\n]*)\](?!\()(\[[^\]\n]*\])?/g;
/** A raw HTML tag (its name runs to white space, `/`, `>` or the line's end), comment, declaration or processing instruction. */
const HTML_TAG = /<(?:\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|[!?])/g;
/** Tags kept as HTML: plain formatting without attributes. */
const KEPT_TAG = /^<\/?(?:br|sub|sup|b|i|em|strong|u|s|kbd|mark)[ \t]*\/?>/i;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const ZW = "\u200B";

function safeText(text: string): string {
  return text
    .replace(REMOTE_IMAGE, (_m, alt: string, url: string) => `[${alt.trim() || url}](${url})`)
    .replace(REFERENCE_IMAGE, (_m, alt: string, ref: string | undefined) => `[${alt}]${ref ?? ""}`)
    .replace(HTML_TAG, (tag: string, at: number, whole: string) => (KEPT_TAG.test(whole.slice(at)) ? tag : `&lt;${tag.slice(1)}`));
}

/** One line outside fences: its inline code kept (an inline Dataview query defused), the rest made safe. */
function safeLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    out += safeText(line.slice(last, at));
    const code = m[2];
    out += /^\s*\$?=/.test(code) ? `${m[1]}${ZW}${code}${m[1]}` : m[0];
    last = at + m[0].length;
  }
  return out + safeText(line.slice(last));
}

/** A fence-like line whose language is not on the allow-list, with `text` instead; any other line as it is. */
function safeFenceLanguage(line: string): string {
  const lead = line.match(PREFIXES)?.[0] ?? "";
  const fence = line.slice(lead.length).match(FENCE);
  // A backtick fence's info string cannot hold a backtick (CommonMark): such a line is inline code.
  if (!fence || (fence[1][0] === "`" && fence[2].includes("`"))) return line;
  const lang = fence[2].trim().split(/\s+/)[0] ?? "";
  return lang === "" || SAFE_LANGUAGES.has(lang.toLowerCase()) ? line : `${lead}${fence[1]}text`;
}

/** Columns of leading white space (a tab to the next multiple of 4). */
function columns(space: string): number {
  let n = 0;
  for (const ch of space) n = ch === "\t" ? n + 4 - (n % 4) : n + 1;
  return n;
}

interface OpenFence {
  char: string;
  len: number;
  /** Blockquote marks the fence sits in: a line with fewer ends it. */
  quotes: number;
  /** Content column of its list item: a non-blank line indented less ends it. */
  indent: number;
}

export function safeAnswerMarkdown(text: string): string {
  let open: OpenFence | null = null;
  /** The list item lines belong to: its quote depth and content column. */
  let list: { quotes: number; col: number } | null = null;
  let prevBlank = true;
  /** The line before ended with a backtick run: an inline code span may go on in this line. */
  let prevTick = false;
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const c = line.match(CONTAINERS)!;
    const quotes = (c[1].match(/>/g) ?? []).length;
    const indent = columns(c[2]);
    const marker = c[3] ?? "";
    const blank = (marker + c[4]).trim() === "";
    if (open) {
      const ended = quotes < open.quotes || (!blank && open.indent > 0 && indent < open.indent);
      if (!ended) {
        const close = c[4].trim().match(FENCE);
        if (!marker && close && close[1][0] === open.char && close[1].length >= open.len && close[2].trim() === "") open = null;
        out.push(safeFenceLanguage(line));
        prevBlank = blank;
        prevTick = false;
        continue;
      }
      // The container ended, so the fence did too: this line is read as any other.
      open = null;
    }
    if (list && list.quotes !== quotes) list = null;
    if (marker) list = { quotes, col: indent + columns(marker) };
    else if (list && !blank && indent < list.col && prevBlank) list = null;
    const fence = c[4].match(FENCE);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      // A fence opens at most 3 columns in from its container: further in, it is an indented code line.
      const inList = list !== null && (marker !== "" || indent >= list.col);
      const from = marker ? 0 : inList && list ? indent - list.col : indent;
      if (from <= 3) {
        if (!inList) list = null;
        open = { char: fence[1][0], len: fence[1].length, quotes, indent: inList && list ? list.col : 0 };
        out.push(safeFenceLanguage(line));
        prevBlank = false;
        prevTick = false;
        continue;
      }
    }
    let safe = line;
    if (prevTick) {
      // `\n= ...`: the span's text starts on this line.
      const lead = line.match(PREFIXES)?.[0] ?? "";
      if (/^\$?=/.test(line.slice(lead.length))) safe = `${lead}${ZW}${line.slice(lead.length)}`;
    }
    out.push(safeFenceLanguage(safeLine(safe)));
    prevBlank = blank;
    prevTick = !blank && /`[ \t]*$/.test(line);
  }
  return out.join("\n");
}
