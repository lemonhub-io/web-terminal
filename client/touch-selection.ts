import type { IBuffer, Terminal } from "@xterm/xterm";
import { h, onTap } from "./dom.ts";
import { t } from "./i18n.ts";

type Range = { start: number; end: number };
type Edge = keyof Range;
type Point = { x: number; y: number };

const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : undefined;

export class TouchSelection {
  private readonly screen: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private readonly manual: HTMLTextAreaElement;
  private readonly handles: Record<Edge, HTMLElement>;
  private range?: Range & { buffer: IBuffer; cols: number };
  private anchor?: Range;
  private handle?: { edge: Edge; id: number; offset: Point };
  private point?: Point;
  private scrollTimer = 0;
  private text = "";

  constructor(private readonly term: Terminal, private readonly mount: HTMLElement, private readonly changed: () => void) {
    this.screen = term.element!.querySelector<HTMLElement>(".xterm-screen")!;
    const action = (label: string, run: () => void) => {
      const button = h("button", {
        text: label, attrs: { type: "button" },
        on: { pointerdown: (event) => event.preventDefault() },
      });
      onTap(button, run);
      return button;
    };
    this.copyButton = action(t("copy"), () => void this.copy());
    this.hint = h("span", { attrs: { role: "status" } });
    this.manual = h("textarea", { attrs: { readonly: "", rows: "3", "aria-label": t("selectedText") } });
    this.manual.hidden = true;
    this.handles = { start: this.makeHandle("start"), end: this.makeHandle("end") };
    this.layer = h("div", { class: "touch-selection" }, this.handles.start, this.handles.end,
      h("div", { class: "touch-actions" },
        this.manual, h("div", { class: "touch-actions-row" }, this.hint, this.copyButton, action(t("done"), () => this.close()))));
    this.layer.hidden = true;
    mount.append(this.layer);
    term.onRender(() => this.paintHandles());
    term.onScroll(() => this.paintHandles());
    term.onSelectionChange(() => this.paintHandles());
    mount.addEventListener("pointerdown", (event) => {
      if (this.active && event.pointerType === "mouse" && !this.layer.contains(event.target as Node)) this.close();
    }, { capture: true });
  }

  get active() {
    return !this.layer.hidden;
  }

  open() {
    if (this.active) return;
    this.layer.hidden = false;
    this.hint.textContent = t("dragToSelect");
    this.copyButton.hidden = true;
    this.handles.start.hidden = this.handles.end.hidden = true;
    this.changed();
  }

  close() {
    if (!this.active) return;
    this.layer.hidden = true;
    this.layer.classList.remove("dock-top");
    this.manual.hidden = true;
    this.manual.value = "";
    this.range = this.anchor = this.handle = undefined;
    this.stopScroll();
    this.text = "";
    this.term.clearSelection();
    this.changed();
  }

  start(x: number, y: number, word = false) {
    const cell = this.cellAt(x, y);
    if (!cell) return false;
    this.open();
    this.manual.hidden = true;
    this.hint.textContent = "";
    this.anchor = word ? this.wordAt(cell) : cell;
    this.select(this.anchor);
    this.text = this.term.getSelection();
    return true;
  }

  move(x: number, y: number) {
    this.drag({ x, y });
  }

  end() {
    if (!this.anchor) return;
    this.anchor = undefined;
    this.finishDrag();
  }

  private select(range: Range) {
    const { cols, buffer: { active: buffer } } = this.term;
    this.range = { ...range, buffer, cols };
    this.term.select(range.start % cols, Math.floor(range.start / cols), range.end - range.start);
    this.copyButton.hidden = false;
    this.paintHandles();
  }

  private cellAt(x: number, y: number): Range | undefined {
    const { cols, rows, buffer: { active } } = this.term;
    const rect = this.screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const col = Math.max(0, Math.min(cols - 1, Math.floor((x - rect.left) * cols / rect.width)));
    const row = active.viewportY + Math.max(0, Math.min(rows - 1, Math.floor((y - rect.top) * rows / rect.height)));
    const width = active.getLine(row)?.getCell(col)?.getWidth() ?? 1;
    const at = row * cols + col;
    return { start: width === 0 && col > 0 ? at - 1 : at, end: at + Math.max(width, 1) };
  }

  private wordAt(cell: Range): Range {
    const { cols, buffer: { active } } = this.term;
    const rowStart = cell.start - cell.start % cols;
    const line = active.getLine(rowStart / cols);
    if (!line || !words) return cell;
    const columns: number[] = [];
    const offsets: number[] = [];
    let text = "";
    for (let col = 0; col < cols;) {
      const value = line.getCell(col);
      const chars = value?.getChars() || " ";
      offsets[col] = text.length;
      for (let i = 0; i < chars.length; i++) columns.push(col);
      text += chars;
      col += Math.max(1, value?.getWidth() ?? 1);
    }
    const word = words.segment(text).containing(offsets[cell.start % cols]!);
    return word?.isWordLike ? {
      start: Math.min(cell.start, rowStart + columns[word.index]!),
      end: Math.max(cell.end, rowStart + (columns[word.index + word.segment.length] ?? cols)),
    } : cell;
  }

  private currentRange() {
    const range = this.range;
    if (range?.buffer === this.term.buffer.active && range.cols === this.term.cols && this.term.hasSelection()) return range;
  }

  private makeHandle(edge: Edge) {
    const end = (event: PointerEvent) => {
      if (this.handle?.id !== event.pointerId) return;
      this.handle = undefined;
      this.finishDrag();
    };
    const handle = h("span", { class: `touch-handle ${edge}`, attrs: { "aria-hidden": "true" } });
    handle.addEventListener("pointerdown", (event) => {
      const range = this.currentRange();
      if (!range || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      const at = this.position(range[edge], edge);
      this.handle = { edge, id: event.pointerId, offset: { x: event.clientX - at.x, y: event.clientY - at.y } };
      this.hint.textContent = "";
      this.manual.hidden = true;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      const handle = this.handle;
      if (handle?.id !== event.pointerId) return;
      this.drag({ x: event.clientX - handle.offset.x, y: event.clientY - handle.offset.y });
    });
    handle.addEventListener("pointerup", end);
    handle.addEventListener("lostpointercapture", end);
    return handle;
  }

  private position(index: number, edge: Edge, rect = this.screen.getBoundingClientRect()): Point {
    const { cols, rows, buffer: { active } } = this.term;
    // Place a line-ending handle at the end of that row even when the range ends at column zero.
    const cell = edge === "end" ? index - 1 : index;
    const col = cell % cols;
    const row = Math.floor(cell / cols) - active.viewportY;
    return {
      x: rect.left + (col + (edge === "end" ? 0.75 : 0.25)) * rect.width / cols,
      y: rect.top + (row + 0.5) * rect.height / rows,
    };
  }

  private paintHandles() {
    if (!this.active) return;
    const range = this.currentRange();
    const screen = this.screen.getBoundingClientRect();
    const mount = this.mount.getBoundingClientRect();
    for (const edge of ["start", "end"] as const) {
      const handle = this.handles[edge];
      if (!range || !screen.height) {
        handle.hidden = true;
        continue;
      }
      const { x, y } = this.position(range[edge], edge, screen);
      const offset = edge === "start" ? -6 : 6;
      handle.hidden = this.handle?.edge !== edge && (y < screen.top || y >= screen.bottom);
      handle.style.left = `${Math.max(12, Math.min(mount.width - 12, x - mount.left + offset))}px`;
      handle.style.top = `${Math.max(0, Math.min(mount.height - 24, y - mount.top + screen.height / this.term.rows / 2))}px`;
    }
    if (range && !this.point) this.layer.classList.toggle("dock-top", this.position(range.end, "end", screen).y > mount.bottom - 72);
  }

  private drag(point: Point) {
    this.point = point;
    this.extend(point);
    const rect = this.screen.getBoundingClientRect();
    const direction = point.y < rect.top + 10 ? -1 : point.y > rect.bottom - 10 ? 1 : 0;
    if (!direction || this.term.buffer.active.type !== "normal") {
      window.clearInterval(this.scrollTimer);
      this.scrollTimer = 0;
      return;
    }
    if (this.scrollTimer) return;
    this.scrollTimer = window.setInterval(() => {
      const next = this.point;
      if (!next) return;
      const screen = this.screen.getBoundingClientRect();
      const direction = next.y < screen.top + 10 ? -1 : next.y > screen.bottom - 10 ? 1 : 0;
      const before = this.term.buffer.active.viewportY;
      this.term.scrollLines(direction);
      if (this.term.buffer.active.viewportY !== before) this.extend(next);
    }, 65);
  }

  private extend(point: Point) {
    const range = this.currentRange();
    const cell = this.cellAt(point.x, point.y);
    if (!range || !cell) return;
    const anchor = this.anchor;
    const edge = this.handle?.edge;
    const start = anchor ? Math.min(anchor.start, cell.start) : edge === "start" && cell.start < range.end ? cell.start : range.start;
    const end = anchor ? Math.max(anchor.end, cell.end) : edge === "end" && cell.end > range.start ? cell.end : range.end;
    if (start !== range.start || end !== range.end) this.select({ start, end });
  }

  private finishDrag() {
    this.stopScroll();
    if (this.currentRange()) this.text = this.term.getSelection();
    this.paintHandles();
  }

  private stopScroll() {
    window.clearInterval(this.scrollTimer);
    this.scrollTimer = 0;
    this.point = undefined;
  }

  private async copy() {
    const range = this.range;
    const text = this.currentRange() ? this.term.getSelection() : this.text;
    if (!text) {
      this.hint.textContent = t("dragToSelect");
      return;
    }
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      if (!this.active || this.range !== range) return;
      this.manual.hidden = true;
      this.hint.textContent = t("copied");
    } catch {
      if (!this.active || this.range !== range) return;
      this.manual.value = text;
      this.manual.hidden = false;
      this.hint.textContent = t("manualCopy");
      this.manual.focus({ preventScroll: true });
      this.manual.select();
    }
  }
}
