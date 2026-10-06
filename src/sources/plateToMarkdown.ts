// Minimal plate-json to markdown converter for Alt summaries and memos
// (`note_components.content_text` with metadata.contentFormat "plate-json").
// Alt's HTTP API returns the raw plate JSON too, so both local sources use it.
//
// Covered: h1 to h6, paragraphs, Plate "indent lists" (paragraphs with
// `listStyleType` disc/decimal/... and `indent`, `listStart`), blockquote,
// code_block/code_line, hr, tables (th/td), links (`a` with url), mentions,
// equations (`$...$`, `$$...$$`), recording timestamps ([mm:ss]), and the
// marks bold, italic, code, strikethrough, underline. Unknown elements
// render their text children as a paragraph, so no text is lost.

interface PlateNode {
  type?: string;
  text?: string;
  children?: PlateNode[];
  [key: string]: unknown;
}

function isText(n: PlateNode): boolean {
  return typeof n.text === "string";
}

function escapeText(s: string): string {
  // Keep text readable: escape only what would start unintended markup.
  return s.replace(/([\\`*_[\]])/g, "\\$1");
}

function renderLeaf(n: PlateNode): string {
  const raw = n.text ?? "";
  if (raw === "") return "";
  if (n.code) return "`" + raw.replace(/`/g, "ˋ") + "`";
  const s = escapeText(raw);
  // Marks wrap the trimmed text so "** bold**" never appears.
  const lead = s.match(/^\s*/)![0];
  const trail = s.match(/\s*$/)![0];
  let core = s.trim();
  if (core === "") return s;
  if (n.bold) core = `**${core}**`;
  if (n.italic) core = `*${core}*`;
  if (n.strikethrough) core = `~~${core}~~`;
  if (n.underline) core = `<u>${core}</u>`;
  return lead + core + trail;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderInline(nodes: PlateNode[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (isText(n)) return renderLeaf(n);
      switch (n.type) {
        case "a": {
          const label = renderInline(n.children) || String(n.url ?? "");
          return n.url ? `[${label}](${String(n.url)})` : label;
        }
        case "inline_equation":
          return n.texExpression ? `$${String(n.texExpression)}$` : renderInline(n.children);
        case "mention":
          return n.value ? `@${String(n.value)}` : renderInline(n.children);
        case "recording_timestamp":
          return typeof n.ms === "number" ? `[${formatMs(n.ms)}]` : renderInline(n.children);
        default:
          return renderInline(n.children);
      }
    })
    .join("");
}

function tableToMarkdown(table: PlateNode): string {
  const rows = (table.children ?? []).map((tr) =>
    (tr.children ?? []).map((cell) =>
      (cell.children ?? [])
        .map((c) => (isText(c) ? renderLeaf(c) : renderInline(c.children)))
        .join(" ")
        .replace(/\|/g, "\\|")
        .replace(/\n+/g, " ")
        .trim()
    )
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...new Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]), line(new Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/** Markdown for a plate document (array of block nodes). */
export function plateToMarkdown(doc: unknown): string {
  if (!Array.isArray(doc)) return "";
  const blocks: string[] = [];
  // Numbering per indent level for decimal lists; reset by other blocks.
  const counters = new Map<number, number>();
  let prevWasList = false;

  for (const node of doc as PlateNode[]) {
    if (!node || typeof node !== "object") continue;
    const type = node.type ?? "p";
    const listStyle = typeof node.listStyleType === "string" ? node.listStyleType : null;
    const indent = typeof node.indent === "number" && node.indent > 0 ? node.indent : 0;

    if (listStyle) {
      const level = Math.max(1, indent);
      for (const k of Array.from(counters.keys())) if (k > level) counters.delete(k);
      const pad = "  ".repeat(level - 1);
      const text = renderInline(node.children).trim();
      let bullet = "-";
      if (listStyle === "todo") bullet = node.checked ? "- [x]" : "- [ ]";
      else if (listStyle === "decimal" || listStyle === "lower-alpha" || listStyle === "upper-alpha" || listStyle === "lower-roman" || listStyle === "upper-roman") {
        const start = typeof node.listStart === "number" ? node.listStart : (counters.get(level) ?? 0) + 1;
        counters.set(level, start);
        bullet = `${start}.`;
      }
      if (type.match(/^h[1-6]$/)) {
        blocks.push(`${pad}${bullet} ${"#".repeat(Number(type[1]))} ${text}`);
      } else {
        blocks.push(`${pad}${bullet} ${text}`);
      }
      prevWasList = true;
      continue;
    }
    const todoItem = type === "action_item" || type === "todo" || type === "todo_li";
    if (!todoItem) counters.clear();
    // Lists are joined line by line; a new block after a list starts a paragraph.
    if (prevWasList && !todoItem) blocks.push("");
    prevWasList = false;

    const m = type.match(/^h([1-6])$/);
    if (m) {
      blocks.push(`${"#".repeat(Number(m[1]))} ${renderInline(node.children).trim()}`, "");
      continue;
    }
    switch (type) {
      case "action_item":
      case "todo":
      case "todo_li": {
        const pad = "  ".repeat(Math.max(0, indent - 1));
        blocks.push(`${pad}${node.checked ? "- [x]" : "- [ ]"} ${renderInline(node.children).trim()}`);
        prevWasList = true;
        break;
      }
      case "blockquote": {
        const text = renderInline(node.children).trim();
        blocks.push(text.split("\n").map((l) => `> ${l}`).join("\n"), "");
        break;
      }
      case "code_block": {
        const lines = (node.children ?? []).map((line) =>
          (line.children ?? []).map((c) => (isText(c) ? c.text : "")).join("")
        );
        const lang = typeof node.lang === "string" ? node.lang : "";
        blocks.push("```" + lang, ...lines, "```", "");
        break;
      }
      case "hr":
        blocks.push("---", "");
        break;
      case "table":
        blocks.push(tableToMarkdown(node), "");
        break;
      case "equation":
        blocks.push(`$$\n${String(node.texExpression ?? renderInline(node.children))}\n$$`, "");
        break;
      default: {
        // Containers (toggle, callout, column_group, column, and unknown
        // elements holding blocks) render their blocks recursively.
        if (hasBlockChildren(node)) {
          const inner = plateToMarkdown(node.children);
          if (inner) blocks.push(type === "callout" ? inner.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n") : inner, "");
          break;
        }
        const text = renderInline(node.children).trim();
        blocks.push(text, "");
      }
    }
  }
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const INLINE_TYPES = new Set(["a", "inline_equation", "mention", "recording_timestamp"]);

/** An element whose children are blocks, not text runs. */
function hasBlockChildren(node: PlateNode): boolean {
  return (node.children ?? []).some((c) => !isText(c) && !!c.type && !INLINE_TYPES.has(c.type));
}

/** Every `text` string anywhere in the value, one per line: the fallback when conversion yields nothing. */
function plainText(value: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "text" && typeof x === "string") {
          if (x.trim()) out.push(x);
        } else walk(x);
      }
    }
  };
  walk(value);
  return out.join("\n");
}

/** Parse a component's content_text; plate JSON or plain text. */
export function componentTextToMarkdown(contentText: string | null | undefined, metadata: unknown): string {
  if (!contentText) return "";
  let format = "";
  try {
    const meta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
    format = (meta as { contentFormat?: string } | null)?.contentFormat ?? "";
  } catch {
    format = "";
  }
  const trimmed = contentText.trim();
  if (format === "plate-json" || trimmed.startsWith("[{")) {
    try {
      const doc = JSON.parse(trimmed);
      const md = plateToMarkdown(doc);
      // An unexpected shape converts to nothing: keep its text rather than lose it.
      return md || plainText(doc).trim();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}
