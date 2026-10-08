// Notion page input for the note verifier over the user's Notion MCP
// (spec 4.6 input, D2 optional path). No obsidian import.
//
// The user's Claude CLI runs once and may only call the Notion fetch tool.
// The page content and its last edited time are read from that tool's
// result in the stream-json output, never from the model's text, so the
// model cannot shorten or change them (and CLAUDE.md or other context
// cannot alter them either). The model only has to call the tool.
//
// Flags of the call (checked with Claude Code 2.1.283):
//   --tools ""                       no built-in tools (no files, no shell)
//   --permission-mode dontAsk        a tool that is not allowed is denied
//   --allowedTools mcp__<server>__notion-fetch
//   --disallowedTools ...            the server's other tools, and every
//                                    other MCP server (mcp__<name>), by name
//   --setting-sources ""             no user, project or local settings, so
//                                    no allow rules of the user widen the set
//   --settings {"disableAllHooks":true}
//                                    no hooks run
//   --no-session-persistence, --disable-slash-commands, own --system-prompt
// A Notion server the user added (`claude mcp get` shows an http or sse
// URL without headers) is passed alone with --strict-mcp-config and
// --mcp-config under the same name, which reuses its stored OAuth login:
// checked on 2026-09-28, the init event listed only notion-fetch and the
// server as "connected", about 2k input tokens per call. A plugin's server
// is restated the same way from the plugin's own .mcp.json when it has an
// http or sse URL without headers (not checked with a real call). A
// claude.ai connector, or a server that cannot be restated, runs without
// --strict-mcp-config with every other MCP server denied; a plugin's
// server then needs --setting-sources user (the user settings enable the
// plugin), still with hooks off. No --safe-mode: it switches MCP servers
// off.
//
// Only fetch calls for the requested page count (the tool input's id or
// URL names it); the first successful one is the page, and more than one
// fetch is warned about. A result Claude Code saved to a file for being
// too large is read from that file when it is under
// ~/.claude/projects/**/tool-results/, else flagged as truncated.
//
// The markdown is cached outside the vault (the transcript cache folder,
// 0600) with the page's last edited time, for a reproducible record of
// what was checked; an unchanged page is reported as such.

import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { homedir } from "os";
import { isAbsolute, join, relative, sep } from "path";
import { renderPrompt } from "../prompts/render";
import { CliCall, CliCallResult, CliProviderBase } from "../llm/cli/CliProviderBase";
import { buildClaudeInput, findClaudeResult, parseClaudeOutput } from "../llm/cli/ClaudeCliProvider";
import { CliRunError, runCli, unknownOptionMessage } from "../llm/cli/CliRunner";
import notionFetchTemplate from "../../prompts/notion-fetch.md";

export const NOTION_FETCH_TOOL = "notion-fetch";

export const NOTION_SETUP_GUIDE =
  "Claude CLI에 연결된 Notion MCP를 찾지 못했습니다. 터미널에서 `claude mcp add --transport http notion https://mcp.notion.com/mcp`를 실행하고, " +
  "`claude`를 열어 `/mcp`에서 Notion에 로그인한 뒤 다시 시도하세요. 그 전에는 노션 페이지를 마크다운으로 내보내 vault에 넣고 '보관함 파일'로 검증할 수 있습니다.";

export class NotionMcpMissingError extends Error {
  constructor(detail = "") {
    super(detail ? `${NOTION_SETUP_GUIDE} (${detail})` : NOTION_SETUP_GUIDE);
  }
}

/**
 * Every tool of the hosted Notion MCP except notion-fetch (its tool list on
 * 2026-09-28), denied by name so they are neither callable nor sent to the
 * model as definitions.
 */
export const NOTION_OTHER_TOOLS = [
  "notion-ai-search",
  "notion-check-mcp-next-steps",
  "notion-convert-page-to-skill",
  "notion-create-attachment",
  "notion-create-comment",
  "notion-create-database",
  "notion-create-file-upload",
  "notion-create-folder",
  "notion-create-pages",
  "notion-create-view",
  "notion-download-attachment",
  "notion-download-skill",
  "notion-duplicate-page",
  "notion-get-async-task",
  "notion-get-comments",
  "notion-get-session-status",
  "notion-get-teams",
  "notion-get-tool-access",
  "notion-get-users",
  "notion-list-favorite-pages",
  "notion-list-private-pages",
  "notion-list-recent-pages",
  "notion-list-session-events",
  "notion-list-shared-pages",
  "notion-move-pages",
  "notion-query-data-sources",
  "notion-query-meeting-notes",
  "notion-query-multiple-data-sources",
  "notion-query-sessions",
  "notion-read-session-event",
  "notion-search",
  "notion-search-agents",
  "notion-search-sessions",
  "notion-search-skills",
  "notion-send-message-to-session",
  "notion-show-advanced-analysis-next-steps",
  "notion-spawn-session",
  "notion-stop-session",
  "notion-update-data-source",
  "notion-update-folder",
  "notion-update-page",
  "notion-update-view",
  "notion-upload-skill",
  "notion-wait-session",
];

export interface McpServerEntry {
  name: string;
  connected: boolean;
}

/**
 * `claude mcp list` lines: `<name>: <command or url> - ✔ Connected`
 * (claude.ai connectors are named "claude.ai Notion", plugin servers
 * "plugin:<plugin>:<server>").
 */
export function parseMcpList(stdout: string): McpServerEntry[] {
  const out: McpServerEntry[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.+?): \S.* - (.+)$/);
    if (!m || /^\[/.test(line)) continue;
    out.push({ name: m[1].trim(), connected: /✔|✓|connected/i.test(m[2]) && !/failed|needs auth/i.test(m[2]) });
  }
  return out;
}

/** The Notion server: a name containing "notion", a connected one first. */
export function findNotionServer(servers: McpServerEntry[]): McpServerEntry | null {
  const notion = servers.filter((s) => /notion/i.test(s.name));
  return notion.find((s) => s.connected) ?? notion[0] ?? null;
}

/** Claude Code's name of a server in tool names: non-name characters as "_". */
export function mcpServerKey(server: string): string {
  return server.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Claude Code tool name of an MCP server's tool: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool = NOTION_FETCH_TOOL): string {
  return `mcp__${mcpServerKey(server)}__${tool}`;
}

export function isSafeToolName(name: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name);
}

export interface McpServerDetails {
  scope: string;
  type: string;
  url: string | null;
  hasHeaders: boolean;
}

/** `claude mcp get <name>`: Scope, Type, URL and whether headers are set. */
export function parseMcpGet(stdout: string): McpServerDetails | null {
  const field = (key: string) => stdout.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "mi"))?.[1].trim() ?? null;
  const type = field("Type");
  if (!type) return null;
  return { scope: field("Scope") ?? "", type: type.toLowerCase(), url: field("URL"), hasHeaders: /^\s*Headers:/mi.test(stdout) };
}

/** --mcp-config JSON with only this server, or null when it cannot be restated (stdio, headers, no URL). */
export function strictMcpConfig(server: string, details: McpServerDetails | null): string | null {
  if (!details || details.hasHeaders || !details.url || !/^(http|sse)$/.test(details.type)) return null;
  if (!/^https:\/\//.test(details.url)) return null;
  return JSON.stringify({ mcpServers: { [server]: { type: details.type, url: details.url } } });
}

export interface NotionCallPlan {
  toolName: string;
  /** --setting-sources: "" (none), or "user" when the server comes from a plugin the user settings enable. */
  settingSources: "" | "user";
  /** --mcp-config JSON (with --strict-mcp-config), or null for the user's own set. */
  strictConfig: string | null;
  /** --disallowedTools entries. */
  deny: string[];
}

/** The tools the call may not use: the Notion server's others, and every other server (non-strict only). */
export function notionDenyList(toolName: string, otherServers: string[], strict: boolean): string[] {
  const prefix = toolName.slice(0, toolName.lastIndexOf("__") + 2);
  const deny = NOTION_OTHER_TOOLS.map((t) => prefix + t);
  if (!strict) for (const s of otherServers) deny.push(`mcp__${mcpServerKey(s)}`);
  return deny;
}

export function buildNotionFetchArgs(input: { model: string; effort: string; plan: NotionCallPlan }): string[] {
  const { plan } = input;
  if (!isSafeToolName(plan.toolName)) throw new Error(`Notion 도구 이름이 올바르지 않습니다: ${plan.toolName}`);
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    plan.settingSources,
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--disable-slash-commands",
    "--system-prompt",
    "You fetch one Notion page with the only tool you have. Call it once, then answer DONE.",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    plan.toolName,
  ];
  if (plan.deny.length > 0) args.push("--disallowedTools", plan.deny.join(","));
  if (plan.strictConfig) args.push("--strict-mcp-config", "--mcp-config", plan.strictConfig);
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--effort", input.effort);
  return args;
}

/** Notion page id (32 hex, dashes optional) in a URL, else null. */
export function notionPageId(url: string): string | null {
  const m = url.replace(/-/g, "").match(/([0-9a-f]{32})(?:[?#]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

export function isNotionUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && /(^|\.)notion\.(so|site|com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** What the fetch tool is given: notion.so and notion.site links as they are, a notion.com link as https://www.notion.so/<id>. */
export function notionFetchUrl(url: string): string {
  const u = url.trim();
  if (!/(^|\.)notion\.com$/.test(new URL(u).hostname)) return u;
  const id = notionPageId(u);
  if (!id) throw new Error("노션 링크에서 페이지 ID를 찾지 못했습니다. 페이지의 '링크 복사'로 얻은 링크를 넣어 주세요.");
  return `https://www.notion.so/${id}`;
}

export function buildNotionFetchPrompt(url: string): string {
  return renderPrompt(notionFetchTemplate, { url: url.trim() });
}

// ---- the tool result in stream-json ----

export interface NotionToolOutput {
  /** Any call of the fetch tool happened. */
  toolUsed: boolean;
  /** Calls of the fetch tool (any page). More than one is warned about. */
  fetchCount: number;
  /** A call for the requested page happened. */
  matched: boolean;
  /** Text of the first successful result for the requested page, else of its last failed one; null when none. */
  resultText: string | null;
  isError: boolean;
  /** The run ended on the output limit. */
  stopReason: string | null;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n");
  return "";
}

/** The fetch tool's input names the requested page (its id, or the same URL). */
export function fetchInputMatches(input: unknown, url: string): boolean {
  const i = input as { id?: unknown; url?: unknown } | null;
  const given = typeof i?.id === "string" ? i.id : typeof i?.url === "string" ? i.url : "";
  if (!given) return false;
  if (given.trim() === url.trim()) return true;
  const want = notionPageId(url);
  const got = notionPageId(given) ?? (/^[0-9a-f-]{32,36}$/i.test(given.trim()) ? given.replace(/-/g, "").toLowerCase() : null);
  return !!want && want === got;
}

/**
 * The fetch tool's calls and results from `claude -p --output-format
 * stream-json` stdout. Only calls for the requested page count, and the
 * first successful result of those is the page.
 */
export function parseNotionStream(stdout: string, toolName: string, url: string): NotionToolOutput {
  const matching = new Set<string>();
  const out: NotionToolOutput = { toolUsed: false, fetchCount: 0, matched: false, resultText: null, isError: false, stopReason: null };
  let done = false;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: { type?: string; message?: { content?: unknown; stop_reason?: string }; stop_reason?: string };
    try {
      ev = JSON.parse(t) as typeof ev;
    } catch {
      continue;
    }
    const content = Array.isArray(ev.message?.content) ? (ev.message.content as Array<Record<string, unknown>>) : [];
    if (ev.type === "assistant") {
      for (const c of content) {
        if (c.type !== "tool_use" || c.name !== toolName) continue;
        out.toolUsed = true;
        out.fetchCount++;
        if (typeof c.id === "string" && fetchInputMatches(c.input, url)) {
          matching.add(c.id);
          out.matched = true;
        }
      }
      if (ev.message?.stop_reason) out.stopReason = ev.message.stop_reason;
    } else if (ev.type === "user") {
      for (const c of content) {
        if (done || c.type !== "tool_result" || typeof c.tool_use_id !== "string" || !matching.has(c.tool_use_id)) continue;
        out.resultText = blockText(c.content);
        out.isError = c.is_error === true;
        if (!out.isError) done = true;
      }
    } else if (ev.type === "result" && ev.stop_reason) {
      out.stopReason = ev.stop_reason;
    }
  }
  return out;
}

/** Claude Code's wrapper around a large tool output it saved to a file instead. */
const PERSISTED_WRAPPER = "<persisted-output>";

/**
 * Claude Code's project folder name for a working folder: every character
 * other than a letter, digit or "-" becomes "-" ("/private/tmp/x_y" ->
 * "-private-tmp-x-y").
 */
export function claudeProjectKey(dir: string): string {
  return dir.replace(/[^A-Za-z0-9-]/g, "-");
}

/** Allowed clock skew between the call start and the saved file's mtime (coarse file-system timestamps). */
const MTIME_SLACK_MS = 2000;

/**
 * When Claude Code saved this call's large tool result to a file, the full
 * text from that file. Only honoured when the result itself starts with
 * Claude Code's `<persisted-output>` wrapper (the same words inside the
 * page are page text), and only for a file under
 * `<home>/.claude/projects/<this call's working folder>/**\/tool-results/`
 * (checked on the resolved path) written since the call started. Any other
 * wrapped result is marked truncated.
 */
export async function resolvePersistedOutput(
  text: string,
  opts: { home: string; workDir: string; callStart: number }
): Promise<{ text: string; persisted: boolean; truncated: boolean }> {
  if (!text.trimStart().startsWith(PERSISTED_WRAPPER)) return { text, persisted: false, truncated: false };
  // Claude Code's line right after the wrapper: "Output too large (...). Full output saved to: <path>".
  // The path runs to the end of that line (it may hold spaces).
  const head = text.trimStart().split("\n").slice(0, 3).join("\n");
  const path = head.match(/Full output saved to:[ \t]*(.+?)[ \t]*$/m)?.[1];
  if (!path) return { text, persisted: true, truncated: true };
  try {
    const root = await fsp.realpath(join(opts.home, ".claude", "projects"));
    const real = await fsp.realpath(path);
    const rel = relative(root, real);
    const parts = rel.split(sep);
    if (rel.startsWith("..") || isAbsolute(rel) || !parts.includes("tool-results")) return { text, persisted: true, truncated: true };
    // This call's project folder: its working folder, as given or resolved.
    const keys = new Set([claudeProjectKey(opts.workDir)]);
    try {
      keys.add(claudeProjectKey(await fsp.realpath(opts.workDir)));
    } catch {
      // the folder may be gone already; the given path still counts
    }
    if (!keys.has(parts[0])) return { text, persisted: true, truncated: true };
    const st = await fsp.stat(real);
    if (st.mtimeMs < opts.callStart - MTIME_SLACK_MS) return { text, persisted: true, truncated: true };
    return { text: await fsp.readFile(real, "utf8"), persisted: true, truncated: false };
  } catch {
    return { text, persisted: true, truncated: true };
  }
}

export interface NotionPage {
  markdown: string;
  lastEdited: string | null;
  /** The page was cut: Notion's `truncated`, or Claude Code's large-output cut. */
  truncated: boolean;
}

/**
 * Page markdown and last edited time from notion-fetch's result: a JSON
 * object (`text`, `page_last_edited_at`, `truncated`), or plain text.
 */
export function pageFromToolResult(text: string): NotionPage {
  let markdown = text;
  let lastEdited: string | null = null;
  let truncated = false;
  try {
    const obj = JSON.parse(text) as Record<string, unknown> | null;
    if (obj && typeof obj === "object") {
      const body = [obj.text, obj.markdown, obj.content].find((v) => typeof v === "string");
      if (typeof body === "string") markdown = body;
      const edited = obj.page_last_edited_at ?? obj.last_edited_time;
      if (typeof edited === "string") lastEdited = edited;
      truncated = obj.truncated === true;
    }
  } catch {
    lastEdited = text.match(/"?(?:page_last_edited_at|last_edited_time)"?\s*[:=]\s*"?([0-9][0-9T:.+\-Z]+)/)?.[1] ?? null;
    truncated = /"?truncated"?\s*[:=]\s*true/.test(text);
  }
  // Claude Code cuts or saves very large tool outputs and says so.
  if (/\[truncated\]|output (?:was )?truncated|exceeds maximum allowed tokens|too large to include/i.test(text.slice(-2000))) truncated = true;
  return { markdown: markdown.trimEnd() + "\n", lastEdited, truncated };
}

// ---- cache (outside the vault) ----

export interface NotionCacheEntry {
  v: 1;
  url: string;
  lastEdited: string | null;
  fetchedAt: string;
  markdown: string;
}

export function notionCachePath(cacheDir: string, url: string): string {
  const key = notionPageId(url) ?? createHash("sha1").update(url.trim()).digest("hex").slice(0, 32);
  return join(cacheDir, `${key}.json`);
}

export async function readNotionCache(cacheDir: string, url: string): Promise<NotionCacheEntry | null> {
  try {
    const entry = JSON.parse(await fsp.readFile(notionCachePath(cacheDir, url), "utf8")) as { v?: unknown; markdown?: unknown } | null;
    return entry && entry.v === 1 && typeof entry.markdown === "string" ? (entry as NotionCacheEntry) : null;
  } catch {
    return null;
  }
}

async function writeNotionCache(cacheDir: string, entry: NotionCacheEntry): Promise<void> {
  await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const path = notionCachePath(cacheDir, entry.url);
  await fsp.writeFile(path, JSON.stringify(entry), { mode: 0o600 });
  await fsp.chmod(path, 0o600);
}

// ---- the call ----

/** Claude CLI provider variant with the Notion-only flags; usage recorded like every call. */
export class NotionFetchProvider extends CliProviderBase {
  name = "Claude CLI (Notion)";
  maxInputTokens = 200000;
  readonly providerId = "claude-cli" as const;
  protected usesFiles = false;
  plan: NotionCallPlan = { toolName: "", settingSources: "", strictConfig: null, deny: [] };
  /** The requested page: only its fetch results count. */
  pageUrl = "";

  protected async invoke(call: CliCall): Promise<CliCallResult> {
    const args = buildNotionFetchArgs({ model: this.config.model, effort: this.config.effort, plan: this.plan });
    try {
      const out = await runCli({
        bin: this.config.bin,
        args,
        input: buildClaudeInput(call),
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        signal: call.signal,
      });
      return { ...parseClaudeOutput(out.stdout), structured: parseNotionStream(out.stdout, this.plan.toolName, this.pageUrl) };
    } catch (e) {
      const tooOld = e instanceof CliRunError && e.kind === "exit" ? unknownOptionMessage("claude", e.stderr) : null;
      if (tooOld) throw new CliRunError("spawn", tooOld, e instanceof CliRunError ? e.stderr : "");
      if (e instanceof CliRunError && e.kind === "exit" && e.stdout) {
        const res = findClaudeResult(e.stdout);
        if (res?.result) {
          e.message = `Claude CLI 오류: ${String(res.result).slice(0, 300)}`;
          e.cliError = String(res.result);
        }
      }
      throw e;
    }
  }
}

export interface NotionFetchResult {
  markdown: string;
  lastEdited: string | null;
  /** Same last edited time as the cached copy: the page did not change since the last fetch. */
  unchanged: boolean;
  server: string;
  /** Strict MCP config (only the Notion server) was used. */
  strict: boolean;
  warnings: string[];
}

async function runQuiet(bin: string, args: string[], workDir: string, signal?: AbortSignal): Promise<string> {
  return (await runCli({ bin, args, cwd: workDir, timeoutMs: 90_000, signal })).stdout;
}

/** The MCP servers from `claude mcp list` (no model call); throws NotionMcpMissingError without a connected Notion server. */
export async function detectNotionServer(bin: string, workDir: string, signal?: AbortSignal): Promise<{ server: McpServerEntry; all: McpServerEntry[] }> {
  let stdout: string;
  try {
    stdout = await runQuiet(bin, ["mcp", "list"], workDir, signal);
  } catch (e) {
    if (e instanceof CliRunError && e.kind === "aborted") throw e;
    throw new NotionMcpMissingError(`claude mcp list 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  const all = parseMcpList(stdout);
  const server = findNotionServer(all);
  if (!server) throw new NotionMcpMissingError();
  if (!server.connected) throw new NotionMcpMissingError(`${server.name} 서버가 연결되어 있지 않습니다`);
  return { server, all };
}

/**
 * Raw markdown of a Notion page, taken from the fetch tool's result, and
 * cached with its last edited time. `toolName` overrides the detected
 * fetch tool (settings).
 */
/** "plugin:<plugin>:<server>" parts, or null. */
export function pluginServerParts(name: string): { plugin: string; server: string } | null {
  const m = name.match(/^plugin:([^:]+):(.+)$/);
  return m ? { plugin: m[1], server: m[2] } : null;
}

/** Server entry of a plugin's .mcp.json (`{"mcpServers":{...}}` or the map itself) as McpServerDetails. */
export function detailsFromMcpJson(json: unknown, server: string): McpServerDetails | null {
  const root = json as { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
  const entry = (root?.mcpServers?.[server] ?? root?.[server]) as { type?: unknown; url?: unknown; headers?: unknown } | undefined;
  if (!entry || typeof entry !== "object") return null;
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : typeof entry.url === "string" ? "http" : "";
  if (!type) return null;
  const headers = entry.headers && typeof entry.headers === "object" && Object.keys(entry.headers).length > 0;
  return { scope: "plugin", type, url: typeof entry.url === "string" ? entry.url : null, hasHeaders: !!headers };
}

/** Newest first by the x.y.z version in a label ("1.10.0" after "1.9.2"); unversioned last. */
function newestFirst<T>(items: T[], versionOf: (t: T) => string): T[] {
  const key = (t: T) => versionOf(t).match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? null;
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (!ka || !kb) return ka ? -1 : kb ? 1 : 0;
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
}

async function serverFromPluginDir(dir: string, server: string): Promise<McpServerDetails | null> {
  for (const f of [join(dir, ".mcp.json"), join(dir, ".claude-plugin", "plugin.json")]) {
    try {
      const json = JSON.parse(await fsp.readFile(f, "utf8")) as { mcpServers?: unknown } | null;
      const d = detailsFromMcpJson(f.endsWith("plugin.json") ? { mcpServers: json?.mcpServers } : json, server);
      if (d) return d;
    } catch {
      // missing or unreadable: the next file
    }
  }
  return null;
}

/**
 * The server entry of an installed plugin: the install paths listed in
 * `<home>/.claude/plugins/installed_plugins.json` (newest version first),
 * else a walk of `<home>/.claude/plugins` for the plugin's folders, newest
 * version folder first. Null when none has it.
 */
export async function findPluginMcpServer(home: string, plugin: string, server: string): Promise<McpServerDetails | null> {
  const root = join(home, ".claude", "plugins");
  try {
    const installed = JSON.parse(await fsp.readFile(join(root, "installed_plugins.json"), "utf8")) as { plugins?: unknown } | null;
    const map = (installed?.plugins ?? installed) as Record<string, unknown>;
    const entries: Array<{ installPath: string; version: string }> = [];
    for (const [key, list] of Object.entries(map ?? {})) {
      if (key.split("@")[0] !== plugin || !Array.isArray(list)) continue;
      for (const e of list as Array<{ installPath?: unknown; version?: unknown }>) {
        if (typeof e?.installPath === "string") entries.push({ installPath: e.installPath, version: typeof e.version === "string" ? e.version : e.installPath });
      }
    }
    for (const e of newestFirst(entries, (x) => x.version)) {
      const d = await serverFromPluginDir(e.installPath, server);
      if (d) return d;
    }
    if (entries.length > 0) return null;
  } catch {
    // no installed_plugins.json: walk the plugin folders
  }
  const dirs: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6 || dirs.length > 50) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".git")) await walk(p, depth + 1);
      else if (e.isFile() && e.name === ".mcp.json" && p.split(sep).includes(plugin)) dirs.push(dir);
    }
  };
  await walk(root, 0);
  for (const dir of newestFirst(dirs, (d) => d.split(sep).pop() ?? "")) {
    const d = await serverFromPluginDir(dir, server);
    if (d) return d;
  }
  return null;
}

/**
 * Raw markdown of a Notion page, taken from the fetch tool's result for
 * that page, and cached with its last edited time. `toolName` overrides
 * the detected fetch tool (settings); `home` is the user's home folder
 * (tests).
 */
export async function fetchNotionPage(
  provider: NotionFetchProvider,
  opts: { bin: string; url: string; cacheDir: string; workDir: string; toolName?: string; signal?: AbortSignal; home?: string }
): Promise<NotionFetchResult> {
  if (!isNotionUrl(opts.url)) throw new Error("노션 페이지 URL(https://www.notion.so/... 또는 https://app.notion.com/p/...)을 넣어 주세요.");
  const fetchUrl = notionFetchUrl(opts.url);
  const home = opts.home ?? homedir();
  const { server, all } = await detectNotionServer(opts.bin, opts.workDir, opts.signal);
  const toolName = opts.toolName?.trim() || mcpToolName(server.name);
  let details: McpServerDetails | null = null;
  const pluginParts = pluginServerParts(server.name);
  if (pluginParts) {
    // A plugin's server: restated from its own .mcp.json when that is possible.
    details = await findPluginMcpServer(home, pluginParts.plugin, pluginParts.server);
  } else if (!/^claude\.ai /.test(server.name)) {
    // A claude.ai connector cannot be restated; a server the user added can.
    try {
      details = parseMcpGet(await runQuiet(opts.bin, ["mcp", "get", server.name], opts.workDir, opts.signal));
    } catch (e) {
      if (e instanceof CliRunError && e.kind === "aborted") throw e;
      details = null;
    }
  }
  const strictConfig = strictMcpConfig(server.name, details);
  const others = all.map((s) => s.name).filter((n) => n !== server.name);
  // A plugin's server without a strict config loads only with the user settings (they enable the plugin).
  const settingSources: "" | "user" = pluginParts && !strictConfig ? "user" : "";
  provider.plan = { toolName, settingSources, strictConfig, deny: notionDenyList(toolName, others, !!strictConfig) };
  provider.pageUrl = fetchUrl;

  const callStart = Date.now();
  const res = await provider.call({ prompt: buildNotionFetchPrompt(fetchUrl), signal: opts.signal });
  const tool = res.structured as NotionToolOutput;
  if (!tool.toolUsed) throw new Error(`Notion 조회 도구(${toolName})가 이번 호출에서 쓰이지 않았습니다. 서버: ${server.name}. 모델 답: ${res.text.slice(0, 200)}`);
  if (!tool.matched) throw new Error(`Notion 조회 도구가 요청한 페이지가 아닌 다른 페이지만 조회했습니다 (서버: ${server.name}).`);
  if (tool.resultText === null) throw new Error("노션 조회 도구의 결과가 출력에 없습니다.");
  if (tool.isError) throw new Error(`노션 페이지를 가져오지 못했습니다: ${tool.resultText.slice(0, 300)}`);
  const full = await resolvePersistedOutput(tool.resultText, { home, workDir: opts.workDir, callStart });
  const page = pageFromToolResult(full.text);
  if (!page.markdown.trim()) throw new Error("노션 페이지 내용이 비어 있습니다.");
  const warnings: string[] = [];
  if (page.truncated || full.truncated) warnings.push("노션 페이지가 길어 도구 결과가 잘렸습니다. 뒷부분은 검증되지 않습니다. 페이지를 마크다운으로 내보내 '보관함 파일'로 검증하세요.");
  if (tool.fetchCount > 1) warnings.push(`Notion 조회가 ${tool.fetchCount}번 일어났습니다. 요청한 페이지의 첫 결과만 썼습니다.`);
  if (tool.stopReason === "max_tokens") warnings.push("모델 출력 한도에 걸려 호출이 끝났습니다.");
  const cached = await readNotionCache(opts.cacheDir, opts.url);
  const unchanged = !!cached && !!page.lastEdited && cached.lastEdited === page.lastEdited;
  await writeNotionCache(opts.cacheDir, {
    v: 1,
    url: opts.url.trim(),
    lastEdited: page.lastEdited,
    fetchedAt: new Date().toISOString(),
    markdown: page.markdown,
  });
  return { markdown: page.markdown, lastEdited: page.lastEdited, unchanged, server: server.name, strict: !!strictConfig, warnings };
}
