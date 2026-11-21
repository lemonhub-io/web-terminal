// A workspace owns a group of terminals. Login tokens keep their original
// identity, while each browser tab can explicitly choose a workspace per account.
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
  /** The login whose default workspace this is, including after deletion. */
  home?: string;
}

const publicInfo = ({ id, account, name, created }: Workspace): WorkspaceInfo => ({ id, account, name, created });
const nextId = () => randomBytes(12).toString("base64url");

export class Workspaces {
  private readonly file: string;
  private rows: Workspace[] = [];
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(secretsDir: string) {
    this.file = path.join(secretsDir, "workspaces.json");
    try {
      this.rows = JSON.parse(fs.readFileSync(this.file, "utf8")) as Workspace[];
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

  defaults(session: Session) {
    const rows = [...this.rows];
    const defaults = session.accounts.map(({ username, loginId }) => {
      let row = rows.find((item) => item.account === username && item.home === loginId);
      if (!row) {
        // Reuse the login's existing owner key so terminals survive this upgrade.
        row = { id: loginId, account: username, name: "", created: Date.now(), home: loginId };
        rows.push(row);
      }
      return { account: username, loginId, id: row.id };
    });
    if (rows.length !== this.rows.length) this.save(rows);
    return defaults;
  }

  list(session: Session): WorkspaceInfo[] {
    this.defaults(session);
    return this.rows.filter((row) => session.accounts.some((account) => account.username === row.account)).map(publicInfo);
  }

  find(session: Session, id: string): WorkspaceInfo {
    return publicInfo(this.require(session, id));
  }

  private require(session: Session, id: string): Workspace {
    const row = this.rows.find((row) => row.id === id && session.accounts.some((account) => account.username === row.account));
    if (!row) throw new HttpError(404, "Session not found");
    return row;
  }

  select(session: Session, ids: readonly string[]): SessionIdentity[] {
    if (ids.length > session.accounts.length) throw new HttpError(400, "Choose one session per account");
    const picked = new Map<string, string>();
    for (const id of ids) {
      const row = this.require(session, id);
      if (picked.has(row.account)) throw new HttpError(400, "Choose one session per account");
      picked.set(row.account, row.id);
    }
    const defaults = this.defaults(session);
    return session.accounts.map((account, i) => ({
      ...account,
      loginId: picked.get(account.username) ?? defaults[i]!.id,
    }));
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
    const previous = this.pending.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => action(this.find(session, id)));
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(id) === task) this.pending.delete(id);
    }
  }

  remove(session: Session, id: string) {
    const current = this.require(session, id);
    const rows = this.rows.filter((row) => row !== current);
    if (current.home) {
      rows.push({ id: nextId(), account: current.account, name: "", created: Date.now(), home: current.home });
    }
    this.save(rows);
  }
}
