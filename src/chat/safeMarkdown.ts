// What the panel renders of a model's answer (2.1.0 spec 5.4). The answer
// goes through Obsidian's MarkdownRenderer, which also runs other plugins'
// code block processors and loads remote resources, and an answer is
// untrusted text (the prompt carries lecture material that may hold
// anything). So before rendering:
// - a fence in a language another plugin executes or queries the vault
//   with (Dataview and DataviewJS, Datacore, JS Engine, Tasks, Meta Bind,
//   embedded search, ...) becomes a plain `text` fence with the same lines;
// - inline code that Dataview would run (`= ...`, `$= ...`) gets a zero-width
//   space in front, so it stays code;
// - a remote image becomes a plain link, and raw media HTML (img, iframe,
//   video, ...) is shown as text, so nothing is fetched from the network.
// Code is never changed otherwise. Pure: no obsidian import.

/** Fence languages another plugin runs as code or as a vault query. */
export const EXECUTABLE_LANGUAGES = new Set([
  "dataview",
  "dataviewjs",
  "datacore",
  "datacorejs",
  "datacorejsx",
  "datacorets",
  "datacoretsx",
  "js-engine",
  "js-engine-debug",
  "tasks",
  "query",
  "button",
  "meta-bind",
  "meta-bind-js-view",
  "meta-bind-embed",
  "templater",
  "run-js",
  "run-javascript",
  "chart",
  "tracker",
]);

function executable(lang: string): boolean {
  const l = lang.toLowerCase().replace(/^\{|\}$/g, "");
  return EXECUTABLE_LANGUAGES.has(l) || /^(dataview|datacore|js-engine|meta-bind|run-)/.test(l);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const REMOTE_IMAGE = /!\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi;
const MEDIA_TAG = /<(\/?)(img|iframe|video|audio|object|embed|source|picture|link|script|style|svg|frame|frameset)\b/gi;
const INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;

function safeText(text: string): string {
  return text.replace(REMOTE_IMAGE, (_m, alt: string, url: string) => `[${alt.trim() || url}](${url})`).replace(MEDIA_TAG, "&lt;$1$2");
}

/** One line outside fences: its inline code kept (an inline Dataview query defused), the rest made safe. */
function safeLine(line: string): string {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    out += safeText(line.slice(last, at));
    const code = m[2];
    out += /^\s*\$?=/.test(code) ? `${m[1]}\u200B${code}${m[1]}` : m[0];
    last = at + m[0].length;
  }
  return out + safeText(line.slice(last));
}

export function safeAnswerMarkdown(text: string): string {
  let open: { char: string; len: number } | null = null;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const m = line.match(FENCE);
      if (open) {
        if (m && m[2][0] === open.char && m[2].length >= open.len && m[3].trim() === "") open = null;
        return line;
      }
      // A backtick fence's info string cannot hold a backtick (CommonMark): such a line is inline code.
      if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
        open = { char: m[2][0], len: m[2].length };
        const lang = m[3].trim().split(/\s+/)[0] ?? "";
        return lang && executable(lang) ? `${m[1]}${m[2]}text` : line;
      }
      return safeLine(line);
    })
    .join("\n");
}
