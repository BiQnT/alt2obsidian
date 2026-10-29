// Opening and closing the question panel (2.1.0 spec 5.1). The panel is
// not always there: it opens on demand in the right sidebar (the Synced
// Viewer's 💬 질문 button, the command), and closing it (the button again,
// its ×, the command, or the tab's own close) detaches its tab. When the
// right sidebar was collapsed before it opened, it is collapsed again on
// close. A panel tab Obsidian restores at startup is detached once the
// layout is ready. The threads and their running answers live in the
// plugin, so they survive this.

import type { WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_CHAT = "alt2obsidian-chat";

/**
 * Workspace event of the Synced Viewer when its page changes, with
 * `{ mdPath, pdfPath, page }` (spec 5.2). The question panel follows it.
 */
export const SLIDE_CHANGE_EVENT = "alt2obsidian:slide-change";

export interface SlideChangeInfo {
  mdPath: string | null;
  pdfPath: string | null;
  page: number;
}

/** The workspace parts the controller uses (Obsidian's Workspace has them all). */
export interface ChatWorkspace {
  /** Obsidian's right sidedock (collapsed, collapse()); read defensively. */
  rightSplit: unknown;
  getLeavesOfType(type: string): WorkspaceLeaf[];
  getRightLeaf(split: boolean): WorkspaceLeaf | null;
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
}

function sidebar(ws: ChatWorkspace): { collapsed: boolean; collapse(): void } | null {
  const split = ws.rightSplit as { collapsed?: unknown; collapse?: unknown } | null;
  return split && typeof split.collapsed === "boolean" && typeof split.collapse === "function" ? (split as { collapsed: boolean; collapse(): void }) : null;
}

export class ChatPanelController {
  /** The right sidebar was collapsed when the panel opened: collapse it again when it closes. */
  private collapseOnClose = false;
  /** An open in progress: a second click waits for it instead of opening another panel. */
  private opening: Promise<void> | null = null;
  /** The plugin is unloading: a view closing from now on changes nothing. */
  private disposed = false;
  /** What onChange was last told (null: nothing yet). */
  private announced: boolean | null = null;

  constructor(
    private workspace: ChatWorkspace,
    /** Called when the panel opened or closed (the viewer buttons show it). */
    private onChange: (open: boolean) => void
  ) {}

  private leaves(): WorkspaceLeaf[] {
    return this.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
  }

  isOpen(): boolean {
    return this.leaves().length > 0;
  }

  /** Opens (or shows) the panel in the right sidebar. */
  open(): Promise<void> {
    this.opening ??= this.openNow().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openNow(): Promise<void> {
    const existing = this.leaves()[0];
    if (existing) {
      await this.workspace.revealLeaf(existing);
      return;
    }
    this.collapseOnClose = sidebar(this.workspace)?.collapsed ?? false;
    const leaf = this.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
    await this.workspace.revealLeaf(leaf);
    this.announce(true);
  }

  private announce(open: boolean, always = false): void {
    if (!always && this.announced === open) return;
    this.announced = open;
    this.onChange(open);
  }

  /**
   * Detaches the panel. Its view reports back through `closed`; a tab that
   * never showed its view (Obsidian defers background tabs) does not, so
   * the sidebar and the buttons are put back here too.
   */
  close(): void {
    for (const leaf of this.leaves()) leaf.detach();
    this.finishClose();
  }

  async toggle(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.isOpen()) this.close();
    else await this.open();
  }

  /** The panel's view closed (any way): the sidebar goes back to how it was when the panel opened. */
  closed(leaf: WorkspaceLeaf): void {
    if (this.disposed || this.leaves().some((l) => l !== leaf)) return;
    this.finishClose();
  }

  private finishClose(): void {
    if (this.disposed) return;
    if (this.collapseOnClose) sidebar(this.workspace)?.collapse();
    this.collapseOnClose = false;
    this.announce(false);
  }

  /**
   * At startup: a panel restored with the layout is detached (it opens only
   * on demand), the sidebar left as it is. The buttons are told it is
   * closed even when the restored tab never showed its view.
   */
  detachRestored(): void {
    this.collapseOnClose = false;
    this.close();
    if (!this.disposed) this.announce(false, true);
  }

  /**
   * The plugin unloads. Obsidian may close the panel's view before or after
   * onunload; from here on that changes nothing (no sidebar collapse, no
   * button update).
   */
  dispose(): void {
    this.disposed = true;
  }
}
