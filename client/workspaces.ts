import { h, icon } from "./dom.ts";
import { language, t } from "./i18n.ts";

export interface WorkspaceInfo {
  id: string;
  account: string;
  name: string;
  created: number;
}

export interface LoginWorkspace {
  account: string;
  loginId: string;
  id: string;
}

interface Actions {
  list(): Promise<WorkspaceInfo[]>;
  current(account: string): string | undefined;
  open(workspace: WorkspaceInfo): Promise<void>;
  create(account: string, name: string): Promise<WorkspaceInfo>;
  rename(id: string, name: string): Promise<WorkspaceInfo>;
  remove(id: string): Promise<WorkspaceInfo[]>;
  close(): void;
}

const date = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });

export function workspaceName(workspace: WorkspaceInfo) {
  return workspace.name || t("sessionDate", { date: date.format(workspace.created) });
}

export function buildWorkspacePanel(actions: Actions) {
  let rows: WorkspaceInfo[] = [];
  let account = "";
  let editing: string | null = null;
  let draft = "";
  let confirming = "";
  let busy = false;
  const status = h("p", { class: "workspace-status", attrs: { role: "status" } });
  const list = h("div", { class: "workspace-list" });
  const button = (text: string, click: () => void, style = "plain") => h("button", {
    class: style, text, attrs: { type: "button" }, on: { click },
  });
  const accountSelect = h("select", {
    attrs: { "aria-label": t("username") },
    on: { change: () => {
      account = accountSelect.value;
      editing = null;
      confirming = "";
      paint();
    } },
  });
  const add = button(t("newSession"), () => {
    editing = "";
    draft = "";
    confirming = "";
    paint();
    list.querySelector("input")?.focus();
  });
  const done = button(t("done"), actions.close);
  const element = h("section", {
    class: "workspace-panel", attrs: { "aria-label": t("sessions"), tabindex: "-1" },
    on: { keydown: (event) => {
      if ((event as KeyboardEvent).key === "Escape") actions.close();
    } },
  },
  h("div", { class: "workspace-head" }, h("h2", { text: t("sessions") }), accountSelect, add, done),
  status, list);
  element.hidden = true;

  async function run(operation: () => Promise<void>) {
    if (busy) return;
    busy = true;
    status.textContent = "";
    paint();
    try {
      await operation();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : t("sessionsUnavailable");
    } finally {
      busy = false;
      paint();
    }
  }

  function editor(workspace?: WorkspaceInfo) {
    const input = h("input", {
      attrs: { "aria-label": t("sessionName"), placeholder: t("sessionName"), maxlength: "60", required: "" },
      on: { input: (event) => { draft = (event.currentTarget as HTMLInputElement).value; } },
    });
    input.value = draft;
    const submit = h("button", { class: "primary", text: t(workspace ? "saveSession" : "newSession"), attrs: { type: "submit" } });
    return h("form", { class: "workspace-row workspace-edit", on: {
      submit: (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return input.focus();
        const owner = account;
        void run(async () => {
          if (workspace) {
            const updated = await actions.rename(workspace.id, name);
            rows = rows.map((row) => row.id === updated.id ? updated : row);
          } else {
            const created = await actions.create(owner, name);
            rows.push(created);
            await actions.open(created);
          }
          editing = null;
        });
      },
    } }, input, submit, button(t("cancelSession"), () => {
      editing = null;
      paint();
    }));
  }

  function row(workspace: WorkspaceInfo) {
    if (editing === workspace.id) return editor(workspace);
    const name = workspaceName(workspace);
    if (confirming === workspace.id) {
      return h("div", { class: "workspace-row workspace-confirm" },
        h("span", { text: t("deleteSessionWarning", { name }) }),
        button(t("deleteSession"), () => void run(async () => {
          rows = await actions.remove(workspace.id);
          confirming = "";
        })),
        button(t("cancelSession"), () => { confirming = ""; paint(); }));
    }
    const active = actions.current(workspace.account) === workspace.id;
    const open = h("button", {
      class: "workspace-open", text: name,
      attrs: { type: "button", title: name, ...(active && { "aria-current": "true" }) },
      on: { click: () => void run(() => actions.open(workspace)) },
    });
    const edit = h("button", {
      class: "tool", attrs: { type: "button", title: t("renameSession"), "aria-label": t("renameSessionFor", { name }) },
      on: { click: () => {
        editing = workspace.id;
        draft = workspace.name;
        confirming = "";
        paint();
        list.querySelector("input")?.focus();
      } },
    }, icon("edit"));
    const remove = h("button", {
      class: "tool", attrs: { type: "button", title: t("deleteSession"), "aria-label": t("deleteSessionFor", { name }) },
      on: { click: () => { confirming = workspace.id; editing = null; paint(); } },
    }, icon("trash"));
    return h("div", { class: `workspace-row${active ? " active" : ""}` }, open,
      ...(active ? [h("span", { class: "workspace-current", text: t("currentSession") })] : []), edit, remove);
  }

  function paint() {
    if (element.hidden) return;
    const children = rows.filter((workspace) => workspace.account === account).map(row);
    if (editing === "") children.unshift(editor());
    list.replaceChildren(...children);
    for (const control of list.querySelectorAll("button, input")) control.disabled = busy;
    add.disabled = accountSelect.disabled = busy;
  }

  return {
    element,
    show(accounts: readonly string[], preferred?: string) {
      account = preferred && accounts.includes(preferred) ? preferred : accounts[0] ?? "";
      accountSelect.replaceChildren(...accounts.map((name) => h("option", { text: name, attrs: { value: name } })));
      accountSelect.value = account;
      accountSelect.hidden = accounts.length < 2;
      editing = null;
      confirming = "";
      element.hidden = false;
      element.focus({ preventScroll: true });
      void run(async () => { rows = await actions.list(); });
    },
  };
}
