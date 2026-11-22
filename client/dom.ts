// Small DOM helpers shared by the client's modules.

export type Props = {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Record<string, EventListener>;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Node[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [event, listener] of Object.entries(props.on ?? {})) node.addEventListener(event, listener);
  node.append(...children);
  return node;
}

/** Keep existing controls mounted so updates cannot interrupt clicks or focus. */
export function reconcile(parent: HTMLElement, children: Node[]) {
  let next = parent.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else parent.insertBefore(child, next);
  }
  while (next) {
    const old = next;
    next = old.nextSibling;
    old.remove();
  }
}

let pointerDown = false;
const deferred: (() => void)[] = [];
window.addEventListener("pointerdown", () => (pointerDown = true), { capture: true });
const release = () => {
  pointerDown = false;
  // The click follows pointerup; finish its dispatch before moving any controls.
  window.setTimeout(() => {
    if (!pointerDown) for (const action of deferred.splice(0)) action();
  }, 0);
};
window.addEventListener("pointerup", release, { capture: true });
window.addEventListener("pointercancel", release, { capture: true });
window.addEventListener("blur", release);

export function afterPointer(action: () => void) {
  if (pointerDown) deferred.push(action);
  else action();
}

/** Keep a touch action inside the browser's user gesture even if focus stays in the terminal. */
export function onTap(button: HTMLButtonElement, action: () => void) {
  button.addEventListener("click", action);
  button.addEventListener("touchend", (event) => {
    const touch = event.changedTouches[0];
    if (!touch || !event.cancelable || !button.contains(document.elementFromPoint(touch.clientX, touch.clientY))) return;
    event.preventDefault();
    action();
  }, { passive: false });
}

const PATHS = {
  plus: "M8 3v10M3 8h10",
  close: "M4 4l8 8M12 4l-8 8",
  copy: "M7 5.5h5A1.5 1.5 0 0 1 13.5 7v5a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 12V7A1.5 1.5 0 0 1 7 5.5zM10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5",
  select: "M3 5V3h5m3 0h2v2M3 11v2h2m3 0h5v-2M5 8h6",
  sessions: "M8 3.25 13.5 6 8 8.75 2.5 6zM2.5 9.5 8 12.25l5.5-2.75",
  edit: "M4 10 10.25 3.75a1.41 1.41 0 0 1 2 2L6 12l-2.75.75zM9 5l2 2",
  trash: "M3 4.5h10M6.25 4.5V3.5a1 1 0 0 1 1-1h1.5a1 1 0 0 1 1 1v1M4.5 4.5l.6 7.6a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4l.6-7.6",
  folder: "M2.5 4.5A1.5 1.5 0 0 1 4 3h2.4l1.5 1.5H12A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z",
  file: "M5 2.5h4l3.5 3.5v6A1.5 1.5 0 0 1 11 13.5H5A1.5 1.5 0 0 1 3.5 12V4A1.5 1.5 0 0 1 5 2.5zM9 2.5V5a1 1 0 0 0 1 1h2.5",
  link: "M7 5l1.5-1.5a2.1 2.1 0 0 1 3 3L10 8M9 11l-1.5 1.5a2.1 2.1 0 0 1-3-3L6 8m0 2 4-4",
  home: "M2.5 7.25 8 2.75l5.5 4.5M4 6.25V12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6.25M6.75 13v-3h2.5v3",
  up: "m4 7 4-4 4 4M8 3v10",
  refresh: "M12.5 6.5a4.6 4.6 0 1 0 .3 3.1M12.5 3v3.5H9",
  sliders: "M2 5h6M12 5h2M2 11h2M8 11h6M10 3v4M6 9v4",
} as const;

/** A 16px line icon that takes the color of the text around it. */
export function icon(name: keyof typeof PATHS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
