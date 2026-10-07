// Browser entry for test/dom-settings.mjs: the real settings tab with
// Obsidian 1.14's setting DOM (test/helpers/obsidian-browser-stub.js) and
// layout rules (test/fixtures/dom/obsidian-settings.css) plus styles.css,
// at the pane width in ?w=. Measurements go to <pre id="out"> as JSON.
import { Alt2ObsSettingsTab } from "../../src/ui/SettingsTab";
import { DEFAULT_SETTINGS } from "../../src/types";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { Setting } from "obsidian";

const w = Number(new URLSearchParams(location.search).get("w") ?? "700");
const plugin: any = {
  data: {
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    cliDetection: {
      claude: { path: "/Users/me/.local/bin/claude", version: "2.1.291 (Claude Code)", detectedAt: "", featuresOk: true },
      codex: { path: "/Users/me/.nvm/versions/node/v22.22.1/bin/codex", version: "codex-cli 0.155.1", detectedAt: "", featuresOk: true },
    },
    usageTotals: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, imagesSent: 0, costUsd: 0, lectures: 0, byProvider: {}, since: "" },
  },
  cliErrors: {},
  detectCli: async () => null,
  savePluginData: async () => {},
  modelCatalog: () => ({ claude: [], codex: { models: [], efforts: {} }, resolved: { "claude-cli:sonnet": { id: "claude-sonnet-5-5", at: "2026-10-06" } } }),
  applyCommentHiding: () => {},
  updateBasePath: () => {},
};

function main() {
  const pane = document.getElementById("pane")!;
  pane.style.width = `${w}px`;
  const tab = new (Alt2ObsSettingsTab as any)({}, plugin);
  pane.appendChild(tab.containerEl);
  tab.display();
  // Control: a plain Setting row with a path field and a button in a 280px
  // box, without the plugin's classes. Under these rules its description
  // collapses, which shows the rules reproduce what users saw in beta.3.
  const control = document.getElementById("control")!;
  new (Setting as any)(control)
    .setName("실행 파일 경로")
    .setDesc("비워 두면 자동으로 찾습니다 (로그인 셸의 command -v 결과를 한 번 저장).")
    .addText((t: any) => t.setPlaceholder("/.../bin/claude"))
    .addButton((b: any) => b.setButtonText("다시 찾기"));

  const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
  const rows = Array.from(tab.containerEl.querySelectorAll(".setting-item")).map((item: any) => {
    const desc = box(item.querySelector(".setting-item-description"));
    const name = box(item.querySelector(".setting-item-name"));
    const info = box(item.querySelector(".setting-item-info"));
    return {
      name: item.querySelector(".setting-item-name")?.textContent ?? "",
      hasDesc: !!item.querySelector(".setting-item-description")?.textContent,
      descW: desc ? Math.round(desc.width) : 0,
      infoH: info ? Math.round(info.height) : 0,
      textH: Math.round((name?.height ?? 0) + (desc?.height ?? 0)),
    };
  });
  const cards = Array.from(tab.containerEl.querySelectorAll(".alt2obs-card")).map((card: any) => ({
    cardW: Math.round(card.clientWidth - parseFloat(getComputedStyle(card).paddingLeft) - parseFloat(getComputedStyle(card).paddingRight)),
    descW: Math.round(box(card.querySelector(".alt2obs-card-desc"))!.width),
    inputW: Math.round(box(card.querySelector("input"))!.width),
  }));
  const controlDescW = Math.round(box(control.querySelector(".setting-item-description"))!.width);
  return { w, rows, cards, controlDescW };
}
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    try {
      document.getElementById("out")!.textContent = JSON.stringify(main());
    } catch (e: any) {
      document.getElementById("out")!.textContent = "ERROR " + (e?.stack ?? e);
    }
  })
);
