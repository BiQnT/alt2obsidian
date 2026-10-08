// Browser entry for test/dom-sidebar.mjs: the real sidebar view
// (src/ui/SidebarView.ts) against the obsidian stub and a fake plugin.
// Startup: the Alt note list is built before the metadata cache has the
// imported lecture, then the cache catches up. Then the import's estimate
// panel and the 노트 검증 tab's own estimate are opened and the tabs
// switched. Results go to <pre id="out"> as JSON.
import { Alt2ObsSidebarView } from "../../src/ui/SidebarView";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { TFile } from "obsidian";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ok()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${what}`);
}

async function main() {
  const L5 = "Alt2Obsidian/CSED311/Lectures/L5.md";
  const task = { provider: "claude-cli", model: "sonnet", effort: "medium" };
  const notes = ["L5", "L6"].map((title, i) => ({ id: `${title}-id`, title, type: "slide", lectureDate: `2026-10-0${i + 1}`, folderId: null, folderPath: ["CSED311"], updatedAt: null }));
  const calls = { vault: 0, details: [] as string[], compared: [] as string[], listNotes: 0 };
  // The metadata cache has indexed L5 (startup: not yet).
  let indexed = false;
  const source = {
    mode: "api",
    listNotes: async () => (calls.listNotes++, notes),
    noteDetails: async (id: string) => (calls.details.push(id), { hasSlides: true, slidesTitle: id, pdfPath: `/alt/${id}.pdf`, transcriptMinutes: 100, timestamps: true }),
  };
  const prepared = {
    estimate: { calls: 4, inputTokens: 120000, outputTokens: 30000, imagesSent: 3, slidesTotal: 30, slidesGenerated: 0, slidesTemplated: 0, slidesDeduped: 0, slidesReused: 30 },
    plan: { transcriptChars: { before: 0, after: 0 }, scanned: false },
    transcriptPlan: null,
    notePath: L5,
    pdfSource: "alt",
    altPdfIgnored: false,
    alignment: null,
    preview: { altData: { title: "L5", transcript: null } },
    diagramPages: [3, 7],
    fewerImages: false,
    overCap: false,
  };
  const plugin: any = {
    data: { settings: { tasks: { commentary: task, concepts: task, verification: task, alignment: { provider: "none", model: "", effort: "" } }, recentModels: {}, generation: { tokenCapPerLecture: 1000000 } }, recentImports: [] },
    vaultManager: { getKnownSubjects: () => [] },
    notionFetchModel: () => ({ model: "haiku", effort: "low" }),
    modelCatalog: () => ({ claude: [], codex: { models: [], efforts: {} }, resolved: {} }),
    verifySourceFiles: () => [],
    verifyTargets: () => [{ path: L5, title: "L5", subject: "CSED311" }],
    connectLocal: async () => ({ source, label: "Alt 연결됨", detail: "" }),
    getLocalSource: () => source,
    // The plugin reads lecture notes from the metadata cache.
    vaultLectureNotes: () => (calls.vault++, indexed ? [{ path: L5, title: "L5", subject: "CSED311", altLocalId: "L5-id", slideNote: true }] : []),
    localNoteStatus: (note: { id: string }, vault: Array<{ path: string; altLocalId?: string }>) => {
      const own = vault.find((v) => v.altLocalId === note.id);
      return own ? { kind: "imported", path: own.path, changed: null } : { kind: "new" };
    },
    lectureKindFor: () => "slides",
    notePathForLocal: (note: { title: string }) => `Alt2Obsidian/CSED311/Lectures/${note.title}.md`,
    siblingPdf: (p: string) => ({ path: p.replace(/\.md$/, ".pdf") }),
    localPdfPageCount: async () => 30,
    slideChanges: async (path: string) => (calls.compared.push(path), 0),
    previewLocal: async () => ({ altData: { title: "L5" }, bundle: { warnings: [] } }),
    prepareCliImport: async () => prepared,
    runTask: () => task,
    prepareVerification: async () => ({
      estimate: { claims: 12, judged: 10, inputTokens: 40000, outputTokens: 6000, contextEvidence: 0, unmatched: 0, likelyTrue: 0, uncoveredSlides: 2, calls: 2, unmatchedWarning: false },
      task,
      plan: { unit: "slide", hasTranscript: true },
      outPath: "Alt2Obsidian/CSED311/Verification/L5 verification.md",
      overCap: false,
    }),
  };
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = { changed: [], resolved: [] };
  const app = {
    vault: { getAbstractFileByPath: () => null },
    metadataCache: { on: (name: string, cb: (...a: unknown[]) => void) => (handlers[name]?.push(cb), {}) },
    workspace: { openLinkText: async () => {} },
  };
  const fire = (name: string, ...args: unknown[]) => handlers[name].forEach((cb) => cb(...args));

  const view: any = new (Alt2ObsSidebarView as any)({}, plugin);
  view.app = app;
  document.getElementById("host")!.appendChild(view.containerEl);
  await view.onOpen();
  const root: HTMLElement = view.containerEl;
  const items = () => Array.from(root.querySelectorAll(".alt-to-obs-note-item"));
  const chips = () => Object.fromEntries(items().map((el) => [el.querySelector(".alt-to-obs-note-title")!.textContent, el.querySelector(".alt-to-obs-chip")!.textContent]));
  const visible = (el: Element | null | undefined) => !!el && el.isConnected && (el as HTMLElement).checkVisibility();
  await until("the list", () => items().length === 2);
  await until("the details", () => calls.details.length === 2);
  const log: any[] = [];
  const counts = () => ({ vault: calls.vault, details: calls.details.length, compared: calls.compared.length, listNotes: calls.listNotes });
  log.push({ step: "built before the cache", chips: chips(), ...counts() });

  // Obsidian finishes indexing: "resolved" alone (nothing about a lecture note changed) reads nothing.
  fire("resolved");
  fire("changed", new (TFile as any)("notes/other.md"), "", { frontmatter: { title: "x" } });
  fire("resolved");
  log.push({ step: "unrelated", chips: chips(), ...counts() });
  // L5's metadata arrives, then the cache is resolved.
  indexed = true;
  fire("changed", new (TFile as any)(L5), "", { frontmatter: { alt_local_id: "L5-id" } });
  log.push({ step: "L5 changed", chips: chips(), ...counts() });
  fire("resolved");
  await until("the slide comparison", () => calls.compared.length === 1);
  await sleep(50);
  log.push({ step: "resolved", chips: chips(), ...counts() });
  fire("resolved");
  log.push({ step: "resolved again", ...counts() });

  // The import's estimate for L5, from the list.
  const button = (scope: Element, text: string) => Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement;
  (items().find((el) => el.textContent!.includes("L5")) as HTMLElement).click();
  button(root, "다시 가져오기").click();
  const panel = root.querySelector(".alt-to-obs-cli-panel.alt-to-obs-import-only")!;
  await until("the import estimate", () => !!panel.textContent!.includes("가져오기 전 예상 사용량"));
  const verifyPane = root.querySelector(".alt-to-obs-verify-pane")!;
  const verifyEstimate = () => verifyPane.querySelector(".alt-to-obs-cli-panel");
  const tab = (label: string) => button(root.querySelector(".alt-to-obs-tabs")!, label).click();
  const where = (step: string) => ({
    step,
    importPanel: visible(panel),
    importText: panel.textContent!.includes("변경 없음 30") && panel.textContent!.includes("Attachments/"),
    verifyEstimate: visible(verifyEstimate()),
    verifyInputs: visible(verifyPane),
  });
  log.push(where("local"));
  tab("노트 검증");
  log.push(where("verify"));
  // The verification estimate of the 노트 검증 tab.
  button(verifyPane, "붙여넣기").click();
  (verifyPane.querySelector("textarea") as HTMLTextAreaElement).value = "- 캐시는 빠르다";
  button(verifyPane, "예상 사용량 보기").click();
  await until("the verification estimate", () => !!verifyEstimate()?.textContent!.includes("검증 전 예상 사용량"));
  log.push(where("verify estimate"));
  tab("URL 붙여넣기");
  log.push(where("url"));
  tab("Alt 노트 목록");
  log.push(where("local again"));
  // The pending choice is still there: 취소 ends the import as before.
  button(panel, "취소").click();
  await until("the cancel message", () => root.textContent!.includes("가져오기를 취소했습니다"));
  log.push({ step: "cancelled", importPanel: visible(panel) });
  return log;
}
main().then(
  (log) => (document.getElementById("out")!.textContent = JSON.stringify(log)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
