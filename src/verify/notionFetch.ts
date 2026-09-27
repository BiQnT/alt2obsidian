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
// server as "connected", about 2k input tokens per call. A claude.ai
// connector or a server with headers cannot be restated that way: those
// run without --strict-mcp-config (connectors are account level, not a
// settings file), with the deny list above. No --safe-mode: it switches
// MCP servers off.
//
// The markdown is cached outside the vault (the transcript cache folder,
// 0600) with the page's last edited time, for a reproducible record of
// what was checked; an unchanged page is reported as such.

import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { join } from "path";
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
    "",
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
    return u.protocol === "https:" && /(^|\.)notion\.(so|site)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function buildNotionFetchPrompt(url: string): string {
  return renderPrompt(notionFetchTemplate, { url: url.trim() });
}

// ---- the tool result in stream-json ----

export interface NotionToolOutput {
  /** A tool_use of the fetch tool happened. */
  toolUsed: boolean;
  /** Text of its (last) tool_result, null when there was none. */
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

/** The fetch tool's call and result from `claude -p --output-format stream-json` stdout. */
export function parseNotionStream(stdout: string, toolName: string): NotionToolOutput {
  const ids = new Set<string>();
  const out: NotionToolOutput = { toolUsed: false, resultText: null, isError: false, stopReason: null };
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: { type?: string; message?: { content?: unknown; stop_reason?: string }; stop_reason?: string };
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const content = Array.isArray(ev.message?.content) ? (ev.message!.content as Array<Record<string, unknown>>) : [];
    if (ev.type === "assistant") {
      for (const c of content) {
        if (c.type === "tool_use" && c.name === toolName && typeof c.id === "string") {
          ids.add(c.id);
          out.toolUsed = true;
        }
      }
      if (ev.message?.stop_reason) out.stopReason = ev.message.stop_reason;
    } else if (ev.type === "user") {
      for (const c of content) {
        if (c.type === "tool_result" && typeof c.tool_use_id === "string" && ids.has(c.tool_use_id)) {
          out.resultText = blockText(c.content);
          out.isError = c.is_error === true;
        }
      }
    } else if (ev.type === "result" && ev.stop_reason) {
      out.stopReason = ev.stop_reason;
    }
  }
  return out;
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
    const obj = JSON.parse(text);
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
  // Claude Code cuts very large tool outputs and says so.
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
    const entry = JSON.parse(await fsp.readFile(notionCachePath(cacheDir, url), "utf8"));
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
  plan: NotionCallPlan = { toolName: "", strictConfig: null, deny: [] };

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
      return { ...parseClaudeOutput(out.stdout), structured: parseNotionStream(out.stdout, this.plan.toolName) };
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
export async function fetchNotionPage(
  provider: NotionFetchProvider,
  opts: { bin: string; url: string; cacheDir: string; workDir: string; toolName?: string; signal?: AbortSignal }
): Promise<NotionFetchResult> {
  if (!isNotionUrl(opts.url)) throw new Error("노션 페이지 URL(https://www.notion.so/...)을 넣어 주세요.");
  const { server, all } = await detectNotionServer(opts.bin, opts.workDir, opts.signal);
  const toolName = opts.toolName?.trim() || mcpToolName(server.name);
  let details: McpServerDetails | null = null;
  // A claude.ai connector or a plugin server cannot be restated in --mcp-config.
  if (!/^claude\.ai /.test(server.name) && !/^plugin:/.test(server.name)) {
    try {
      details = parseMcpGet(await runQuiet(opts.bin, ["mcp", "get", server.name], opts.workDir, opts.signal));
    } catch (e) {
      if (e instanceof CliRunError && e.kind === "aborted") throw e;
      details = null;
    }
  }
  const strictConfig = strictMcpConfig(server.name, details);
  const others = all.map((s) => s.name).filter((n) => n !== server.name);
  provider.plan = { toolName, strictConfig, deny: notionDenyList(toolName, others, !!strictConfig) };

  const res = await provider.call({ prompt: buildNotionFetchPrompt(opts.url), signal: opts.signal });
  const tool = res.structured as NotionToolOutput;
  if (!tool.toolUsed) throw new NotionMcpMissingError(`모델이 ${toolName}을(를) 호출하지 않았습니다: ${res.text.slice(0, 200)}`);
  if (tool.resultText === null) throw new Error("노션 조회 도구의 결과가 출력에 없습니다.");
  if (tool.isError) throw new Error(`노션 페이지를 가져오지 못했습니다: ${tool.resultText.slice(0, 300)}`);
  const page = pageFromToolResult(tool.resultText);
  if (!page.markdown.trim()) throw new Error("노션 페이지 내용이 비어 있습니다.");
  const warnings: string[] = [];
  if (page.truncated) warnings.push("노션 페이지가 길어 도구 결과가 잘렸습니다. 뒷부분은 검증되지 않습니다. 페이지를 마크다운으로 내보내 '보관함 파일'로 검증하세요.");
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
