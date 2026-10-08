/**
 * DOM test: the sidebar (src/ui/SidebarView.ts) in a real headless
 * Chromium with the plugin's styles.css, a fake plugin and a fake metadata
 * cache. Restored at startup, the Alt note list is built before Obsidian
 * has indexed the imported lecture: its chip turns from 새 노트 to 가져옴
 * once that note's metadata arrives and the cache is resolved, without
 * fetching the list from Alt again, while unrelated metadata reads
 * nothing. The import's estimate panel (opened from the list) is hidden in
 * the 노트 검증 tab and back, pending choice included, in the import tabs;
 * the 노트 검증 tab's own estimate stays in that tab.
 *
 * Needs a Chromium binary, so it is not part of `npm test`:
 *   npm run test:dom                 (finds Playwright's headless shell or Google Chrome)
 *   ALT2OBS_CHROME=/path/to/chrome npm run test:dom
 * Fails (does not skip) when no browser is found.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { builtinModules } from "node:module";
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import esbuild from "esbuild";
import { repo } from "./helpers/bundle-ts.mjs";

function findChrome() {
  if (process.env.ALT2OBS_CHROME) return process.env.ALT2OBS_CHROME;
  const pw = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      for (const sub of readdirSync(join(pw, d))) {
        const bin = join(pw, d, sub, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(mac) ? mac : null;
}

const chrome = findChrome();
assert.ok(chrome, "no Chromium found: set ALT2OBS_CHROME");

const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-dom-sidebar-"));
writeFileSync(join(dir, "styles.css"), readFileSync(join(repo, "styles.css")));
writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><style>body{margin:0;width:420px}</style></head>' +
    '<body><div id="host"></div><pre id="out">pending</pre><script type="module" src="./bundle.js"></script></body></html>'
);
// The sidebar imports the Alt sources and the CLI runner, which use Node's
// modules; none of that runs here, so they are empty in the browser.
const nodeBuiltins = new RegExp(`^(node:.*|${builtinModules.join("|").replace(/\//g, "\\/")})$`);
await esbuild.build({
  entryPoints: [join(repo, "test/helpers/dom-sidebar-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(dir, "bundle.js"),
  loader: { ".md": "text", ".css": "text" },
  logLevel: "error",
  plugins: [
    {
      name: "stubs",
      setup: (b) => {
        b.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(repo, "test/helpers/obsidian-browser-stub.js") }));
        b.onResolve({ filter: nodeBuiltins }, (a) => ({ path: a.path, namespace: "node-builtin" }));
        b.onLoad({ filter: /.*/, namespace: "node-builtin" }, () => ({ contents: "module.exports = {};", loader: "js" }));
      },
    },
  ],
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer((req, res) => {
  const file = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless", `--remote-debugging-port=${port}`, "--window-size=420,900", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let out = "pending";
try {
  let targets = null;
  for (let i = 0; i < 100 && !targets; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id);
    else if (d.method === "Runtime.exceptionThrown") console.error("page exception:", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 120 && out === "pending"; i++) {
    await sleep(250);
    const r = await send("Runtime.evaluate", { expression: "document.getElementById('out')?.textContent ?? 'pending'" });
    out = r.result?.result?.value ?? "pending";
  }
  ws.close();
} finally {
  proc.kill();
  server.close();
  await sleep(200);
  rmSync(dir, { recursive: true, force: true });
}

assert.ok(!out.startsWith("ERROR") && out !== "pending", out);
const steps = JSON.parse(out);
const at = (name) => {
  const { step, ...rest } = steps.find((s) => s.step === name);
  return rest;
};

// ---- statuses once the metadata cache catches up ----
const built = at("built before the cache");
assert.deepEqual(built.chips, { L5: "새 노트", L6: "새 노트" }, "built before L5 was indexed: it shows as new");
assert.deepEqual(at("unrelated"), built, "a resolved cache with no lecture note changed reads nothing again");
assert.deepEqual(at("L5 changed").chips, built.chips, "statuses wait for the cache to be resolved");
const resolved = at("resolved");
assert.deepEqual(resolved.chips, { L5: "가져옴", L6: "새 노트" }, "L5 shows as imported once the cache is resolved");
assert.equal(resolved.vault, built.vault + 1, "the vault's lecture notes are read once");
assert.equal(resolved.listNotes, built.listNotes, "the list is not fetched from Alt again");
assert.equal(resolved.details, built.details + 1, "only L5, now imported, is read again, for its slide comparison");
assert.equal(resolved.compared, 1);
assert.deepEqual(at("resolved again"), { vault: resolved.vault, details: resolved.details, compared: 1, listNotes: resolved.listNotes }, "nothing changed since: nothing read");
console.log("PASS: sidebar restored before the cache had the imported lecture: 새 노트 turns into 가져옴 once its metadata arrives and the cache is resolved, without listing Alt again; unrelated metadata reads nothing");

// ---- the import's estimate panel belongs to the import tabs ----
assert.deepEqual(at("local"), { importPanel: true, importText: true, verifyEstimate: false, verifyInputs: false }, "the import estimate in the list tab");
assert.deepEqual(at("verify"), { importPanel: false, importText: true, verifyEstimate: false, verifyInputs: true }, "not under the verification inputs");
assert.deepEqual(at("verify estimate"), { importPanel: false, importText: true, verifyEstimate: true, verifyInputs: true }, "the verification estimate alone in its tab");
assert.deepEqual(at("url"), { importPanel: true, importText: true, verifyEstimate: false, verifyInputs: false }, "the URL tab is an import tab too; the verification estimate stays in its tab");
assert.deepEqual(at("local again"), at("local"), "back in the list tab as it was");
assert.deepEqual(at("cancelled"), { importPanel: false }, "the pending choice survived the tab switches: 취소 ends the import");
console.log("PASS: sidebar tabs: the import estimate panel shows in the import tabs only and keeps its pending choice; the verification estimate stays in 노트 검증");
