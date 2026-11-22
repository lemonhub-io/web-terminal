// A workspace groups an account's terminals. Every sign-in to an account sees the
// same workspaces and shells; separate terminals come from separate accounts.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Session, SessionIdentity } from "./auth.ts";
import { HttpError } from "./http-error.ts";

export interface WorkspaceInfo {
  id: string;
  account: string;
  name: string;
  created: number;
}

interface Workspace extends WorkspaceInfo {
  /** The account's default workspace. Its shells are owned by the bare account name,
      the key every shell had before workspaces, so those shells show here too. */
  default?: true;
  /** Ids of the per-login defaults folded into this one: their shells, and tabs that
      still name them, belong here. */
  merged?: string[];
  /** Rows saved while each login had its own default; folded in on load. */
  home?: string;
}

/** One account as a request reaches it: the workspace in use and its host owner keys. */
export interface Scope extends SessionIdentity {
  workspace: string;
  /** The owner key new shells get. */
  owner: string;
  /** Every owner key whose shells show in this workspace. */
  owners: string[];
}

const publicInfo = ({ id, account, name, created }: Workspace): WorkspaceInfo => ({ id, account, name, created });
const nextId = () => randomBytes(12).toString("base64url");
const keyOf = (id: string, account: string) => `login:${id}:${account}`;
const ownerOf = (row: Workspace) => row.default ? row.account : keyOf(row.id, row.account);
const ownersOf = (row: Workspace) =>
  row.default ? [row.account, ...(row.merged ?? []).map((id) => keyOf(id, row.account))] : [keyOf(row.id, row.account)];

/** Folds the per-login defaults of each account into one shared default. */
function fold(rows: Workspace[]): Workspace[] {
  const homes = rows.filter((row) => row.home);
  if (!homes.length) return rows;
  const next = rows.filter((row) => !row.home);
  for (const account of new Set(homes.map((row) => row.account))) {
    const mine = homes.filter((row) => row.account === account);
    const ids = mine.map((row) => row.id);
    const at = next.findIndex((row) => row.default && row.account === account);
    if (at >= 0) next[at] = { ...next[at]!, merged: [...(next[at]!.merged ?? []), ...ids] };
    else next.unshift({ id: nextId(), account, name: "", created: Math.min(...mine.map((row) => row.created)), default: true, merged: ids });
  }
  return next;
}

export class Workspaces {
  private readonly file: string;
  private rows: Workspace[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(secretsDir: string) {
    this.file = path.join(secretsDir, "workspaces.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as Workspace[];
      const folded = fold(saved);
      if (folded === saved) this.rows = saved;
      else this.save(folded);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save(rows: Workspace[]) {
    const temporary = this.file + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.rows = rows;
  }

  /** The default workspace of each signed-in account, made on first use. */
  private ensureDefaults(session: Session): Workspace[] {
    const rows = [...this.rows];
    const defaults = session.accounts.map(({ username }) => {
      let row = rows.find((item) => item.default && item.account === username);
      if (!row) {
        row = { id: nextId(), account: username, name: "", created: Date.now(), default: true };
        rows.push(row);
      }
      return row;
    });
    if (rows.length !== this.rows.length) this.save(rows);
    return defaults;
  }

  defaults(session: Session) {
    const rows = this.ensureDefaults(session);
    return session.accounts.map(({ username, loginId }, i) => ({ account: username, loginId, id: rows[i]!.id }));
  }

  list(session: Session): WorkspaceInfo[] {
    this.ensureDefaults(session);
    return this.rows.filter((row) => session.accounts.some((account) => account.username === row.account)).map(publicInfo);
  }

  find(session: Session, id: string): WorkspaceInfo {
    return publicInfo(this.require(session, id));
  }

  /** The owner keys of every shell in a workspace. */
  owners(session: Session, id: string): string[] {
    return ownersOf(this.require(session, id));
  }

  private require(session: Session, id: string): Workspace {
    const row = this.rows.find((row) => (row.id === id || row.merged?.includes(id)) &&
      session.accounts.some((account) => account.username === row.account));
    if (!row) throw new HttpError(404, "Session not found");
    return row;
  }

  select(session: Session, ids: readonly string[]): Scope[] {
    if (ids.length > session.accounts.length) throw new HttpError(400, "Choose one session per account");
    const picked = new Map<string, Workspace>();
    for (const id of ids) {
      const row = this.require(session, id);
      if (picked.has(row.account)) throw new HttpError(400, "Choose one session per account");
      picked.set(row.account, row);
    }
    const defaults = this.ensureDefaults(session);
    return session.accounts.map((account, i) => {
      const row = picked.get(account.username) ?? defaults[i]!;
      return { ...account, workspace: row.id, owner: ownerOf(row), owners: ownersOf(row) };
    });
  }

  create(session: Session, account: string, name: string): WorkspaceInfo {
    if (!session.accounts.some((entry) => entry.username === account)) throw new HttpError(403, "Sign in to that account first");
    const row = { id: nextId(), account, name, created: Date.now() };
    this.save([...this.rows, row]);
    return publicInfo(row);
  }

  rename(session: Session, id: string, name: string): WorkspaceInfo {
    const current = this.require(session, id);
    const row = { ...current, name };
    this.save(this.rows.map((item) => item === current ? row : item));
    return publicInfo(row);
  }

  /** Serializes creating terminals and deleting their workspace in this web service. */
  async run<T>(session: Session, id: string, action: (workspace: WorkspaceInfo) => T | Promise<T>): Promise<T> {
    const key = this.require(session, id).id;
    const previous = this.pending.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => action(this.find(session, key)));
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }

  /** Forgets a workspace once its shells are gone. The default one stays, empty. */
  remove(session: Session, id: string) {
    const current = this.require(session, id);
    if (current.default) return;
    this.save(this.rows.filter((row) => row !== current));
  }
}
