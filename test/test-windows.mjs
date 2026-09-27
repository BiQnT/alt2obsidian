/**
 * Test: the Windows code path of CliRunner, run on any OS by passing
 * `platform: "win32"` and a stub spawn (no real process is started for the
 * CLI). Covers npm .cmd shim resolution to `node.exe <script>` (no shell),
 * .exe and .ps1 handling, windowsHide, PATH with ";", process-tree kill with
 * taskkill on timeout and cancel, and the `where` / %APPDATA%\npm lookup.
 * What still needs a real Windows PC is listed in README ("Windows").
 * Run: node test/test-windows.mjs
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { importTs } from "./helpers/bundle-ts.mjs";

const m = await importTs("test/helpers/cli-entry.ts");

/** Stub spawn: records calls; `script(child, call)` drives the fake process. */
function stubSpawn(script) {
  const calls = [];
  const fn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242 + calls.length;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    child.stdin.on("data", (c) => (input += c));
    const call = { command, args, options, input: () => input };
    calls.push(call);
    setImmediate(() => script(child, call));
    return child;
  };
  return { fn, calls };
}
const exitWith = (child, code, out = "") => {
  child.stdout.end(out);
  child.stderr.end();
  setImmediate(() => child.emit("close", code));
};

const dir = mkdtempSync(join(tmpdir(), "alt2obs-win-"));
try {
  // Windows-looking layout (paths are joined with win32 rules, stored on the real disk).
  const npm = join(dir, "npm");
  mkdirSync(npm);
  const shim = join(npm, "codex.cmd");
  writeFileSync(
    shim,
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  );
  writeFileSync(join(npm, "node.exe"), "");
  writeFileSync(join(npm, "codex.ps1"), "#!/usr/bin/env pwsh\r\n");
  const exe = join(dir, "claude.exe");
  writeFileSync(exe, "");
  const badShim = join(dir, "weird.cmd");
  writeFileSync(badShim, "@echo off\r\nstart something.exe %*\r\n");

  // Shim parsing and spawn targets.
  assert.equal(
    m.parseNpmCmdShim('"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', "C:\\Users\\u\\AppData\\Roaming\\npm"),
    "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"
  );
  assert.equal(m.parseNpmCmdShim('"%~dp0\\node.exe"  "%~dp0\\node_modules\\x\\bin\\x.mjs" %*', "D:\\n"), "D:\\n\\node_modules\\x\\bin\\x.mjs");
  const t = m.resolveSpawnTarget(shim, "win32", "");
  const win = (p) => p.replace(/\//g, "\\");
  assert.equal(win(t.command), win(join(npm, "node.exe")), "node.exe next to the shim");
  assert.ok(win(t.prefixArgs[0]).endsWith("npm\\node_modules\\@openai\\codex\\bin\\codex.js"));
  assert.deepEqual(m.resolveSpawnTarget(exe, "win32", ""), { command: exe, prefixArgs: [] });
  assert.equal(m.resolveSpawnTarget(join(npm, "codex.ps1"), "win32", "").prefixArgs.length, 1, ".ps1 uses the sibling .cmd");
  assert.throws(() => m.resolveSpawnTarget(badShim, "win32", ""), /해석하지 못했습니다/);
  assert.deepEqual(m.resolveSpawnTarget("/usr/local/bin/claude", "darwin"), { command: "/usr/local/bin/claude", prefixArgs: [] });
  console.log("PASS: npm .cmd/.ps1 shims resolve to node.exe <script>, .exe runs directly, unknown shims are refused");

  // runCli on win32: no shell, windowsHide, not detached, arguments verbatim, PATH with ";".
  {
    const s = stubSpawn((child) => exitWith(child, 0, "ok"));
    const tricky = ['--system-prompt', 'say "hi" & del C:\\x | echo %PATH%', "--tools", ""];
    const out = await m.runCli({ bin: shim, args: tricky, input: "프롬프트", platform: "win32", spawnFn: s.fn, env: { PATH: "C:\\Windows\\System32" } });
    assert.equal(out.stdout, "ok");
    const call = s.calls[0];
    assert.ok(call.command.endsWith("node.exe"));
    assert.deepEqual(call.args.slice(1), tricky, "arguments passed as an array, untouched");
    assert.equal(call.options.shell, undefined, "no shell");
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, false, "no new console window group on Windows");
    const pathKey = Object.keys(call.options.env).find((k) => k.toUpperCase() === "PATH");
    assert.ok(call.options.env[pathKey].split(";").includes("C:\\Windows\\System32"));
    assert.ok(call.options.env[pathKey].split(";")[0].endsWith("npm"), "shim folder first");
    assert.equal(call.input(), "프롬프트");
    console.log("PASS: win32 spawn without a shell, windowsHide, verbatim arguments, PATH joined with ';'");
  }

  // Timeout and cancel kill the process tree with taskkill /T /F.
  {
    const s = stubSpawn((child, call) => {
      if (call.command === "taskkill") {
        exitWith(child, 0);
        return;
      }
      child.killedBy = null;
      s.victim = child;
    });
    const p = m.runCli({ bin: exe, args: [], platform: "win32", spawnFn: s.fn, timeoutMs: 50 });
    setTimeout(() => s.victim && exitWith(s.victim, 1), 150);
    await assert.rejects(p, (e) => e.kind === "timeout");
    const kill = s.calls.find((c) => c.command === "taskkill");
    assert.deepEqual(kill.args, ["/pid", "4242", "/T", "/F"]);
    assert.equal(kill.options.windowsHide, true);

    const s2 = stubSpawn((child, call) => {
      if (call.command === "taskkill") return exitWith(child, 0);
      s2.victim = child;
    });
    const ctrl = new AbortController();
    const p2 = m.runCli({ bin: exe, args: [], platform: "win32", spawnFn: s2.fn, signal: ctrl.signal, timeoutMs: 60000 });
    setTimeout(() => ctrl.abort(), 20);
    setTimeout(() => s2.victim && exitWith(s2.victim, 1), 80);
    await assert.rejects(p2, (e) => m.isAbortError(e));
    assert.ok(s2.calls.some((c) => c.command === "taskkill" && c.args.includes("/T")));
    console.log("PASS: timeout and cancel run taskkill /pid N /T /F");
  }

  // Lookup: `where` first (.exe preferred), then %APPDATA%\npm.
  {
    const s = stubSpawn((child, call) => {
      assert.equal(call.command, "where.exe");
      exitWith(child, 0, `${shim}\r\n${exe}\r\n`);
    });
    const r = await m.resolveCliBinary("claude", { configuredPath: "", platform: "win32", spawnFn: s.fn, extraDirs: [] });
    assert.deepEqual(r, { path: exe, source: "where" });

    const none = stubSpawn((child) => exitWith(child, 1, ""));
    const appdata = join(dir, "appdata");
    mkdirSync(join(appdata, "npm"), { recursive: true });
    writeFileSync(join(appdata, "npm", "codex.cmd"), "");
    const r2 = await m.resolveCliBinary("codex", { configuredPath: "", platform: "win32", spawnFn: none.fn, home: join(dir, "home"), env: { APPDATA: appdata } });
    assert.equal(r2.source, "common-path");
    assert.ok(r2.path.endsWith("codex.cmd"));
    assert.ok(m.commonCliDirs("C:\\Users\\u", "win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }).includes("C:\\Users\\u\\AppData\\Roaming\\npm"));
    await assert.rejects(
      m.resolveCliBinary("claude", { configuredPath: "", platform: "win32", spawnFn: none.fn, extraDirs: [] }),
      /where claude/
    );
    console.log("PASS: Windows lookup uses where (exe first), then %APPDATA%\\npm; the error names `where`");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
