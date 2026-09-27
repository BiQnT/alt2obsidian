/**
 * Test: every prompts/*.md template renders, and renderPrompt rules hold.
 * Run: node test/test-prompts.mjs
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { importTs, repo } from "./helpers/bundle-ts.mjs";

const { renderPrompt } = await importTs("src/prompts/render.ts");

const dir = join(repo, "prompts");
const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
assert.ok(files.length > 0);
for (const file of files) {
  const template = readFileSync(join(dir, file), "utf8");
  assert.ok(!template.includes("\r"), `${file} must use LF line endings`);
  const names = [...template.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((m) => m[1]);
  const vars = Object.fromEntries(names.map((n) => [n, `<${n}>`]));
  const out = renderPrompt(template, vars);
  assert.ok(!out.includes("{{"), `${file}: placeholder left after render`);
  assert.ok(out.length > 0 && !out.endsWith("\n"), `${file}: trailing newline must be dropped`);
  for (const n of names) assert.ok(out.includes(`<${n}>`), `${file}: ${n} not substituted`);
  if (names.length > 0) {
    const missing = { ...vars };
    delete missing[names[0]];
    assert.throws(() => renderPrompt(template, missing), /Missing prompt variable/);
  }
  console.log(`PASS: ${file} (${names.length} variables)`);
}

assert.equal(renderPrompt("a {{x}}\r\nb\r\n", { x: "{{y}} $&" }), "a {{y}} $&\nb");
assert.throws(() => renderPrompt("{{ bad }}", {}), /Malformed placeholder/);
console.log("PASS: renderPrompt CRLF normalization, literal values, malformed placeholder");
