// Skill-side Alt local source CLI (spec 4.1, 4.7): the plugin's
// src/sources code, so the Skill lists and exports the same notes the
// sidebar shows. Read only: Alt's local API (GET routes) when Alt runs,
// else a private copy of its database. The API token is read from Alt's
// token file and never printed.
//
// Usage:
//   node scripts/phase2/alt-local.mjs status
//   node scripts/phase2/alt-local.mjs list [--query TEXT]
//   node scripts/phase2/alt-local.mjs export <noteId> <outDir>
// Options: --alt-dir <dir>   Alt's data folder (default: the platform's)
//          --source auto|api|db
//
// status  prints {"mode","label","detail"}.
// list    prints {"mode","notes":[{id,title,type,lectureDate,folderPath,subject}]}.
// export  writes <outDir>/bundle.json (the LectureBundle without PDF bytes,
//         plus "subject" and "pdfPath") and <outDir>/transcript.txt (one
//         segment per line), and prints {"bundle","pdfPath","segments","timestamps"}.
//         The PDF is not copied: read it from pdfPath (Alt's own file).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AltLocalApiSource } from "../../src/sources/AltLocalApiSource";
import { AltLocalDbSource } from "../../src/sources/AltLocalDbSource";
import { altUserDataDir } from "../../src/sources/altPaths";
import { inferSubject } from "../../src/sources/altRows";
import { connectAltLocal } from "../../src/sources/index";
import { AltLocalSource } from "../../src/sources/types";
import { fail } from "./cli-common";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function connect(userData: string, mode: string): Promise<{ source: AltLocalSource | null; label: string; detail: string }> {
  if (mode === "api") {
    const r = await AltLocalApiSource.detect(userData);
    return { source: r.source, label: r.source?.label ?? "연결 안 됨", detail: r.reason };
  }
  if (mode === "db") {
    const db = AltLocalDbSource.open({ userData });
    return { source: db, label: db.label, detail: "" };
  }
  return connectAltLocal(userData);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Positional arguments, wherever the --options are.
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) i++;
    else pos.push(args[i]);
  }
  const cmd = pos[0];
  const userData = option(args, "--alt-dir") ?? altUserDataDir();
  const mode = option(args, "--source") ?? "auto";
  if (!["status", "list", "export"].includes(cmd) || !["auto", "api", "db"].includes(mode)) {
    process.stderr.write("Usage: node scripts/phase2/alt-local.mjs status | list [--query T] | export <noteId> <outDir> [--alt-dir DIR] [--source auto|api|db]\n");
    process.exit(2);
  }
  const conn = await connect(userData, mode);
  const source = conn.source;
  try {
    if (cmd === "status") {
      process.stdout.write(JSON.stringify({ mode: source?.mode ?? "none", label: conn.label, detail: conn.detail }) + "\n");
      return;
    }
    if (!source) throw new Error(`Alt에 연결하지 못했습니다: ${conn.detail}`);
    if (cmd === "list") {
      const q = (option(args, "--query") ?? "").toLowerCase();
      const notes = (await source.listNotes())
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.folderPath.join("/").toLowerCase().includes(q))
        .map((n) => ({ id: n.id, title: n.title, type: n.type, lectureDate: n.lectureDate, folderPath: n.folderPath, subject: inferSubject(n.folderPath, n.title) }));
      process.stdout.write(JSON.stringify({ mode: source.mode, notes }) + "\n");
      return;
    }
    const [, id, outDir] = pos;
    if (!id || !outDir) throw new Error("export needs <noteId> <outDir>");
    const bundle = await source.getBundle(id);
    mkdirSync(outDir, { recursive: true });
    const { pdf: _pdf, ...rest } = bundle;
    const out = { ...rest, subject: inferSubject(bundle.folderPath ?? [], bundle.title) };
    const bundlePath = join(outDir, "bundle.json");
    writeFileSync(bundlePath, JSON.stringify(out, null, 1));
    writeFileSync(join(outDir, "transcript.txt"), bundle.transcript.map((s) => s.text).join("\n"));
    process.stdout.write(
      JSON.stringify({
        bundle: bundlePath,
        pdfPath: bundle.pdf ? bundle.pdfPath : null,
        segments: bundle.transcript.length,
        timestamps: bundle.transcript.some((s) => s.startMs !== null),
        warnings: bundle.warnings ?? [],
      }) + "\n"
    );
  } finally {
    source?.close?.();
  }
}

main().catch((e: unknown) => fail(e, "alt-local"));
