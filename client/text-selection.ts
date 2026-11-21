import type { IBuffer, Terminal } from "@xterm/xterm";

/** Lets xterm select text on a plain drag even when a program requests mouse reports. */
export class TextSelection {
  private gesture?: AbortController;
  private readonly screen: HTMLElement;
  private touchAnchor?: { start: number; end: number; buffer: IBuffer; cols: number };

  constructor(private readonly term: Terminal, mount: HTMLElement, isMac: boolean) {
    const screen = this.screen = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
    mount.addEventListener("mousedown", (down) => {
      if (!down.isTrusted || down.button !== 0 || down.shiftKey || down.altKey || down.ctrlKey || down.metaKey ||
          term.modes.mouseTrackingMode === "none" || !(down.target instanceof Node) || !screen.contains(down.target)) return;

      // Keep clicks for the program. Only choose text selection once the pointer starts dragging.
      down.preventDefault();
      down.stopPropagation();
      term.clearSelection();
      term.focus();
      this.cancel();
      this.gesture = new AbortController();
      const capture = { capture: true, signal: this.gesture.signal };
      const replay = (select: boolean) => {
        this.cancel();
        const force = select && term.modes.mouseTrackingMode !== "none";
        screen.dispatchEvent(new MouseEvent("mousedown", {
          view: window, bubbles: true, cancelable: true,
          button: 0, buttons: 1, detail: down.detail,
          clientX: down.clientX, clientY: down.clientY,
          altKey: force && isMac,
          shiftKey: force && !isMac,
        }));
      };
      document.addEventListener("mousemove", (move) => {
        if (!(move.buttons & 1)) return this.cancel();
        if (Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) >= 4) replay(true);
      }, capture);
      document.addEventListener("mouseup", (up) => {
        if (up.button === 0) replay(false);
      }, capture);
      window.addEventListener("blur", () => this.cancel(), { signal: this.gesture.signal });
    }, { capture: true });
  }

  cancel() {
    this.gesture?.abort();
    this.gesture = undefined;
  }

  startTouch(x: number, y: number) {
    const cell = this.touchCell(x, y);
    if (!cell) return false;
    this.touchAnchor = { ...cell, buffer: this.term.buffer.active, cols: this.term.cols };
    this.moveTouch(x, y);
    return true;
  }

  moveTouch(x: number, y: number) {
    const anchor = this.touchAnchor;
    if (!anchor || anchor.buffer !== this.term.buffer.active || anchor.cols !== this.term.cols) return;
    const cell = this.touchCell(x, y);
    if (!cell) return;
    const start = Math.min(anchor.start, cell.start);
    const end = Math.max(anchor.end, cell.end);
    this.term.select(start % anchor.cols, Math.floor(start / anchor.cols), end - start);
  }

  endTouch() {
    this.touchAnchor = undefined;
  }

  private touchCell(x: number, y: number) {
    const { cols, rows, buffer: { active } } = this.term;
    const rect = this.screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const column = Math.max(0, Math.min(cols - 1, Math.floor((x - rect.left) * cols / rect.width)));
    const row = active.viewportY + Math.max(0, Math.min(rows - 1, Math.floor((y - rect.top) * rows / rect.height)));
    const width = active.getLine(row)?.getCell(column)?.getWidth() ?? 1;
    const at = row * cols + column;
    return { start: width === 0 && column > 0 ? at - 1 : at, end: at + Math.max(width, 1) };
  }
}
