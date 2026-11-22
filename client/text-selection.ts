import type { Terminal } from "@xterm/xterm";

/** Lets xterm select text on a plain drag even when a program requests mouse reports.
    Programs that report every move (1003, e.g. Claude Code) keep the drag and select on
    their own: there the next hover report counts as input and clears xterm's selection. */
export class TextSelection {
  private gesture?: AbortController;

  constructor(term: Terminal, mount: HTMLElement, isMac: boolean) {
    const screen = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
    mount.addEventListener("mousedown", (down) => {
      if (!down.isTrusted || down.button !== 0 || down.shiftKey || down.altKey || down.ctrlKey || down.metaKey ||
          term.modes.mouseTrackingMode === "none" || term.modes.mouseTrackingMode === "any" || !(down.target instanceof Node) || !screen.contains(down.target)) return;

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
}
