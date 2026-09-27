// Notion page input for the note verifier over the user's Notion MCP
// (spec 4.6 input, D2 optional path). No obsidian import.
//
// The user's Claude CLI runs once with only the Notion fetch tool:
//   --tools ""                       no built-in tools (no files, no shell)
//   --permission-mode dontAsk        every tool not pre-approved is denied
//   --allowedTools mcp__<server>__notion-fetch
//                                    the one tool that may run
//   --disallowedTools <the server's write tools>
//                                    denied even if the user's settings
//                                    allow them (a deny wins)
//   --setting-sources user           the user's own MCP servers and their
//                                    login stay available; project and local
//                                    settings are skipped (cwd is a temp folder)
//   --no-session-persistence, --disable-slash-commands, own --system-prompt
// So, unlike every other call, no --strict-mcp-config and no --safe-mode:
// both would switch the user's MCP servers off.
//
// The model is told to answer with the page's last_edited_time and the raw
// markdown, or UNCHANGED when the time equals the cached one; the markdown
// is cached outside the vault (the transcript cache folder, 0600) so an
// unchanged page costs no output tokens. The server name comes from
// `claude mcp list`, which runs no model.

import { createHash } from "crypto";
import { promises as fsp } from "fs";
import { join } from "path";
import { renderPrompt } from "../prompts/render";
import { CliCall, CliCallResult, CliProviderBase } from "../llm/cli/CliProviderBase";
import { buildClaudeInput, findClaudeResult, parseClaudeOutput } from "../llm/cli/ClaudeCliProvider";
import { CliRunError, runCli } from "../llm/cli/CliRunner";
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

/** Claude Code tool name of an MCP server's tool: `mcp__<server>__<tool>`, non-name characters as "_". */
export function mcpToolName(server: string, tool = NOTION_FETCH_TOOL): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__${tool}`;
}

/** The Notion MCP's writing and session tools: denied by name on the fetch call (a deny wins over any allow rule). */
export const NOTION_WRITE_TOOLS = [
  "notion-create-pages",
  "notion-update-page",
  "notion-move-pages",
  "notion-duplicate-page",
  "notion-create-comment",
  "notion-create-database",
  "notion-update-data-source",
  "notion-create-view",
  "notion-update-view",
  "notion-create-folder",
  "notion-update-folder",
  "notion-create-attachment",
  "notion-create-file-upload",
  "notion-upload-skill",
  "notion-spawn-session",
  "notion-send-message-to-session",
  "notion-stop-session",
];

export function isSafeToolName(name: string): boolean {
  return /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/.test(name);
}

export function buildNotionFetchArgs(input: { model: string; effort: string; toolName: string }): string[] {
  if (!isSafeToolName(input.toolName)) throw new Error(`Notion 도구 이름이 올바르지 않습니다: ${input.toolName}`);
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--setting-sources",
    "user",
    "--disable-slash-commands",
    "--system-prompt",
    "You fetch one Notion page with the only tool you have and return its content verbatim.",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    input.toolName,
    "--disallowedTools",
    NOTION_WRITE_TOOLS.map((t) => input.toolName.slice(0, input.toolName.lastIndexOf("__") + 2) + t).join(","),
  ];
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

export type NotionAnswer =
  | { kind: "unchanged"; lastEdited: string }
  | { kind: "page"; lastEdited: string | null; markdown: string }
  | { kind: "error"; reason: string };

export function parseNotionAnswer(text: string): NotionAnswer {
  const t = text.replace(/\r\n?/g, "\n").replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, "$1").trim();
  if (/^ERROR:/i.test(t)) return { kind: "error", reason: t.replace(/^ERROR:\s*/i, "").slice(0, 300) };
  const m = t.match(/^last_edited_time:\s*`?([^`\n]*?)`?\s*\n([\s\S]*)$/i);
  if (!m) return { kind: "error", reason: "응답 형식을 알아볼 수 없습니다" };
  const edited = m[1].trim();
  const lastEdited = !edited || /^unknown$/i.test(edited) ? null : edited;
  const rest = m[2].replace(/^\s*\n/, "");
  if (/^UNCHANGED\s*$/.test(rest.trim()) && lastEdited) return { kind: "unchanged", lastEdited };
  const body = rest.replace(/^---[ \t]*\n/, "");
  if (!body.trim()) return { kind: "error", reason: "페이지 내용이 비어 있습니다" };
  return { kind: "page", lastEdited, markdown: body.trimEnd() + "\n" };
}

export function buildNotionFetchPrompt(url: string, cachedEdited: string | null): string {
  // "(none)" never equals a real time, so the page is always returned.
  return renderPrompt(notionFetchTemplate, { url: url.trim(), cachedEdited: cachedEdited ?? "(none)" });
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

/** Claude CLI provider variant with the Notion-only flags (usage recorded like every call). */
export class NotionFetchProvider extends CliProviderBase {
  name = "Claude CLI (Notion)";
  maxInputTokens = 200000;
  readonly providerId = "claude-cli" as const;
  protected usesFiles = false;
  toolName = "";

  protected async invoke(call: CliCall): Promise<CliCallResult> {
    const args = buildNotionFetchArgs({ model: this.config.model, effort: this.config.effort, toolName: this.toolName });
    try {
      const out = await runCli({
        bin: this.config.bin,
        args,
        input: buildClaudeInput(call),
        cwd: this.config.workDir,
        timeoutMs: this.config.timeoutMs,
        signal: call.signal,
      });
      return parseClaudeOutput(out.stdout);
    } catch (e) {
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
  /** True when the page was unchanged and the cached markdown was used. */
  fromCache: boolean;
  server: string;
}

/** Finds the Notion MCP server in `claude mcp list`; throws NotionMcpMissingError when there is none. */
export async function detectNotionServer(bin: string, workDir: string, signal?: AbortSignal): Promise<McpServerEntry> {
  let stdout: string;
  try {
    stdout = (await runCli({ bin, args: ["mcp", "list"], cwd: workDir, timeoutMs: 90_000, signal })).stdout;
  } catch (e) {
    if (e instanceof CliRunError && e.kind === "aborted") throw e;
    throw new NotionMcpMissingError(`claude mcp list 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  const server = findNotionServer(parseMcpList(stdout));
  if (!server) throw new NotionMcpMissingError();
  if (!server.connected) throw new NotionMcpMissingError(`${server.name} 서버가 연결되어 있지 않습니다`);
  return server;
}

/**
 * Raw markdown of a Notion page through the user's Notion MCP, cached with
 * its last_edited_time. `toolName` overrides the detected tool (settings).
 */
export async function fetchNotionPage(
  provider: NotionFetchProvider,
  opts: { bin: string; url: string; cacheDir: string; workDir: string; toolName?: string; signal?: AbortSignal }
): Promise<NotionFetchResult> {
  if (!isNotionUrl(opts.url)) throw new Error("노션 페이지 URL(https://www.notion.so/...)을 넣어 주세요.");
  const cached = await readNotionCache(opts.cacheDir, opts.url);
  let server = "";
  if (opts.toolName?.trim()) {
    provider.toolName = opts.toolName.trim();
    server = provider.toolName.split("__")[1] ?? "";
  } else {
    server = (await detectNotionServer(opts.bin, opts.workDir, opts.signal)).name;
    provider.toolName = mcpToolName(server);
  }
  const text = await provider.generateText(buildNotionFetchPrompt(opts.url, cached?.lastEdited ?? null), { signal: opts.signal });
  const answer = parseNotionAnswer(text);
  if (answer.kind === "error") {
    if (/tool|mcp|not available|permission/i.test(answer.reason)) throw new NotionMcpMissingError(answer.reason);
    throw new Error(`노션 페이지를 가져오지 못했습니다: ${answer.reason}`);
  }
  if (answer.kind === "unchanged") {
    if (cached && cached.lastEdited === answer.lastEdited) {
      return { markdown: cached.markdown, lastEdited: cached.lastEdited, fromCache: true, server };
    }
    throw new Error("노션 페이지가 바뀌지 않았다고 답했지만 캐시가 없습니다. 다시 시도하세요.");
  }
  await writeNotionCache(opts.cacheDir, {
    v: 1,
    url: opts.url.trim(),
    lastEdited: answer.lastEdited,
    fetchedAt: new Date().toISOString(),
    markdown: answer.markdown,
  });
  return { markdown: answer.markdown, lastEdited: answer.lastEdited, fromCache: false, server };
}
