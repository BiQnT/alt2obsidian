// Browser entry for test/dom-viewer.mjs: the real SyncedViewerView against
// the obsidian stub, driven like a reader (scrolls, an edit refresh, a
// re-import). Results go to <pre id="out"> as JSON.
import { SyncedViewerView } from "../../src/ui/SyncedViewerView";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createPdfWorkerUrl } from "../../src/pdf/pdfWorker";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { TFile } from "obsidian";

// The worker bundled into main.js, as the plugin sets it (src/main.ts).
(pdfjsLib as any).GlobalWorkerOptions.workerSrc = createPdfWorkerUrl();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let readDelay = 0;

async function main() {
  const noteText = await (await fetch("./note.md")).text();
  const pdfBytes = await (await fetch("./deck.pdf")).arrayBuffer();
  const app: any = {
    vault: {
      getAbstractFileByPath: (p: string) => new (TFile as any)(p),
      read: async () => {
        if (readDelay) await sleep(readDelay);
        return noteText;
      },
      readBinary: async () => pdfBytes.slice(0),
      on: () => ({}),
    },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }), on: () => ({}) },
    workspace: {},
  };
  const view: any = new (SyncedViewerView as any)({}, undefined, () => true);
  view.app = app;
  document.getElementById("host")!.appendChild(view.containerEl);
  (view.containerEl.children[1] as HTMLElement).style.height = "760px";
  await view.onOpen();
  await view.openPair("note.md", "deck.pdf");
  await sleep(500);
  const md: HTMLElement = view.mdPaneEl;
  const pdf: HTMLElement = view.pdfPaneEl;
  const state = (step: string) => ({ step, current: view.currentPage, pdf: view.slideInPane("pdf"), md: view.slideInPane("md"), mdTop: Math.round(md.scrollTop), pdfTop: Math.round(pdf.scrollTop) });
  const log: any[] = [];
  log.push({ headings: Array.from(view.slideHeadings.keys()), pages: view.totalPages });

  // Reader scrolls the PDF to page 12 in small steps.
  const t12 = view.pageWrappers[11].offsetTop;
  for (let y = pdf.scrollTop; y < t12; y += 90) { pdf.scrollTop = y; await sleep(16); }
  pdf.scrollTop = t12; await sleep(1500);
  log.push(state("pdf to 12"));

  // Reader scrolls the note to slide 20.
  const h20 = view.slideHeadings.get(20);
  if (!h20) throw new Error("no heading 20: " + JSON.stringify(log) + " h2s=" + md.querySelectorAll("h2").length + " " + (md.querySelector("h2")?.textContent ?? ""));
  const top20 = h20.getBoundingClientRect().top - md.getBoundingClientRect().top + md.scrollTop - 10;
  for (let y = md.scrollTop; y < top20; y += 120) { md.scrollTop = y; await sleep(16); }
  md.scrollTop = top20; await sleep(1500);
  log.push(state("md to 20"));

  // The note is edited elsewhere: vault "modify" re-renders the note pane.
  await view.refreshMarkdownOnly();
  await sleep(1500);
  log.push(state("edit refresh"));

  // Re-import of the same pair: both panes load again.
  await view.openPair("note.md", "deck.pdf");
  await sleep(1500);
  log.push(state("re-import"));

  // The reader scrolls the PDF while the note is reloading (slow read): the note
  // is not scrolled during the load and follows the PDF once it is back.
  readDelay = 600;
  const reload = view.refreshMarkdownOnly();
  await sleep(50);
  pdf.scrollTop = view.pageWrappers[24].offsetTop;
  await sleep(300);
  log.push({ ...state("during load"), loading: view.loading.md });
  await reload;
  readDelay = 0;
  await sleep(1500);
  log.push(state("after load"));

  // A big jump with the scrollbar.
  pdf.scrollTop = view.pageWrappers[26].offsetTop; await sleep(1500);
  log.push(state("pdf jump 27"));

  // Closing cancels pending frames and timers without errors.
  pdf.scrollTop = view.pageWrappers[3].offsetTop;
  await view.onClose();
  await sleep(300);
  log.push({ step: "closed", current: view.currentPage });

  // Restored at startup: Obsidian's WorkspaceLeaf.setViewState makes the
  // view, opens it (load writes the title bar, then onOpen), awaits setState
  // and then redraws the tab title. The metadata cache has not indexed the
  // note yet: no frontmatter until its "changed" event.
  const changed: Array<(file: unknown) => void> = [];
  let indexed = false;
  const fm = { alt_local_id: "L5-id", alt_alignment: "1:0-30 2:30-60" };
  const restoredApp: any = {
    ...app,
    metadataCache: {
      getFileCache: (f: { path: string }) => (indexed && f.path === "Lec/L5.md" ? { frontmatter: fm } : null),
      on: (name: string, cb: (file: unknown) => void) => (name === "changed" && changed.push(cb), {}),
    },
  };
  const transcript = [{ startMs: 1000, endMs: 4000, text: "첫 문장" }];
  const restored: any = new (SyncedViewerView as any)({}, async () => transcript, () => true);
  restored.app = restoredApp;
  const tabTitle = document.createElement("div");
  document.getElementById("host")!.replaceChildren(restored.containerEl);
  restored.load();
  await restored.onOpen();
  await restored.setState({ mdPath: "Lec/L5.md", pdfPath: "deck.pdf" }, { history: false });
  tabTitle.textContent = restored.getDisplayText();
  const shown = (el: HTMLElement) => el.isConnected && getComputedStyle(el).display !== "none";
  const ui = (step: string) => ({
    step,
    label: shown(restored.syncModeEl),
    transcriptButton: shown(restored.transcriptBtnEl),
    titleBar: restored.containerEl.querySelector(".view-header-title").textContent,
    tab: tabTitle.textContent,
  });
  log.push(ui("restored, not indexed"));
  // Another note's metadata changes nothing.
  indexed = true;
  for (const cb of changed) cb(new (TFile as any)("Lec/other.md"));
  log.push(ui("other note indexed"));
  for (const cb of changed) cb(new (TFile as any)("Lec/L5.md"));
  log.push(ui("note indexed"));
  restored.gotoPage(1);
  restored.transcriptBtnEl.click();
  await sleep(100);
  log.push({ step: "transcript", text: restored.transcriptPanelEl.textContent });
  await restored.onClose();
  return log;
}
main().then(
  (log) => (document.getElementById("out")!.textContent = JSON.stringify(log)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
