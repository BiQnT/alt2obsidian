// What the panel renders of a model's answer (2.1.0 spec 5.4). The answer
// goes through Obsidian's MarkdownRenderer, which also runs other plugins'
// code block processors and loads remote resources, and an answer is
// untrusted text (the prompt carries lecture material that may hold
// anything). So before rendering:
// - a code fence keeps its language only when that is a well-known code or
//   markup language (an allow-list); any other language, which another
//   plugin might run or query the vault with (Dataview, DataviewJS, JS
//   Engine, ...), becomes `text`. Fence openers are found inside quotes
//   and callouts (`>`), list items and indented lines too;
// - inline code and raw `<code>` that Dataview would run (`= ...`, `$= ...`)
//   get a zero-width space in front, so they stay code;
// - remote and reference-style images become plain links, raw media HTML
//   (img, iframe, video, ...) is shown as text, and a CSS `url(` in a style
//   attribute is broken, so nothing is fetched from the network.
// The lines inside a fence are never changed. Pure: no obsidian import.

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
  "mermaid",
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
 * A line's containers: blockquote marks (`>`, also nested and callouts),
 * then a list marker or indent. `rest` is what follows them.
 */
const CONTAINERS = /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(.*)$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const REMOTE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi;
/** `![alt][ref]`, `![alt][]` and the shortcut `![alt]` (never a `![[wikilink]]` embed or an inline `![alt](..)`). */
const REFERENCE_IMAGE = /!\[(?!\[)([^\]\n]*)\](?!\()(\[[^\]\n]*\])?/g;
const MEDIA_TAG = /<(\/?)(img|iframe|video|audio|object|embed|source|picture|link|script|style|svg|frame|frameset|meta|base)\b/gi;
const STYLE_ATTR = /\bstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const RAW_CODE = /(<code\b[^>]*>)(\s*)(\$?=)/gi;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
const ZW = "\u200B";

function safeText(text: string): string {
  return text
    .replace(REMOTE_IMAGE, (_m, alt: string, url: string) => `[${alt.trim() || url}](${url})`)
    .replace(REFERENCE_IMAGE, (_m, alt: string, ref: string | undefined) => `[${alt}]${ref ?? ""}`)
    .replace(STYLE_ATTR, (attr: string) => attr.replace(/url\s*\(/gi, "blocked-url("))
    .replace(RAW_CODE, (_m, open: string, space: string, query: string) => `${open}${space}${ZW}${query}`)
    .replace(MEDIA_TAG, "&lt;$1$2");
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

interface OpenFence {
  char: string;
  len: number;
  /** Blockquote marks the fence sits in: a line with fewer ends it. */
  quotes: number;
  /** Columns of its list item: a non-blank line indented less ends it. */
  indent: number;
}

function quoteCount(prefix: string): number {
  return (prefix.match(/>/g) ?? []).length;
}

export function safeAnswerMarkdown(text: string): string {
  let open: OpenFence | null = null;
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const c = line.match(CONTAINERS);
    const quotes = quoteCount(c?.[1] ?? "");
    const inner = c ? c[2] + c[3] : line;
    if (open) {
      const ended = quotes < open.quotes || (inner.trim() !== "" && open.indent > 0 && inner.length - inner.trimStart().length < open.indent);
      if (!ended) {
        const close = inner.trim().match(FENCE);
        if (close && close[1][0] === open.char && close[1].length >= open.len && close[2].trim() === "") open = null;
        out.push(line);
        continue;
      }
      // The container ended, so the fence did too: this line is read as any other.
      open = null;
    }
    const rest = (c?.[3] ?? line).replace(/^[ \t]+/, "");
    const fence = rest.match(FENCE);
    // A backtick fence's info string cannot hold a backtick (CommonMark): such a line is inline code.
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const head = line.slice(0, line.length - rest.length);
      const lang = fence[2].trim().split(/\s+/)[0] ?? "";
      open = { char: fence[1][0], len: fence[1].length, quotes, indent: c && c[2].trim() ? c[2].length : 0 };
      out.push(SAFE_LANGUAGES.has(lang.toLowerCase()) ? line : `${head}${fence[1]}text`);
      continue;
    }
    out.push(safeLine(line));
  }
  return out.join("\n");
}
