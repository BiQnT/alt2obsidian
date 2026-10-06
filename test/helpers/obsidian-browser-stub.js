// Browser stand-in for the parts of the obsidian API the Synced Viewer and
// the settings tab use (test/dom-viewer.mjs, test/dom-settings.mjs). The
// markdown "renderer" handles what the layout needs: headings, paragraphs,
// and HTML comment lines (dropped, like Obsidian's reading view). Setting
// builds the DOM Obsidian 1.14 builds (div.setting-item > div.setting-item-info
// > name + description, then div.setting-item-control; a dropdown adds a
// hidden measuring select).
const P = HTMLElement.prototype;
P.createEl = function (tag, o = {}) {
  if (typeof o === "string") o = { cls: o };
  const el = document.createElement(tag);
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.type) el.setAttribute("type", o.type);
  if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  this.appendChild(el);
  return el;
};
P.setAttr = function (k, v) { this.setAttribute(k, v); };
P.appendText = function (t) { this.appendChild(document.createTextNode(t)); };
P.removeClass = function (c) { this.classList.remove(c); };
P.createDiv = function (o) { return this.createEl("div", o); };
P.createSpan = function (o) { return this.createEl("span", o); };
P.empty = function () { this.innerHTML = ""; };
P.setText = function (t) { this.textContent = t; };
P.hide = function () { this.style.display = "none"; };
P.show = function () { this.style.display = ""; };
P.toggle = function (on) { this.style.display = on ? "" : "none"; };
P.addClass = function (c) { this.classList.add(c); };
P.toggleClass = function (c, on) { this.classList.toggle(c, on); };
export class TFile { constructor(path) { this.path = path; } }
export class Notice { constructor(m) { console.log("Notice", m); } }
export class Component { load() {} unload() {} }
export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.containerEl = document.createElement("div");
    this.containerEl.createDiv();
    this.containerEl.createDiv({ cls: "view-content" });
  }
  registerEvent() {}
  registerDomEvent(el, type, cb, opts) { el.addEventListener(type, cb, opts); }
  async setState() {}
}
export class WorkspaceLeaf {}
function inline(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
export const MarkdownRenderer = {
  // Enough markdown for layout: headings and paragraphs.
  async render(app, text, el) {
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    const html = [];
    for (const block of body.split(/\n{2,}/)) {
      const b = block.trim();
      if (!b) continue;
      const h = b.match(/^(#{1,6}) (.*)$/m);
      if (h && b.startsWith("#")) {
        html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        const rest = b.split("\n").slice(1).filter((l) => !/^\s*<!--.*-->\s*$/.test(l)).join("\n");
        if (rest) html.push(`<p>${inline(rest)}</p>`);
        continue;
      }
      const lines = b.split("\n").filter((l) => !/^\s*<!--.*-->\s*$/.test(l));
      if (lines.length === 0) continue;
      html.push(`<p>${inline(lines.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
    el.innerHTML = html.join("\n");
  },
};

export class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(t) { this.nameEl.setText(t); return this; }
  setDesc(t) { this.descEl.setText(t); return this; }
  addText(cb) {
    const inputEl = this.controlEl.createEl("input", { type: "text" });
    const c = { inputEl, setPlaceholder: (p) => (inputEl.placeholder = p, c), setValue: (v) => (inputEl.value = v, c), onChange: () => c };
    cb(c);
    return this;
  }
  addButton(cb) {
    const buttonEl = this.controlEl.createEl("button");
    const c = { buttonEl, setButtonText: (t) => (buttonEl.textContent = t, c), setWarning: () => c, setDisabled: (d) => (buttonEl.disabled = d, c), onClick: () => c };
    cb(c);
    return this;
  }
  addDropdown(cb) {
    const selectEl = this.controlEl.createEl("select", { cls: "dropdown" });
    this.controlEl.createEl("select", { cls: "dropdown is-measuring" });
    const c = { selectEl, addOption: (v, t) => (selectEl.createEl("option", { text: t, attr: { value: v } }), c), setValue: (v) => (selectEl.value = v, c), onChange: () => c };
    cb(c);
    return this;
  }
  addToggle(cb) {
    const toggleEl = this.controlEl.createEl("label", { cls: "checkbox-container" });
    const c = { toggleEl, setValue: () => c, onChange: () => c };
    cb(c);
    return this;
  }
}
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }
}
export class Modal { constructor(app) { this.app = app; this.contentEl = document.createElement("div"); } open() {} close() {} }
export const setIcon = () => {};
