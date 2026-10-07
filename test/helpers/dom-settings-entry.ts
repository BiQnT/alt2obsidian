// Browser entry for test/dom-settings.mjs: the real settings tab with
// Obsidian 1.14's setting DOM (test/helpers/obsidian-browser-stub.js) and
// layout rules (test/fixtures/dom/obsidian-settings.css) plus styles.css,
// at the pane width in ?w=. ?path=old draws it the way Obsidian before 1.13
// does (display()); ?path=new the way 1.13 and later do, from its setting
// definitions (renderDefinitions below, after Obsidian 1.14.4's renderer).
// ?scenario=full adds a stored legacy API key, usage and a CLI not found.
// ?mode=interact changes settings through the drawn controls instead of
// measuring. Results go to <pre id="out"> as JSON.
import { Alt2ObsSettingsTab } from "../../src/ui/SettingsTab";
import { DEFAULT_SETTINGS } from "../../src/types";
// @ts-ignore resolved to test/helpers/obsidian-browser-stub.js
import { Setting } from "obsidian";

const params = new URLSearchParams(location.search);
const w = Number(params.get("w") ?? "700");
const path = params.get("path") ?? "old";
const scenario = params.get("scenario") ?? "default";

function makePlugin(): any {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const usageTotals = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, imagesSent: 0, costUsd: 0, lectures: 0, byProvider: {}, since: "" };
  const cliDetection: Record<string, unknown> = {
    claude: { path: "/Users/me/.local/bin/claude", version: "2.1.291 (Claude Code)", detectedAt: "", featuresOk: true },
    codex: { path: "/Users/me/.nvm/versions/node/v22.22.1/bin/codex", version: "codex-cli 0.155.1", detectedAt: "", featuresOk: true },
  };
  const cliErrors: Record<string, string> = {};
  if (scenario === "full") {
    settings.geminiApiKey = "x";
    settings.tasks.alignment = { provider: "codex-cli", model: "", effort: "low" };
    Object.assign(usageTotals, { calls: 12, inputTokens: 345678, cachedInputTokens: 120000, outputTokens: 23456, imagesSent: 7, lectures: 3, since: "2026-09-01" });
    delete cliDetection.codex;
    cliErrors.codex = "codex CLI를 찾지 못했습니다";
  }
  return {
    data: { settings, cliDetection, usageTotals },
    cliErrors,
    saves: 0,
    catalogReads: 0,
    detectCli: async () => null,
    async savePluginData() {
      this.saves++;
    },
    modelCatalog() {
      this.catalogReads++;
      return { claude: [], codex: { models: [], efforts: {} }, resolved: { "claude-cli:sonnet": { id: "claude-sonnet-5-5", at: "2026-10-06" } } };
    },
    applyCommentHiding: () => {},
    updateBasePath: () => {},
    keepOpenPdfTabsPlain: () => {},
  };
}

/**
 * Obsidian 1.14.4's drawing of setting definitions, for the parts this tab
 * uses: a div.setting-group per group (its heading row, then div.setting-items),
 * a Setting per row with the row's name and description set before its
 * render callback runs, controls bound with getControlValue / setControlValue
 * (bindControl), and `visible` applied after drawing.
 */
function renderDefinitions(tab: any, root: HTMLElement): void {
  root.empty();
  for (const group of tab.getSettingDefinitions()) {
    if (group.type !== "group") throw new Error(`top-level item of type ${group.type}`);
    const groupEl = root.createDiv({ cls: "setting-group" });
    if (group.heading) {
      const header = groupEl.createDiv({ cls: "setting-item setting-item-heading" });
      header.createDiv({ cls: "setting-item-name", text: group.heading });
      header.createDiv({ cls: "setting-item-control" });
    }
    groupEl.createDiv({ cls: "setting-group-search" });
    const listEl = groupEl.createDiv({ cls: "setting-items" });
    for (const def of group.items) {
      const setting: any = new Setting(listEl);
      setting.setName(def.name ?? "");
      setting.setDesc(def.desc ?? "");
      if (def.render) def.render(setting, null);
      else if (def.control) bindControl(tab, setting, def.control);
      const visible = typeof def.visible === "function" ? def.visible() : def.visible ?? true;
      setting.settingEl.toggle(visible);
    }
  }
}

/**
 * A control as Obsidian 1.14.4 binds it: the control's validate() runs on the
 * stored value once drawn and on each change; a message is shown under the
 * row and the change is not written. A number field commits on Enter or when
 * it loses focus: empty is the default value (shown in the field), and a
 * value that is not a number or is below the minimum shows Obsidian's error
 * and goes no further. Escape puts back the field's last committed text.
 */
function bindControl(tab: any, setting: any, control: any): void {
  const value = tab.getControlValue(control.key) ?? control.defaultValue;
  const write = async (v: unknown) => {
    const error = await control.validate?.(v);
    setting.setErrorMessage(error || null);
    if (!error) await tab.setControlValue(control.key, v);
  };
  if (control.validate) void Promise.resolve(control.validate(value)).then((error: unknown) => error && setting.setErrorMessage(error));
  if (control.type === "toggle") setting.addToggle((t: any) => t.setValue(value).onChange(write));
  else if (control.type === "dropdown")
    setting.addDropdown((d: any) => {
      for (const [v, label] of Object.entries(control.options)) d.addOption(v, label);
      d.setValue(value).onChange(write);
    });
  else if (control.type === "text")
    setting.addText((t: any) => {
      if (control.placeholder) t.setPlaceholder(control.placeholder);
      t.setValue(value || "").onChange(write);
    });
  else if (control.type === "number")
    setting.addText((t: any) => {
      const input: HTMLInputElement = t.inputEl;
      let last: number | null = typeof value === "number" && !Number.isNaN(value) ? value : null;
      input.value = last === null ? "" : String(last);
      const commit = () => {
        if (input.value === "") {
          last = control.defaultValue ?? 0;
          input.value = String(last);
          return void write(last);
        }
        const n = parseFloat(input.value);
        if (Number.isNaN(n)) setting.setErrorMessage("Not a number");
        else if (control.min !== undefined && n < control.min) setting.setErrorMessage(`At least ${control.min}`);
        else {
          last = n;
          void write(n);
        }
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") {
          input.value = last === null ? "" : String(last);
          setting.setErrorMessage(null);
        }
      });
    });
  else throw new Error(`control type ${control.type}`);
}

// ---- the outline: what each path shows, in order ----

function controlKind(el: Element): string | null {
  if (el.classList.contains("is-measuring")) return null;
  const hidden = (el as HTMLElement).style.display === "none" ? ":hidden" : "";
  if (el instanceof HTMLSelectElement) return `select${hidden}(${el.value})[${Array.from(el.options).map((o) => `${o.value}=${o.text}`).join("|")}]`;
  if (el instanceof HTMLInputElement) return `input${hidden}(${el.value}|${el.placeholder})`;
  if (el instanceof HTMLButtonElement) return `button${hidden}(${el.textContent})`;
  if (el.classList.contains("checkbox-container")) return `toggle${hidden}(${el.classList.contains("is-enabled")})`;
  return `${el.tagName.toLowerCase()}${hidden}.${el.className}`;
}

function rowEntry(item: Element): unknown {
  const name = item.querySelector(".setting-item-name")?.textContent ?? "";
  if (item.classList.contains("setting-item-heading")) return { heading: name };
  const controls = Array.from(item.querySelector(".setting-item-control")?.children ?? []).map(controlKind).filter(Boolean);
  return { name, desc: item.querySelector(".setting-item-description")?.textContent ?? "", controls };
}

const blockEntry = (el: Element) => ({ block: el.className, text: el.textContent });

/** display(): headings, rows and blocks straight in the tab's container. */
function outlineOld(root: Element): unknown[] {
  return Array.from(root.children).map((el) => (el.classList.contains("setting-item") ? rowEntry(el) : blockEntry(el)));
}

/** The definitions drawn: group headings, then rows (a block row as its block); hidden rows left out. */
function outlineNew(root: Element): unknown[] {
  const out: unknown[] = [];
  for (const group of Array.from(root.children)) {
    for (const el of Array.from(group.children)) {
      if (el.classList.contains("setting-item-heading")) out.push(rowEntry(el));
      if (!el.classList.contains("setting-items")) continue;
      for (const item of Array.from(el.children) as HTMLElement[]) {
        if (item.style.display === "none") continue;
        if (item.classList.contains("alt-to-obs-settings-block")) out.push(...Array.from(item.children).map(blockEntry));
        else out.push(rowEntry(item));
      }
    }
  }
  return out;
}

/** Group headings and row names of the definitions, as `heading` / `heading > name`. */
function definitionNames(tab: any): string[] {
  return tab.getSettingDefinitions().flatMap((g: any) => [`${g.heading ?? ""}`, ...g.items.map((d: any) => `${g.heading ?? ""} > ${d.name}`)]);
}

/** display()'s headings and setting row names in the same form (blocks have none). */
function displayNames(root: Element): string[] {
  const out = [""];
  let heading = "";
  for (const el of Array.from(root.children)) {
    if (!el.classList.contains("setting-item")) continue;
    const name = el.querySelector(".setting-item-name")?.textContent ?? "";
    if (el.classList.contains("setting-item-heading")) out.push((heading = name));
    else out.push(`${heading} > ${name}`);
  }
  return out;
}

function setup() {
  const pane = document.getElementById("pane")!;
  pane.style.width = `${w}px`;
  const plugin = makePlugin();
  const tab = new (Alt2ObsSettingsTab as any)({}, plugin);
  pane.appendChild(tab.containerEl);
  if (path === "new") {
    (window as unknown as { obsidianApiVersion: string }).obsidianApiVersion = "1.14.4";
    tab.updates = 0;
    // update(): the definitions are read again and the tab is drawn from them.
    tab.update = () => {
      tab.updates++;
      renderDefinitions(tab, tab.containerEl);
    };
    renderDefinitions(tab, tab.containerEl);
  } else {
    tab.display();
  }
  return { plugin, tab };
}

function measure() {
  const { plugin, tab } = setup();
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
  const rows = Array.from(tab.containerEl.querySelectorAll(".setting-item:not(.alt-to-obs-settings-block)"))
    .filter((item: any) => item.style.display !== "none")
    .map((item: any) => {
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
  const cards = Array.from(tab.containerEl.querySelectorAll(".alt-to-obs-card")).map((card: any) => ({
    cardW: Math.round(card.clientWidth - parseFloat(getComputedStyle(card).paddingLeft) - parseFloat(getComputedStyle(card).paddingRight)),
    descW: Math.round(box(card.querySelector(".alt-to-obs-card-desc"))!.width),
    inputW: Math.round(box(card.querySelector("input"))!.width),
  }));
  const blocks = Array.from(tab.containerEl.querySelectorAll(".alt-to-obs-settings-block")).map((el: any) => ({
    w: Math.round(box(el)!.width),
    childW: Math.round(box(el.firstElementChild)!.width),
  }));
  const controlDescW = Math.round(box(control.querySelector(".setting-item-description"))!.width);
  const outline = path === "new" ? outlineNew(tab.containerEl) : outlineOld(tab.containerEl);
  return {
    w,
    path,
    scenario,
    rows,
    cards,
    blocks,
    controlDescW,
    outline,
    definitionNames: definitionNames(tab),
    displayNames: path === "old" ? displayNames(tab.containerEl) : [],
    catalogReads: plugin.catalogReads,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const find = (root: HTMLElement, name: string) =>
  Array.from(root.querySelectorAll(".setting-item")).find((el) => el.querySelector(".setting-item-name")?.textContent === name) as HTMLElement;

/** Changes made through the drawn controls: the settings, the saves and the redraws they lead to. */
async function interact() {
  const { plugin, tab } = setup();
  const root: HTMLElement = tab.containerEl;
  const select = (name: string) => find(root, name).querySelector("select") as HTMLSelectElement;
  const out: Record<string, unknown> = {};

  const preset = select("프리셋");
  preset.value = "saving";
  preset.dispatchEvent(new Event("change"));
  await tick();
  out.preset = plugin.data.settings.preset;
  out.commentaryModel = plugin.data.settings.tasks.commentary.model;
  // Drawn again: the task row shows the preset's model.
  out.commentaryModelSelect = (find(root, "슬라이드 해설").querySelector("select.alt-to-obs-model-select") as HTMLSelectElement).value;

  // A number field: before 1.13 every keystroke saves; from 1.13 on Enter commits.
  const batchInput = () => find(root, "배치 크기").querySelector("input") as HTMLInputElement;
  const enter = async (text: string) => {
    const input = batchInput();
    input.value = text;
    input.dispatchEvent(path === "new" ? new KeyboardEvent("keydown", { key: "Enter" }) : new Event("input"));
    await tick();
  };
  await enter("12");
  out.batchSize = plugin.data.settings.generation.batchSize;

  const toggle = find(root, "핵심 다이어그램 이미지 저장").querySelector(".checkbox-container") as HTMLElement;
  toggle.click();
  await tick();
  out.saveKeyDiagrams = plugin.data.settings.generation.saveKeyDiagrams;

  const reset = find(root, "누적 사용량").querySelector("button") as HTMLButtonElement;
  reset.click();
  await tick();
  out.usageCalls = plugin.data.usageTotals.calls;
  out.usageDesc = find(root, "누적 사용량").querySelector(".setting-item-description")?.textContent;

  const clear = find(root, "이전 API 키 지우기")?.querySelector("button") as HTMLButtonElement | undefined;
  clear?.click();
  clear?.click();
  await tick();
  await tick();
  out.legacyKey = plugin.data.settings.geminiApiKey ?? null;
  const legacyRow = find(root, "이전 API 키 지우기");
  out.legacyRowShown = !!legacyRow && legacyRow.style.display !== "none";

  out.saves = plugin.saves;
  out.updates = tab.updates ?? null;

  // The number field at its edges: what is saved, what the field shows, the error under the row.
  const saves = plugin.saves;
  const numbers: unknown[] = [];
  for (const text of ["8.5", "0", ""]) {
    await enter(text);
    const row = find(root, "배치 크기");
    const error = row.classList.contains("is-invalid") ? row.querySelector(".setting-item-error")?.textContent ?? "" : null;
    numbers.push({ text, saved: plugin.data.settings.generation.batchSize, shown: batchInput().value, error });
  }
  out.numbers = numbers;
  out.numberSaves = plugin.saves - saves;

  // The transcript cap given 500, then emptied: the saved value after each.
  const caps: number[] = [];
  for (const text of ["500", ""]) {
    const input = find(root, "슬라이드당 전사 상한 (자)").querySelector("input") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(path === "new" ? new KeyboardEvent("keydown", { key: "Enter" }) : new Event("input"));
    await tick();
    caps.push(plugin.data.settings.generation.transcriptCapChars);
  }
  out.transcriptCaps = caps;
  return out;
}

requestAnimationFrame(() =>
  requestAnimationFrame(async () => {
    try {
      const result = params.get("mode") === "interact" ? await interact() : measure();
      document.getElementById("out")!.textContent = JSON.stringify(result);
    } catch (e: any) {
      document.getElementById("out")!.textContent = "ERROR " + (e?.stack ?? e);
    }
  })
);
