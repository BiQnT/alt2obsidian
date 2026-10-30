// Skill-side lecture brief (2.1.0 spec 10): the plugin's brief code
// (src/brief) on the vault's files, so a Skill import leaves the same
// `Briefs/<lecture> brief.md` and subject brief the plugin writes.
//
// Usage:
//   node scripts/phase2/brief.mjs build --note <note.md> [--vault <dir>] [--transcript <bundle.json> --out-candidates <candidates.json>]
//     Writes the script part of the note's brief (no tokens) and then the
//     subject brief, like the plugin's import: nothing when the brief is up
//     to date, never over a brief the user edited (its AI part is carried
//     over as it is). With --transcript (bundle.json of `alt-local.mjs
//     export`, timestamps kept; a JSON array of {startMs,endMs,text} also
//     works) it writes the AI part's input as the plugin builds it:
//     <candidates.json> (the candidate sentences and what merge-ai checks)
//     and the rendered prompt beside it, <stem>.system.md (the
//     instructions and the JSON schema) and <stem>.user.md. Files 0600:
//     they hold lecture text. No prompt without timestamps or candidates,
//     for a brief the user edited, or when the brief already has an AI part
//     made from the same input. Prints
//     {"brief","result","ai":{"candidates","system","user","count"}|null,"aiReason"?}.
//   node scripts/phase2/brief.mjs merge-ai --note <note.md> --ai <answer.json> --candidates <candidates.json> [--vault <dir>]
//     Checks the session's JSON answer with the plugin's validator (times
//     within the lecture, slides within the deck, nothing copied from the
//     transcript, texts made safe) and writes the brief's AI sections, then
//     the subject brief. Refuses when the note changed since `build`. Prints
//     {"brief","result","kept":{"emphasis","qa","pitfalls","oneLine"}}.
//
// The vault is the nearest folder above the note that holds `.obsidian`,
// unless --vault names it (then --note may be a vault path). The brief
// names the note by its vault path, as the plugin writes it, and what is
// written is made safe with Dataview's own query prefixes read from the
// vault (<vault>/.obsidian/plugins/dataview/data.json), as the plugin reads
// them from the app.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { aiInputFor, BriefFiles, timedTranscript, updateLectureBrief, updateSubjectBrief } from "../../src/brief/briefStore";
import { aiOf, buildBriefScript, planBriefUpdate } from "../../src/brief/lectureBrief";
import { aiPartStatus, BRIEF_AI_SCHEMA, formatAiPart, renderAiSections, validateBriefAi } from "../../src/brief/briefAi";
import { briefPathForNote } from "../../src/vault/layout";
import { formatDate } from "../../src/utils/helpers";
import { ensureWebCrypto, fail } from "./cli-common";

/** What `build` saves for `merge-ai`: the input the answer is checked against. */
interface SavedCandidates {
  note: string;
  sourceHash: string;
  hash: string;
  lengthMs: number | null;
  units: number;
  candidateText: string;
  candidates: Array<{ startMs: number; slide: number | null; text: string }>;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function usage(): never {
  process.stderr.write(
    "Usage: node scripts/phase2/brief.mjs build --note NOTE [--vault DIR] [--transcript bundle.json --out-candidates candidates.json]\n" +
      "       node scripts/phase2/brief.mjs merge-ai --note NOTE --ai answer.json --candidates candidates.json [--vault DIR]\n"
  );
  process.exit(2);
}

function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The nearest folder above a file that holds `.obsidian`. */
function vaultAbove(file: string): string {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, ".obsidian"))) return d;
    if (dirname(d) === d) throw new Error("no vault above the note (a folder with .obsidian): pass --vault");
  }
}

/** The vault folder and the note's vault path. */
function locate(args: string[]): { vault: string; notePath: string } {
  const note = option(args, "--note");
  if (!note || note.startsWith("--")) usage();
  const given = option(args, "--vault");
  const abs = resolve(given && !isAbsolute(note) ? join(given, note) : note);
  const vault = given ? resolve(given) : vaultAbove(abs);
  const rel = relative(vault, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`the note is not inside the vault ${vault}`);
  return { vault, notePath: rel.split(sep).join("/") };
}

/** The vault as the brief store sees it (vault paths, folders made as needed). */
function vaultFiles(vault: string): BriefFiles {
  const abs = (path: string) => join(vault, ...path.split("/"));
  return {
    read: async (path) => {
      try {
        return readFileSync(abs(path), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
    write: async (path, text) => {
      mkdirSync(dirname(abs(path)), { recursive: true });
      writeFileSync(abs(path), text);
    },
    list: async (folder) => {
      if (!existsSync(abs(folder))) return [];
      return readdirSync(abs(folder))
        .filter((name) => name.endsWith(".md") && statSync(join(abs(folder), name)).isFile())
        .map((name) => (folder ? `${folder}/${name}` : name));
    },
  };
}

/** The transcript segments of a bundle.json (or a bare array of them). */
function readSegments(file: string): Array<{ startMs: number | null; endMs: number | null; text: string }> {
  const json: unknown = JSON.parse(readFileSync(file, "utf8"));
  const segments = Array.isArray(json) ? json : (json as { transcript?: unknown } | null)?.transcript;
  if (!Array.isArray(segments)) throw new Error(`${file} has no transcript`);
  return segments as Array<{ startMs: number | null; endMs: number | null; text: string }>;
}

async function build(args: string[]): Promise<void> {
  const { vault, notePath } = locate(args);
  const transcriptFile = option(args, "--transcript");
  const target = option(args, "--out-candidates");
  if (!!transcriptFile !== !!target) usage();
  const files = vaultFiles(vault);
  const r = await updateLectureBrief(files, notePath, { today: formatDate(), queryPrefixes: dataviewQueryPrefixes(vault) });
  const out: Record<string, unknown> = { brief: join(vault, r.path), result: r.result, ai: null };
  if (!transcriptFile || !target) out.aiReason = "no transcript";
  else if (r.result === "edited") out.aiReason = "edited";
  else {
    const timed = timedTranscript(readSegments(transcriptFile));
    const script = await buildBriefScript(notePath, (await files.read(notePath)) ?? "");
    const input = timed ? await aiInputFor(script, timed) : null;
    const old = aiOf((await files.read(r.path)) ?? "");
    if (!timed) out.aiReason = "no timestamps";
    else if (!input) out.aiReason = "no candidates";
    else if (old.hash === input.hash && aiPartStatus(old.part) === "ok") out.aiReason = "same";
    else {
      const saved: SavedCandidates = {
        note: notePath,
        sourceHash: script.sourceHash,
        hash: input.hash,
        lengthMs: input.lengthMs,
        units: input.units,
        candidateText: input.candidateText,
        candidates: input.candidates,
      };
      const stem = target.replace(/\.json$/i, "");
      writePrivate(target, JSON.stringify(saved, null, 2) + "\n");
      // The Skill answers in its own session: the schema goes with the instructions.
      writePrivate(`${stem}.system.md`, `${input.system}\n\nJSON schema: ${JSON.stringify(BRIEF_AI_SCHEMA)}\n`);
      writePrivate(`${stem}.user.md`, `${input.user}\n`);
      out.ai = { candidates: target, system: `${stem}.system.md`, user: `${stem}.user.md`, count: input.candidates.length };
    }
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}

/**
 * The inline query prefixes set in Dataview (`inlineQueryPrefix`,
 * `inlineJsQueryPrefix` of its data.json in the vault), as the plugin reads
 * them from the app; none when the file is not there or not readable.
 */
function dataviewQueryPrefixes(vault: string): string[] {
  try {
    const data = JSON.parse(readFileSync(join(vault, ".obsidian", "plugins", "dataview", "data.json"), "utf8")) as { inlineQueryPrefix?: unknown; inlineJsQueryPrefix?: unknown } | null;
    return [data?.inlineQueryPrefix, data?.inlineJsQueryPrefix].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  } catch {
    return [];
  }
}

/** The session's answer: a JSON object, a ```json fence around it allowed. */
function readAnswer(file: string): unknown {
  const text = readFileSync(file, "utf8")
    .trim()
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
}

async function mergeAi(args: string[]): Promise<void> {
  const { vault, notePath } = locate(args);
  const answerFile = option(args, "--ai");
  const candidatesFile = option(args, "--candidates");
  if (!answerFile || !candidatesFile) usage();
  const saved = JSON.parse(readFileSync(candidatesFile, "utf8")) as SavedCandidates;
  if (saved.note !== notePath) throw new Error(`${candidatesFile} is for ${saved.note}, not ${notePath}`);
  const files = vaultFiles(vault);
  const noteText = await files.read(notePath);
  if (noteText === null) throw new Error(`no note at ${notePath}`);
  const script = await buildBriefScript(notePath, noteText);
  if (script.sourceHash !== saved.sourceHash) throw new Error("the note changed since build: run build again");
  const queryPrefixes = dataviewQueryPrefixes(vault);
  const ai = validateBriefAi(readAnswer(answerFile), saved, queryPrefixes);
  const today = formatDate();
  const path = briefPathForNote(notePath);
  // The session's tokens are not known: ai_part has the status only.
  const decision = await planBriefUpdate(await files.read(path), script, {
    today,
    ai: { sections: renderAiSections(ai, script.kind), hash: saved.hash, part: formatAiPart("ok"), oneLine: ai.oneLine },
    queryPrefixes,
  });
  if (decision.action === "write") {
    await files.write(path, decision.text);
    await updateSubjectBrief(files, notePath, script.subject, today, queryPrefixes);
  }
  const result = decision.action === "keep" ? decision.reason : "written";
  const kept = { emphasis: ai.emphasis.length, qa: ai.qa.length, pitfalls: ai.pitfalls.length, oneLine: !!ai.oneLine };
  process.stdout.write(JSON.stringify({ brief: join(vault, path), result, kept }) + "\n");
}

async function main(): Promise<void> {
  ensureWebCrypto();
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") await build(args);
  else if (command === "merge-ai") await mergeAi(args);
  else usage();
}

main().catch((e) => fail(e, "brief"));
