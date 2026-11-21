import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { clientAddress, createTermApp, sameOrigin } from "../app.ts";
import { Assets } from "../assets.ts";
import { Auth, terminalOwners, Throttle } from "../auth.ts";
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

test("Each login has its own shells, including when two browsers sign in as the same account", async () => {
  process.env.SHELL = "/bin/sh";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-app-"));
  const terminals = new Terminals(2);
  try {
    const auth = new Auth(dir);
    await auth.setAccount("a", "pa");
    await auth.setAccount("b", "pb");
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
    const first = browser();
    const other = browser();
    const { call } = first;

    assert.deepEqual((await call("POST", "session", { username: "a", password: "pa" })).data.accounts, ["a"]);
    assert.equal((await call("POST", "terminals", { account: "b" })).status, 403);
    assert.equal((await call("POST", "session", { username: "b", password: "wrong" })).status, 401);
    assert.deepEqual((await call("POST", "session", { username: "b", password: "pb" })).data.accounts, ["a", "b"]);
    const made = (await call("POST", "terminals", { account: "b", cols: 80, rows: 24 })).data;
    assert.equal(made.account, "b");
    assert.deepEqual((await call("GET", "terminals")).data.map((info: { id: string }) => info.id), [made.id]);

    assert.equal((await other.call("POST", "session", { username: "b", password: "pb" })).status, 200);
    assert.deepEqual((await other.call("GET", "terminals")).data, []);
    assert.equal((await other.call("PATCH", `terminals/${made.id}`, { name: "Other" })).status, 404);
    assert.equal((await other.call("DELETE", `terminals/${made.id}`)).status, 404);
    let closeCode: number | undefined;
    const socket = { close: (code: number) => { closeCode = code; } };
    terminals.attach(made.id, socket as WebSocket, terminalOwners(auth.verify(other.cookie())!));
    assert.equal(closeCode, 4004);
    const renamed = await call("PATCH", `terminals/${made.id}`, { name: "Mine" });
    assert.equal(renamed.data.name, "Mine");
    assert.equal(renamed.data.account, "b");

    const session = auth.verify(first.cookie())!;
    const renewed = auth.verify(first.cookie(), Date.now() + 31 * 86400_000)!;
    assert.equal(renewed.changed, true);
    assert.deepEqual(terminalOwners(renewed), terminalOwners(session));
    assert.equal((await call("POST", "session", { username: "b", password: "pb" })).status, 200);
    assert.deepEqual(terminalOwners(auth.verify(first.cookie())!), terminalOwners(session));

    const listed = (await other.call("GET", "workspaces")).data.workspaces;
    assert.equal(listed.length, 2);
    assert.ok(listed.some((entry: { id: string }) => entry.id === made.workspace));
    const scoped = `?workspace=${made.workspace}`;
    assert.deepEqual((await other.call("GET", `terminals${scoped}`)).data.map((info: { id: string }) => info.id), [made.id]);
    assert.deepEqual((await other.call("GET", "terminals")).data, []);
    const allowed = workspaces.select(auth.verify(other.cookie())!, [made.workspace]);
    assert.deepEqual(terminalOwners({ ...session, accounts: allowed }), terminalOwners(session).slice(1));

    const created = await other.call("POST", "workspaces", { account: "b", name: "Review" });
    assert.equal(created.status, 201);
    const workspace = created.data;
    assert.equal((await call("PATCH", `workspaces/${workspace.id}`, { name: "Release" })).data.name, "Release");
    const fileReload = new Workspaces(dir);
    assert.equal(fileReload.find(auth.verify(other.cookie())!, workspace.id).name, "Release");
    const inNew = await other.call("POST", `terminals?workspace=${workspace.id}`, { account: "b" });
    assert.equal(inNew.data.workspace, workspace.id);

    // Signing out of b keeps a and hides b's shell from this browser without ending it.
    assert.deepEqual((await call("DELETE", "session/b")).data.accounts, ["a"]);
    assert.deepEqual((await call("GET", "terminals")).data, []);
    assert.equal(terminals.list(terminalOwners(session)).length, 1);
    assert.equal((await call("GET", `terminals${scoped}`)).status, 404);
    assert.equal((await call("DELETE", `workspaces/${workspace.id}`)).status, 404);
    assert.equal((await other.call("DELETE", `workspaces/${workspace.id}`)).status, 200);
    assert.equal((await other.call("GET", `terminals?workspace=${workspace.id}`)).status, 404);
    assert.deepEqual(terminals.list([`login:${workspace.id}:b`]), []);
    assert.deepEqual((await other.call("GET", `terminals${scoped}`)).data.map((info: { id: string }) => info.id), [made.id]);
    const otherSession = auth.verify(other.cookie())!;
    const home = otherSession.accounts[0]!.loginId;
    const removedHome = await other.call("DELETE", `workspaces/${home}`);
    assert.equal(removedHome.status, 200);
    assert.notEqual(removedHome.data.logins[0].id, home);
    assert.equal((await other.call("GET", "session")).data.logins[0].id, removedHome.data.logins[0].id);
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
