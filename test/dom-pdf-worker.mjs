/**
 * DOM test: the PDF.js worker bundled into main.js (src/pdf/pdfWorker.ts,
 * scripts/inline-pdf-worker.mjs) in a real headless Chromium. PdfProcessor
 * opens a synthetic deck (text pages and one page with only a filled
 * rectangle) through a module worker started from the Blob URL: text
 * extraction, page layouts, gray renders, JPEG and PNG renders all work,
 * several documents can be open at once, no worker file is fetched from
 * the server, PDF.js never falls back to its main-thread "fake worker", and
 * once the URL is revoked (plugin unload) no new document can start. The
 * same documents are opened once more with PDF.js's origin check forced to
 * fail, as it may on Obsidian's app://obsidian.md page: the worker then
 * starts through PDF.js's import() wrapper, and everything still works.
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
import { homedir, tmpdir } from "node:os";
import { extname, join } from "node:path";
import esbuild from "esbuild";
import { repo } from "./helpers/bundle-ts.mjs";
import { inlinePdfWorker } from "../scripts/inline-pdf-worker.mjs";
import { FIXTURE_PAGES, writeSyntheticPdf } from "./helpers/synthetic-pdf.mjs";

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

const dir = mkdtempSync(join(tmpdir(), "alt-to-obs-dom-pdf-"));
writeSyntheticPdf(join(dir, "deck.pdf"), FIXTURE_PAGES);
writeFileSync(
  join(dir, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><pre id="out">pending</pre><script type="module" src="./bundle.js"></script></body></html>'
);
await esbuild.build({
  entryPoints: [join(repo, "test/helpers/dom-pdf-worker-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: join(dir, "bundle.js"),
  loader: { ".md": "text", ".css": "text" },
  logLevel: "error",
  plugins: [inlinePdfWorker, { name: "obsidian-stub", setup: (b) => b.onResolve({ filter: /^obsidian$/ }, () => ({ path: join(repo, "test/helpers/obsidian-browser-stub.js") })) }],
});
assert.ok(readFileSync(join(dir, "bundle.js"), "utf8").includes("WorkerMessageHandler"), "the worker source is inside the bundle");

const requested = [];
const types = { ".html": "text/html", ".js": "text/javascript", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  requested.push(path);
  const file = join(dir, path);
  if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/index.html`;

const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ["--headless", `--remote-debugging-port=${port}`, "--window-size=1200,900", `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleLines = [];
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
    else if (d.method === "Runtime.consoleAPICalled") consoleLines.push(d.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    else if (d.method === "Runtime.exceptionThrown") console.error("page exception:", d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((r) => (pending.set(++id, r), ws.send(JSON.stringify({ id, method, params }))));
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  for (let i = 0; i < 240 && out === "pending"; i++) {
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
const r = JSON.parse(out);
assert.equal(r.workerSrcIsBlob, true, "workerSrc is a Blob URL");
assert.equal(r.realWorker, true, "documents run in a module worker started from the Blob URL");
const beforeRevoke = consoleLines.slice(0, consoleLines.indexOf("revoke step"));
assert.ok(consoleLines.includes("revoke step") && !beforeRevoke.some((l) => /fake worker/i.test(l)), `no main-thread fallback: ${consoleLines.join(" | ")}`);
assert.ok(!requested.some((p) => /worker/i.test(p)), `no worker file fetched: ${requested.join(", ")}`);
assert.equal(r.count, FIXTURE_PAGES.length);
assert.deepEqual(
  r.texts.map((t) => (t ?? "").replace(/\s+/g, "")),
  FIXTURE_PAGES.map((t) => (t ?? "").replace(/\s+/g, "")),
  "text layers of every page"
);
assert.ok(r.layoutLines[1].includes("Cache Coherence"), `page layouts: ${JSON.stringify(r.layoutLines)}`);
assert.equal(r.grayDark.length, FIXTURE_PAGES.length);
assert.ok(r.grayDark.every((s) => s >= 0), "every page rendered for the analysis");
assert.ok(r.grayDark[0] > 0 && r.grayDark[0] < 0.2, `a text page has some ink (${r.grayDark[0]})`);
assert.ok(r.grayDark[3] > 0.15, `the rectangle page is mostly drawn (${r.grayDark[3]})`);
assert.equal(r.jpeg?.mime, "image/jpeg");
assert.ok(r.jpeg.ink > 0, "the JPEG render has the page's text");
assert.deepEqual(r.pngs.map((p) => p.page), [1, 4]);
assert.ok(r.pngs.every((p) => p.ink > 0), `PNG renders are not blank (${JSON.stringify(r.pngs)})`);
assert.equal(r.materialPages, FIXTURE_PAGES.length, "lecture material text extraction");
assert.ok(r.wrapper.wrapperCalls >= 3, `the wrapper path was taken for every document (${r.wrapper.wrapperCalls})`);
assert.equal(r.wrapper.realWorker, true, "the wrapper starts a real module worker too");
assert.deepEqual(r.wrapper.texts, r.texts, "same text through the wrapper");
assert.equal(r.wrapper.jpeg, true, "renders through the wrapper");
assert.ok(r.afterRevoke.startsWith("failed"), `a revoked URL starts no new document (${r.afterRevoke})`);
console.log("PASS: PDF.js worker bundled into main.js: module worker from a Blob URL, directly and through PDF.js's cross-origin wrapper (no worker file, no fake worker), text, layouts, gray, JPEG and PNG renders, concurrent documents, revoked on unload");
