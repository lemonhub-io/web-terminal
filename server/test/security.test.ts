import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { clientAddress, createTermApp, sameOrigin } from "../app.ts";
import { Assets } from "../assets.ts";
import { Auth, Throttle } from "../auth.ts";
import { Terminals } from "../terminal.ts";
import { Workspaces } from "../workspaces.ts";

const request = (remoteAddress: string, forwarded?: string) =>
  ({
    socket: { remoteAddress },
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
  }) as unknown as IncomingMessage;

test("sameOrigin accepts only this host over https or local http", () => {
  assert.equal(sameOrigin("https://term.example.com", "term.example.com"), true);
  assert.equal(sameOrigin("https://evil.example.com", "term.example.com"), false);
  assert.equal(sameOrigin("http://term.example.com", "term.example.com"), false);
  assert.equal(sameOrigin("http://localhost:3120", "localhost:3120"), true);
  assert.equal(sameOrigin(undefined, "term.example.com"), false);
  assert.equal(sameOrigin("https://term.example.com", undefined), false);
});

test("clientAddress ignores X-Forwarded-For from remote peers", () => {
  assert.equal(clientAddress(request("203.0.113.7", "10.0.0.1")), "203.0.113.7");
});

test("clientAddress takes the last X-Forwarded-For hop behind a loopback proxy", () => {
  assert.equal(clientAddress(request("127.0.0.1", "198.51.100.9, 192.0.2.44")), "192.0.2.44");
  assert.equal(clientAddress(request("127.0.0.1")), "127.0.0.1");
});

test("Throttle locks out after repeated failures and clears on success", () => {
  const throttle = new Throttle();
  for (let i = 0; i < 5; i++) throttle.fail("client", 0);
  assert.ok(throttle.wait("client", 1) > 0);
  throttle.succeed("client");
  assert.equal(throttle.wait("client", 1), 0);
});

test("Auth keeps one token per account and drops only the one whose password changed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-auth-"));
  try {
    const auth = new Auth(dir);
    await auth.setAccount("lemon", "pass1", "lemon");
    await auth.setAccount("nia", "pass2", "nia");
    const tLemon = await auth.login("lemon", "pass1");
    const tNia = await auth.login("nia", "pass2");
    assert.ok(tLemon && tNia);
    assert.equal(await auth.login("nia", "pass1"), null);
    const both = auth.verify(Auth.join([tLemon, tNia]));
    assert.deepEqual(both?.accounts.map(({ username, systemUser }) => ({ username, systemUser })), auth.listAccounts());
    assert.equal(both?.changed, false);

    // Changing nia's password signs out nia only.
    await auth.setAccount("nia", "pass3");
    const left = auth.verify(Auth.join([tLemon, tNia]));
    assert.deepEqual(left?.accounts, both?.accounts.slice(0, 1));
    assert.deepEqual(left?.tokens, [tLemon]);
    assert.equal(left?.changed, true);
    assert.equal(auth.verify(tNia), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Every sign-in to an account shares its shells; other accounts stay apart", async () => {
  process.env.SHELL = "/bin/sh";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-app-"));
  const terminals = new Terminals(8);
  try {
    const auth = new Auth(dir);
    await auth.setAccount("a", "pa");
    await auth.setAccount("b", "pb");
    // A shell from before workspaces, and one from a per-login default saved by an earlier version.
    const legacy = terminals.create({ cols: 80, rows: 24 }, "b");
    const perLogin = terminals.create({ cols: 80, rows: 24 }, "login:oldhomeoldhomeold:b");
    fs.writeFileSync(path.join(dir, "workspaces.json"),
      JSON.stringify([{ id: "oldhomeoldhomeold", account: "b", name: "", created: 1, home: "oldhomeoldhomeold" }]));
    const workspaces = new Workspaces(dir);
    const app = createTermApp({ auth, throttle: new Throttle(), terminals, assets: new Assets(dir), workspaces });
    const browser = () => {
      let cookie = "";
      const call = async (method: string, route: string, body?: unknown) => {
        const res = await app.request(
          `http://localhost/api/${route}`,
          {
            method,
            headers: { "Content-Type": "application/json", Origin: "http://localhost", Host: "localhost", Cookie: cookie },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
          { incoming: request("127.0.0.1"), outgoing: {} as never },
        );
        const set = res.headers.get("set-cookie");
        if (set) cookie = set.split(";")[0]!;
        return { status: res.status, data: (await res.json()) as any };
      };
      return { call, cookie: () => Auth.read(cookie) };
    };
    const ids = (list: { id: string }[]) => list.map((info) => info.id).sort();
    const first = browser();
    const other = browser();
    const { call } = first;

    assert.deepEqual((await call("POST", "session", { username: "a", password: "pa" })).data.accounts, ["a"]);
    assert.equal((await call("POST", "terminals", { account: "b" })).status, 403);
    assert.equal((await call("POST", "session", { username: "b", password: "wrong" })).status, 401);
    assert.deepEqual((await call("POST", "session", { username: "b", password: "pb" })).data.accounts, ["a", "b"]);
    const made = (await call("POST", "terminals", { account: "b", cols: 80, rows: 24 })).data;
    assert.equal(made.account, "b");
    const mine = (await call("POST", "terminals", { account: "a", cols: 80, rows: 24 })).data;
    assert.deepEqual(ids((await call("GET", "terminals")).data), ids([made, mine, legacy, perLogin]));

    // Another browser signed in to b alone sees all of b's shells and none of a's.
    assert.equal((await other.call("POST", "session", { username: "b", password: "pb" })).status, 200);
    const shared = (await other.call("GET", "terminals")).data;
    assert.deepEqual(ids(shared), ids([made, legacy, perLogin]));
    assert.ok(shared.every((info: { account: string; workspace: string }) => info.account === "b" && info.workspace === made.workspace));
    assert.equal((await other.call("PATCH", `terminals/${made.id}`, { name: "Shared" })).data.name, "Shared");
    assert.equal((await other.call("PATCH", `terminals/${mine.id}`, { name: "Other" })).status, 404);
    assert.equal((await other.call("DELETE", `terminals/${mine.id}`)).status, 404);
    let closeCode: number | undefined;
    const socket = { close: (code: number) => { closeCode = code; } };
    const otherOwners = workspaces.select(auth.verify(other.cookie())!, []).flatMap((scope) => scope.owners);
    terminals.attach(mine.id, socket as WebSocket, otherOwners);
    assert.equal(closeCode, 4004);
    // A tab that still names the folded per-login default lands in the shared one.
    assert.deepEqual(ids((await other.call("GET", "terminals?workspace=oldhomeoldhomeold")).data), ids(shared));

    const created = await other.call("POST", "workspaces", { account: "b", name: "Review" });
    assert.equal(created.status, 201);
    const workspace = created.data;
    assert.equal((await call("PATCH", `workspaces/${workspace.id}`, { name: "Release" })).data.name, "Release");
    assert.equal(new Workspaces(dir).find(auth.verify(other.cookie())!, workspace.id).name, "Release");
    const inNew = (await other.call("POST", `terminals?workspace=${workspace.id}`, { account: "b" })).data;
    assert.equal(inNew.workspace, workspace.id);
    assert.deepEqual(ids((await call("GET", `terminals?workspace=${workspace.id}`)).data), ids([inNew, mine]));
    assert.deepEqual(ids((await call("GET", "terminals")).data), ids([made, mine, legacy, perLogin]));

    // Signing out of b keeps a and hides b's shells from this browser without ending them.
    assert.deepEqual((await call("DELETE", "session/b")).data.accounts, ["a"]);
    assert.deepEqual(ids((await call("GET", "terminals")).data), [mine.id]);
    assert.equal((await call("GET", `terminals?workspace=${workspace.id}`)).status, 404);
    assert.equal((await call("DELETE", `workspaces/${workspace.id}`)).status, 404);
    assert.equal((await other.call("DELETE", `workspaces/${workspace.id}`)).status, 200);
    assert.equal((await other.call("GET", `terminals?workspace=${workspace.id}`)).status, 404);
    assert.equal(terminals.list([`login:${workspace.id}:b`]).length, 0);

    // Clearing the default ends its shells and keeps the workspace.
    const cleared = await other.call("DELETE", `workspaces/${made.workspace}`);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.logins[0].id, made.workspace);
    assert.deepEqual((await other.call("GET", "terminals")).data, []);
    assert.equal(terminals.list(["a"]).length, 1);
  } finally {
    terminals.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Terminals isolates sessions per owner", () => {
  process.env.SHELL = "/bin/sh";
  const terminals = new Terminals(1);
  try {
    const a = terminals.create({ cols: 80, rows: 24 }, "lemon");
    const b = terminals.create({ cols: 80, rows: 24 }, "nia");
    assert.equal(terminals.list(["lemon"]).length, 1);
    assert.equal(terminals.list(["lemon", "nia"]).length, 2);
    assert.throws(() => terminals.rename(b.id, "hijack", ["lemon"]), /Terminal not found/);
    assert.throws(() => terminals.kill(a.id, ["nia"]), /Terminal not found/);
  } finally {
    terminals.close();
  }
});
