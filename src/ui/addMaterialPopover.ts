// The question panel's "+ 자료 추가" popover (2.1.0 spec 5.7): panel DOM,
// not an Obsidian Menu. Three tabs:
// - 이 강의: a range input ("14-18, 23", "14~18"; numbers outside the deck
//   are left out and said), the slide list (gist, time with a yellow "?"
//   when the alignment is uncertain, tokens; the current slide checked and
//   locked), what each added slide carries (slide text, commentary,
//   transcript, memo, slide image off by default), "N장 추가 · 약 Xk 토큰";
// - 다른 강의: subject and lecture dropdowns and the same list; adding puts
//   that lecture's brief in too (as "다른 강의 브리프");
// - 노트에서 선택한 글: the text selected in the note, put in as a quote.
// Up to 8 added slides; the estimate is rough, a send counts exactly.

import type { ChatLecture } from "./ChatView";
import { DEFAULT_INCLUDE, IncludeOptions, MAX_ADDED_SLIDES, planAddition, quoteOf, rowTime, rowTokens, SlideRow } from "../chat/addMaterial";

export type AddRequest = { lecture: ChatLecture; slides: number[]; include: IncludeOptions; withBrief: boolean } | { quote: string };

export interface AddPopoverOptions {
  lecture: ChatLecture;
  /** The slide the question is about (locked in the list), null without one. */
  current: number | null;
  /** Slides of a lecture already added. */
  alreadyAdded(notePath: string): number[];
  /** Slides already added, every lecture's. */
  addedCount: number;
  /** Other lecture notes, by subject. */
  choices: Array<{ path: string; name: string; subject: string }>;
  loadLecture(notePath: string): Promise<ChatLecture | null>;
  slideList(lecture: ChatLecture): Promise<SlideRow[]>;
  /** The text selected in the note now ("" for none). */
  selection(): string;
  onAdd(request: AddRequest): void;
  onClose(): void;
}

type Tab = "this" | "other" | "selection";

const INCLUDE_LABELS: Array<[keyof IncludeOptions, string]> = [
  ["slideText", "슬라이드 글"],
  ["commentary", "해설"],
  ["transcript", "전사 구간"],
  ["memo", "내 메모"],
  ["image", "슬라이드 이미지 (장당 약 1.1k)"],
];

function k(n: number): string {
  return `${(n / 1000).toFixed(1)}k`;
}

export function renderAddPopover(parent: HTMLElement, o: AddPopoverOptions): HTMLElement {
  const root = parent.createDiv({ cls: "alt-to-obs-chat-popover" });
  const tabs = root.createDiv({ cls: "alt-to-obs-chat-popover-tabs" });
  const body = root.createDiv({ cls: "alt-to-obs-chat-popover-body" });
  const tabButtons = new Map<Tab, HTMLButtonElement>();
  // Each tab shown gets a new token: a slide list that arrives after another tab was picked is dropped.
  let shown = 0;
  const show = (tab: Tab) => {
    const token = ++shown;
    const live = () => token === shown;
    for (const [t, b] of tabButtons) b.toggleClass("is-active", t === tab);
    body.empty();
    if (tab === "this") void renderPicker(body, o, o.lecture, false, live);
    else if (tab === "other") renderOther(body, o, live);
    else renderSelection(body, o);
  };
  for (const [tab, label] of [
    ["this", "이 강의"],
    ["other", "다른 강의"],
    ["selection", "노트에서 선택한 글"],
  ] as Array<[Tab, string]>) {
    const b = tabs.createEl("button", { text: label, cls: "alt-to-obs-chat-popover-tab" });
    b.addEventListener("click", () => show(tab));
    tabButtons.set(tab, b);
  }
  show("this");
  return root;
}

/** A lecture's slide list with the range input, the toggles and the footer; nothing when `live()` turned false while it was read. */
async function renderPicker(el: HTMLElement, o: AddPopoverOptions, lecture: ChatLecture, other: boolean, live: () => boolean): Promise<void> {
  const loading = el.createDiv({ cls: "alt-to-obs-muted", text: "슬라이드 목록을 읽는 중..." });
  const rows = await o.slideList(lecture);
  if (!live()) return;
  loading.remove();
  const current = other ? null : o.current;
  const already = o.alreadyAdded(lecture.notePath);
  const checked = new Set<number>();
  const include: IncludeOptions = { ...DEFAULT_INCLUDE };
  const rangeRow = el.createDiv({ cls: "alt-to-obs-chat-popover-range" });
  const rangeEl = rangeRow.createEl("input", { type: "text", placeholder: "범위 (예: 14-18, 23)", attr: { "aria-label": "슬라이드 범위" } });
  const note = el.createDiv({ cls: "alt-to-obs-chat-popover-note" });
  const list = el.createDiv({ cls: "alt-to-obs-chat-popover-list" });
  if (rows.length === 0) list.createDiv({ cls: "alt-to-obs-muted", text: "이 강의에는 슬라이드가 없습니다." });
  for (const row of rows) {
    const line = list.createEl("label", { cls: "alt-to-obs-chat-popover-row" });
    const box = line.createEl("input", { type: "checkbox" });
    box.dataset.slide = String(row.num);
    const locked = row.num === current || already.includes(row.num);
    box.checked = locked;
    box.disabled = locked;
    box.addEventListener("change", () => {
      if (box.checked) checked.add(row.num);
      else checked.delete(row.num);
      update();
    });
    line.createSpan({ cls: "alt-to-obs-chat-popover-num", text: String(row.num) });
    line.createSpan({ cls: "alt-to-obs-chat-popover-gist", text: row.gist });
    const time = rowTime(row.range);
    if (time.text) {
      const t = line.createSpan({ cls: "alt-to-obs-chat-popover-time", text: time.text });
      if (time.uncertain) t.createSpan({ cls: "alt-to-obs-chat-uncertain", text: "?", attr: { title: "정렬이 불확실한 구간" } });
    }
    line.createSpan({ cls: "alt-to-obs-chat-popover-tokens", text: k(rowTokens(row, include)) });
  }
  const toggles = el.createDiv({ cls: "alt-to-obs-chat-popover-toggles" });
  for (const [key, label] of INCLUDE_LABELS) {
    const t = toggles.createEl("label");
    const box = t.createEl("input", { type: "checkbox" });
    box.dataset.include = key;
    box.checked = include[key];
    box.addEventListener("change", () => {
      include[key] = box.checked;
      update();
    });
    t.appendText(label);
  }
  const footer = el.createDiv({ cls: "alt-to-obs-chat-popover-footer" });
  const summary = footer.createSpan({ cls: "alt-to-obs-chat-popover-summary" });
  footer.createEl("button", { text: "취소" }).addEventListener("click", () => o.onClose());
  const add = footer.createEl("button", { text: "추가", cls: "mod-cta" });
  const plan = () => planAddition({ rows, checked: Array.from(checked), range: rangeEl.value, max: rows.length > 0 ? Math.max(...rows.map((r) => r.num)) : 0, current, alreadyAdded: already, addedCount: o.addedCount, include });
  const update = () => {
    const p = plan();
    const notes = [
      p.ignored.length > 0 ? `슬라이드 수 밖의 번호는 뺐습니다: ${p.ignored.join(", ")}` : "",
      p.over.length > 0 ? `직접 더하는 슬라이드는 ${MAX_ADDED_SLIDES}장까지입니다 (뺀 슬라이드: ${p.over.join(", ")})` : "",
    ].filter(Boolean);
    note.setText(notes.join(" · "));
    note.toggle(notes.length > 0);
    for (const box of Array.from(list.querySelectorAll<HTMLInputElement>("input[data-slide]"))) {
      const n = Number(box.dataset.slide);
      if (!box.disabled) box.checked = p.slides.includes(n) || checked.has(n);
    }
    for (const [i, row] of rows.entries()) list.querySelectorAll(".alt-to-obs-chat-popover-tokens")[i]?.setText(k(rowTokens(row, include)));
    summary.setText(other ? `브리프와 ${p.slides.length}장 추가 · 약 ${k(p.tokens)} 토큰` : `${p.slides.length}장 추가 · 약 ${k(p.tokens)} 토큰`);
    add.disabled = !other && p.slides.length === 0;
  };
  rangeEl.addEventListener("input", update);
  add.addEventListener("click", () => {
    const p = plan();
    o.onAdd({ lecture, slides: p.slides, include: { ...include }, withBrief: other });
  });
  update();
}

function renderOther(el: HTMLElement, o: AddPopoverOptions, live: () => boolean): void {
  const others = o.choices.filter((c) => c.path !== o.lecture.notePath);
  if (others.length === 0) {
    el.createDiv({ cls: "alt-to-obs-muted", text: "보관함에 다른 강의 노트가 없습니다." });
    el.createDiv({ cls: "alt-to-obs-chat-popover-footer" }).createEl("button", { text: "취소" }).addEventListener("click", () => o.onClose());
    return;
  }
  const pick = el.createDiv({ cls: "alt-to-obs-chat-pick" });
  const subjects = Array.from(new Set(others.map((c) => c.subject)));
  const subjectEl = pick.createEl("select", { cls: "dropdown", attr: { "aria-label": "과목" } });
  for (const s of subjects) subjectEl.createEl("option", { text: s || "(과목 없음)", attr: { value: s } });
  subjectEl.value = subjects.includes(o.lecture.subject) ? o.lecture.subject : subjects[0];
  const lectureEl = pick.createEl("select", { cls: "dropdown", attr: { "aria-label": "강의" } });
  const listEl = el.createDiv();
  // The same for each lecture picked: only the last one's list is drawn.
  let loads = 0;
  const load = async () => {
    const token = ++loads;
    const current = () => token === loads && live();
    listEl.empty();
    const lecture = await o.loadLecture(lectureEl.value);
    if (!current()) return;
    if (!lecture) {
      listEl.createDiv({ cls: "alt-to-obs-muted", text: "강의 노트를 읽지 못했습니다." });
      return;
    }
    await renderPicker(listEl, o, lecture, true, current);
  };
  const fill = () => {
    lectureEl.empty();
    for (const c of others.filter((x) => x.subject === subjectEl.value)) lectureEl.createEl("option", { text: c.name, attr: { value: c.path } });
    void load();
  };
  subjectEl.addEventListener("change", fill);
  lectureEl.addEventListener("change", () => void load());
  fill();
}

function renderSelection(el: HTMLElement, o: AddPopoverOptions): void {
  const text = quoteOf(o.selection());
  if (!text) el.createDiv({ cls: "alt-to-obs-muted", text: "노트(synced viewer의 노트 창이나 편집기)에서 글을 선택한 뒤 이 탭을 다시 여세요." });
  else el.createDiv({ cls: "alt-to-obs-chat-popover-quote", text });
  const footer = el.createDiv({ cls: "alt-to-obs-chat-popover-footer" });
  footer.createEl("button", { text: "취소" }).addEventListener("click", () => o.onClose());
  const add = footer.createEl("button", { text: "인용으로 넣기", cls: "mod-cta" });
  add.disabled = !text;
  add.addEventListener("click", () => o.onAdd({ quote: text }));
}
