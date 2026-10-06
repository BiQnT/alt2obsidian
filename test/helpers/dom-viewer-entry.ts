// Browser entry for test/dom-viewer.mjs: the real SyncedViewerView against
// the obsidian stub, driven like a reader (scrolls, an edit refresh, a
// re-import). Results go to <pre id="out"> as JSON.
import { SyncedViewerView } from "../../src/ui/SyncedViewerView";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { TFile } from "obsidian";

(pdfjsLib as any).GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";
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
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
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
  return log;
}
main().then(
  (log) => (document.getElementById("out")!.textContent = JSON.stringify(log)),
  (e) => (document.getElementById("out")!.textContent = "ERROR " + ((e && e.stack) || e))
);
