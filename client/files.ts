import type { FileEntry, FilePage } from "../shared/files.ts";
import { h, icon } from "./dom.ts";
import { language, t } from "./i18n.ts";

interface FileRequest {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

interface Actions {
  request<T>(route: string, init?: FileRequest): Promise<T>;
  close(): void;
  unauthorized(): void;
}

type Edit = { kind: "create" } | { kind: "rename" | "delete"; entry: FileEntry };
/** A signed-in account acting as one of its system users ("" for its own when it has just one). */
type Target = { account: string; user: string };
type UploadFile = { file: File; sent: number };
type UploadIssue = { item: UploadFile; replace: boolean; error?: unknown };
type ActiveUpload = { item: UploadFile; done: Promise<void> };
type Upload = Target & {
  files: UploadFile[];
  path: string;
  next: number;
  uploaded: number;
  skipped: number;
  sent: number;
  totalBytes: number;
  active: Map<string, ActiveUpload>;
  issues: UploadIssue[];
  controller?: AbortController;
};

const uploadConcurrency = 3;
const checkUploadSize = 8 * 1024 * 1024;
const date = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" });
const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const power = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${number.format(bytes / 1024 ** power)} ${["B", "KiB", "MiB", "GiB", "TiB"][power]}`;
}

async function sendFile(route: string, file: File, signal: AbortSignal, onProgress: (bytes: number) => void) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    request.open("POST", `/api/${route}`);
    request.responseType = "json";
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.upload.onload = () => onProgress(file.size);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(Object.assign(new Error(request.response?.error ?? t("uploadFailed")), { status: request.status }));
    };
    request.onerror = () => reject(new Error(t("uploadFailed")));
    request.onabort = () => reject(signal.reason);
    request.onloadend = () => signal.removeEventListener("abort", abort);
    request.send(file);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function buildFilesPanel(actions: Actions) {
  let account = "";
  let user = "";
  let targets: Target[] = [];
  const key = (owner = account, as = user) => `${owner}\n${as}`;
  let page: FilePage | undefined;
  let hidden = false;
  let edit: Edit | undefined;
  let draft = "";
  let busy = false;
  let loading: AbortController | undefined;
  let batch: Upload | undefined;
  let fileDrag = 0;
  let disposed = false;
  const folders = new Map<string, string>();

  const status = h("p", { class: "file-status", attrs: { role: "status" } });
  const body = h("tbody");
  const fileInput = h("input", { attrs: { type: "file", multiple: "", "aria-label": t("uploadFiles") } });
  fileInput.hidden = true;
  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    startUpload(files);
  });

  const button = (text: string, click: () => void, className = "plain") => h("button", {
    class: className, text, attrs: { type: "button" }, on: { click },
  });
  const tool = (name: Parameters<typeof icon>[0], label: string, click: () => void) => h("button", {
    class: "tool", attrs: { type: "button", title: label, "aria-label": label }, on: { click },
  }, icon(name));
  /** Who the files are read as, in the same sliding control the settings use. */
  const picker = h("div", { class: "segs", attrs: { role: "group", "aria-label": t("systemUser") } });
  const choose = (index: number) => {
    const target = targets[index];
    if (!target || (target.account === account && target.user === user)) return;
    ({ account, user } = target);
    page = undefined;
    edit = undefined;
    paintPicker();
    paint();
    void browse(folders.get(key()));
  };
  function paintPicker() {
    const at = Math.max(0, targets.findIndex((target) => target.account === account && target.user === user));
    picker.style.setProperty("--n", String(targets.length));
    picker.style.setProperty("--i", String(at));
    for (const [index, seg] of [...picker.children].entries()) seg.setAttribute("aria-pressed", String(index === at));
  }
  const folder = button(t("newFolder"), () => {
    edit = { kind: "create" };
    draft = "";
    paint();
    body.querySelector("input")?.focus();
  });
  const addFiles = button(t("uploadFiles"), () => fileInput.click());
  const uploadLabel = h("span", { attrs: { role: "status" } });
  const uploadPosition = h("span", { class: "file-upload-count" });
  const progress = h("progress", { attrs: { "aria-label": t("uploadProgress") } });
  const uploadBytes = h("span", { attrs: { "aria-hidden": "true" } });
  const uploadMeter = h("div", { class: "file-upload-meter" }, progress, uploadBytes);
  const replaceFile = button(t("replaceFile"), () => void upload(true));
  const retryFile = button(t("retryUpload"), () => {
    const issue = batch?.issues[0];
    if (issue) void upload(issue.replace);
  });
  const skipFile = button(t("skipFile"), () => {
    if (!batch || batch.controller) return;
    const issue = batch.issues.shift();
    if (!issue) return;
    batch.skipped++;
    batch.totalBytes -= issue.item.file.size;
    void upload();
  });
  const cancelUpload = button(t("cancelUpload"), () => {
    if (!batch) return;
    if (batch.controller) {
      cancelUpload.disabled = true;
      batch.controller.abort();
    } else void finishUpload(batch, true);
  });
  const uploadBox = h("div", { class: "file-upload", attrs: { hidden: "" } },
    h("div", { class: "file-upload-heading" }, uploadLabel, uploadPosition), uploadMeter,
    h("div", { class: "file-upload-actions" }, replaceFile, retryFile, skipFile, cancelUpload));
  const dropHint = h("span", { class: "file-drop-hint", text: t("dropFiles"), attrs: { hidden: "" } });
  const home = tool("home", t("homeFolder"), () => void browse(page?.home));
  const up = tool("up", t("parentFolder"), () => {
    if (page) void browse(page.path.slice(0, page.path.lastIndexOf("/")) || "/");
  });
  const reload = tool("refresh", t("refreshFiles"), () => void browse(page?.path));
  const address = h("input", {
    attrs: { "aria-label": t("folderPath"), placeholder: t("folderPath"), autocomplete: "off", spellcheck: "false", autocapitalize: "none" },
  });
  const go = h("button", { class: "plain", text: t("goToFolder"), attrs: { type: "submit" } });
  const toggler = h("input", { attrs: { type: "checkbox" }, on: { change: () => {
    hidden = toggler.checked;
    void browse(page?.path);
  } } });
  const more = button(t("moreFiles"), () => {
    if (page?.next !== undefined) void browse(page.path, page.next);
  });
  const table = h("table", { class: "file-table" },
    h("thead", {}, h("tr", {},
      h("th", { text: t("fileName"), attrs: { scope: "col" } }),
      h("th", { class: "file-size", text: t("fileSize"), attrs: { scope: "col" } }),
      h("th", { class: "file-date", text: t("fileModified"), attrs: { scope: "col" } }),
      h("th", { attrs: { scope: "col", "aria-label": t("fileActions") } }),
    )), body);
  const element = h("section", {
    class: "workspace-panel file-panel", attrs: { "aria-label": t("files"), tabindex: "-1" },
    on: { keydown: (event) => {
      if ((event as KeyboardEvent).key !== "Escape") return;
      if (edit) { edit = undefined; paint(); }
      else actions.close();
    } },
  },
  h("div", { class: "workspace-head file-head" }, h("h2", { text: t("files") }), picker, folder, addFiles),
  h("form", { class: "file-address", on: {
    submit: (event) => {
      event.preventDefault();
      const target = address.value;
      if (!target.startsWith("/")) return message(t("absoluteFolderPath"), true);
      void browse(target);
    },
  } }, home, up, address, go, reload),
  h("div", { class: "file-options" }, dropHint, h("label", {}, toggler, h("span", { text: t("hiddenFiles") }))),
  status, uploadBox, table, more, fileInput);
  element.hidden = true;

  element.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    fileDrag++;
    paintDrop();
  });
  element.addEventListener("dragover", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes("Files")) return;
    event.preventDefault();
    transfer.dropEffect = canUpload() ? "copy" : "none";
  });
  element.addEventListener("dragleave", () => {
    fileDrag = Math.max(0, fileDrag - 1);
    paintDrop();
  });
  element.addEventListener("drop", (event) => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes("Files")) return;
    event.preventDefault();
    fileDrag = 0;
    paintDrop();
    if (!canUpload()) return;
    if ([...transfer.items].some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
      message(t("chooseIndividualFiles"), true);
      return;
    }
    startUpload([...transfer.files]);
  });

  function canUpload(): boolean {
    return !!page && !busy && !loading && !batch;
  }

  function paintDrop() {
    const active = fileDrag > 0 && canUpload();
    dropHint.hidden = !active;
    addFiles.classList.toggle("drop-target", active);
  }

  function message(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle("file-error", error);
  }

  function report(error: unknown) {
    const status = (error as { status?: number } | undefined)?.status;
    if (status === 401) return actions.unauthorized();
    message(error instanceof Error ? error.message : t("fileOperationFailed"), true);
  }

  function url(route: string, owner: string, as: string, directory?: string, extras?: Record<string, string>) {
    return `files${route}?${new URLSearchParams({ account: owner, ...(as && { user: as }), ...(directory && { path: directory }), ...extras })}`;
  }

  async function browse(directory?: string, offset = 0) {
    loading?.abort();
    const pending = new AbortController();
    loading = pending;
    const owner = account;
    const as = user;
    edit = undefined;
    message(t("loadingFiles"));
    paint();
    try {
      const next = await actions.request<FilePage>(url("", owner, as, directory, { offset: String(offset), hidden: hidden ? "1" : "0" }), { signal: pending.signal });
      if (loading !== pending || disposed) return;
      if (offset && page) {
        const entries = new Map(page.entries.map((entry) => [entry.name, entry]));
        for (const entry of next.entries) entries.set(entry.name, entry);
        next.entries = [...entries.values()];
      }
      page = next;
      folders.set(key(owner, as), next.path);
      address.value = next.path;
      message("");
      return true;
    } catch (error) {
      if (!pending.signal.aborted && !disposed) report(error);
    } finally {
      if (loading === pending) {
        loading = undefined;
        if (!disposed) paint();
      }
    }
  }

  async function change(route: string, method: string, fields: Record<string, string>) {
    if (!page || busy || batch || loading) return;
    const directory = page.path;
    busy = true;
    paint();
    try {
      await actions.request(route, { method, body: { account, ...(user && { user }), path: directory, ...fields } });
      edit = undefined;
      if (!disposed) await browse(directory);
    } catch (error) {
      if (!disposed) report(error);
    } finally {
      busy = false;
      if (!disposed) paint();
    }
  }

  function startUpload(files: File[]) {
    if (!canUpload() || !files.length || !page) return;
    batch = {
      files: files.map((file) => ({ file, sent: 0 })),
      account, user, path: page.path, next: 0, uploaded: 0, skipped: 0, sent: 0,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      active: new Map(), issues: [],
    };
    paint();
    void upload();
  }

  function paintProgress(transfer: Upload) {
    const active = transfer.active.size;
    const item = transfer.active.values().next().value?.item;
    const text = active === 1 && item
      ? t(item.sent < item.file.size ? "uploadingFile" : "finishingUpload", { name: item.file.name })
      : t("uploadingFiles", { count: active });
    if (uploadLabel.textContent !== text) uploadLabel.textContent = text;
    progress.max = transfer.totalBytes || 1;
    progress.value = transfer.totalBytes ? transfer.sent : 0;
    uploadBytes.textContent = t("uploadBytes", { sent: formatSize(transfer.sent), total: formatSize(transfer.totalBytes) });
  }

  function paintUpload(transfer: Upload) {
    const issue = transfer.controller ? undefined : transfer.issues[0];
    uploadBox.hidden = false;
    uploadPosition.textContent = t("uploadCompleted", { done: transfer.uploaded + transfer.skipped, total: transfer.files.length });
    uploadMeter.hidden = !!issue;
    replaceFile.hidden = !issue || issue.error !== undefined;
    retryFile.hidden = !issue || issue.error === undefined;
    skipFile.hidden = !issue;
    cancelUpload.disabled = transfer.controller?.signal.aborted ?? false;
    if (!issue) paintProgress(transfer);
    else uploadLabel.textContent = t(issue.error === undefined ? "replaceFileWarning" : "uploadFileFailed", { name: issue.item.file.name });
  }

  async function finishUpload(transfer: Upload, cancelled: boolean) {
    if (disposed) return;
    batch = undefined;
    uploadBox.hidden = true;
    const refreshed = await browse(transfer.path);
    if (refreshed) message(cancelled ? t("uploadCancelled") : t("uploadDone", {
      done: transfer.uploaded, total: transfer.files.length,
    }));
  }

  function startFile(transfer: Upload, item: UploadFile, replace: boolean, controller: AbortController, retry = false) {
    const { file } = item;
    const { signal } = controller;
    const route = url("/upload", transfer.account, transfer.user, transfer.path, {
      name: file.name, size: String(file.size), ...(replace && { replace: "1" }),
    });
    const done = (async () => {
      try {
        if (!replace && file.size >= checkUploadSize) {
          const check = await fetch(`/api/${route}`, { cache: "no-store", signal }).catch(() => undefined);
          if (check?.status === 409 || check?.status === 401) throw { status: check.status };
        }
        await sendFile(route, file, signal, (bytes) => {
          if (signal.aborted) return;
          const sent = Math.min(bytes, file.size);
          transfer.sent += sent - item.sent;
          item.sent = sent;
          paintProgress(transfer);
        });
        transfer.sent += file.size - item.sent;
        item.sent = file.size;
        transfer.uploaded++;
      } catch (error) {
        if (signal.aborted) return;
        const status = (error as { status?: number } | undefined)?.status;
        if (status === 401) {
          controller.abort();
          actions.unauthorized();
          return;
        }
        transfer.sent -= item.sent;
        item.sent = 0;
        const issue: UploadIssue = status === 409 && !replace
          ? { item, replace }
          : { item, replace, error: error ?? new Error(t("uploadFailed")) };
        if (retry) transfer.issues.unshift(issue);
        else transfer.issues.push(issue);
      } finally {
        transfer.active.delete(file.name);
      }
    })();
    transfer.active.set(file.name, { item, done });
    if (!disposed) paintUpload(transfer);
    return done;
  }

  async function upload(replace?: boolean) {
    const transfer = batch;
    if (!transfer || transfer.controller) return;
    const controller = new AbortController();
    transfer.controller = controller;
    message("");
    if (replace !== undefined) {
      const issue = transfer.issues.shift();
      if (issue) await startFile(transfer, issue.item, replace, controller, true);
    }
    async function runQueue() {
      while (!controller.signal.aborted && !transfer.issues.length && transfer.next < transfer.files.length) {
        const item = transfer.files[transfer.next]!;
        const previous = transfer.active.get(item.file.name);
        if (previous) await previous.done;
        else {
          transfer.next++;
          await startFile(transfer, item, false, controller);
          if (!disposed && transfer.active.size) paintUpload(transfer);
        }
      }
    }
    await Promise.all(Array.from({ length: uploadConcurrency }, runQueue));
    transfer.controller = undefined;
    if (disposed) return;
    if (controller.signal.aborted || !transfer.issues.length) {
      await finishUpload(transfer, controller.signal.aborted);
      return;
    }
    paintUpload(transfer);
    const issue = transfer.issues[0]!;
    if (issue.error !== undefined) report(issue.error);
  }

  function form(action: Edit) {
    const deleting = action.kind === "delete";
    const input = h("input", { attrs: {
      "aria-label": t("fileName"), placeholder: t("fileName"), maxlength: "255", required: "", autocomplete: "off", spellcheck: "false",
    }, on: { input: (event) => { draft = (event.currentTarget as HTMLInputElement).value; } } });
    input.value = draft;
    const submit = () => {
      if (action.kind === "delete") return void change("files/item", "DELETE", { name: action.entry.name });
      if (!input.value || input.value.includes("/") || input.value === "." || input.value === "..") return message(t("invalidFileName"), true);
      if (action.kind === "create") void change("files/folders", "POST", { name: input.value });
      else void change("files/item", "PATCH", { name: action.entry.name, to: input.value });
    };
    const cancel = button(t("cancelSession"), () => { edit = undefined; paint(); });
    const label = deleting ? t("deleteFile") : action.kind === "create" ? t("newFolder") : t("saveSession");
    const actionButton = h("button", { class: deleting ? "plain file-danger" : "primary", text: label, attrs: { type: deleting ? "button" : "submit" } });
    if (deleting) actionButton.addEventListener("click", submit);
    return h("tr", {},
      h("td", { attrs: { colspan: "4" } },
        h("form", { class: "file-edit", on: { submit: (event) => { event.preventDefault(); if (!deleting) submit(); } } },
          deleting ? h("span", { text: t(action.entry.kind === "directory" && !action.entry.link ? "deleteFolderWarning" : "deleteFileWarning", { name: action.entry.name }) }) : input,
          actionButton, cancel)));
  }

  function row(entry: FileEntry) {
    if (edit && edit.kind !== "create" && edit.entry.name === entry.name) return form(edit);
    const directory = entry.kind === "directory";
    const filename = h("span", { text: entry.name });
    const symbol = icon(directory ? "folder" : entry.link ? "link" : "file");
    const props = { class: "file-entry", attrs: { title: entry.name } };
    const open = directory
      ? h("button", { ...props, attrs: { ...props.attrs, type: "button" }, on: {
        click: () => { if (!busy && !batch && !loading && page) void browse(`${page.path === "/" ? "" : page.path}/${entry.name}`); },
      } }, symbol, filename)
      : entry.kind === "file"
        ? h("a", { ...props, attrs: { ...props.attrs, download: entry.name, href: `/api/${url("/download", account, user, page?.path, { name: entry.name })}` } }, symbol, filename)
        : h("span", props, symbol, filename);
    const rename = tool("edit", t("renameFile", { name: entry.name }), () => {
      edit = { kind: "rename", entry };
      draft = entry.name;
      paint();
      const input = body.querySelector("input");
      input?.focus();
      input?.select();
    });
    const remove = tool("trash", t("deleteFileFor", { name: entry.name }), () => {
      edit = { kind: "delete", entry };
      paint();
    });
    return h("tr", {},
      h("td", {}, open),
      h("td", { class: "file-size", text: entry.kind === "file" ? formatSize(entry.size) : "" }),
      h("td", { class: "file-date", text: date.format(entry.modified) }),
      h("td", { class: "file-row-tools" }, rename, remove));
  }

  function paint() {
    const disabled = busy || !!loading || !!batch;
    const rows = page?.entries.map(row) ?? [];
    if (edit?.kind === "create") rows.unshift(form(edit));
    body.replaceChildren(...rows);
    table.hidden = !rows.length;
    for (const seg of picker.children) (seg as HTMLButtonElement).disabled = disabled;
    address.disabled = go.disabled = toggler.disabled = disabled;
    folder.disabled = addFiles.disabled = disabled || !page;
    paintDrop();
    home.disabled = reload.disabled = disabled;
    up.disabled = disabled || !page || page.path === "/";
    more.hidden = page?.next === undefined;
    more.disabled = disabled;
    for (const control of body.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")) control.disabled = disabled;
    if (!rows.length && page && !loading && !batch && !status.textContent) message(t("emptyFolder"));
  }

  return {
    element,
    show(accounts: readonly string[], preferred?: string, users: Record<string, string[]> = {}, preferredUser?: string) {
      fileDrag = 0;
      targets = accounts.flatMap((name) => {
        const own = users[name] ?? [];
        return own.length > 1 ? own.map((as) => ({ account: name, user: as })) : [{ account: name, user: "" }];
      });
      const wanted = preferred && accounts.includes(preferred) ? preferred : undefined;
      const same = (target: Target, owner: string, as: string) => target.account === owner && target.user === as;
      const kept = targets.findIndex((target) => same(target, account, user));
      const owner = wanted ?? account;
      const exact = targets.findIndex((target) => same(target, owner, preferredUser ?? ""));
      const at = batch ? targets.findIndex((target) => same(target, batch!.account, batch!.user))
        : kept >= 0 && (!wanted || account === wanted) ? kept
        : exact >= 0 ? exact
        : Math.max(0, targets.findIndex((target) => target.account === owner));
      ({ account, user } = targets[at] ?? { account: "", user: "" });
      picker.replaceChildren(...targets.map((target, index) => h("button", {
        class: "seg",
        text: target.user ? accounts.length > 1 ? `${target.account} · ${target.user}` : target.user : target.account,
        attrs: { type: "button" },
        on: { click: () => choose(index) },
      })));
      picker.hidden = targets.length < 2;
      paintPicker();
      edit = undefined;
      element.hidden = false;
      element.focus({ preventScroll: true });
      if (batch || busy) paint();
      else {
        page = undefined;
        void browse(folders.get(key()));
      }
    },
    /** Shows the panel again as it was left. */
    reveal() {
      fileDrag = 0;
      paintDrop();
      element.hidden = false;
      element.focus({ preventScroll: true });
    },
    dispose() {
      disposed = true;
      loading?.abort();
      batch?.controller?.abort();
    },
  };
}
