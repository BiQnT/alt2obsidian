// Browser stand-in for the parts of the obsidian API the Synced Viewer uses
// (test/dom-viewer.mjs). The markdown "renderer" handles what the layout
// needs: headings, paragraphs, and HTML comment lines (dropped, like
// Obsidian's reading view).
const P = HTMLElement.prototype;
P.createEl = function (tag, o = {}) {
  const el = document.createElement(tag);
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  this.appendChild(el);
  return el;
};
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
