import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { createTermApp } from "../app.ts";
import { Assets } from "../assets.ts";
import { Auth, Throttle } from "../auth.ts";
import { Workspaces } from "../workspaces.ts";

test("Files can be managed and transferred under the signed-in account", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wt-files-"));
  let server: ReturnType<typeof serve> | undefined;
  try {
    const config = path.join(root, "secrets");
    const folder = path.join(root, "files");
    fs.mkdirSync(folder);
    const auth = new Auth(config);
    await auth.setAccount("alice", "example-password");
    const unexpected = () => { throw new Error("The file manager requested a shell"); };
    const app = createTermApp({
      auth,
      throttle: new Throttle(),
      terminals: { list: unexpected, create: unexpected, rename: unexpected, kill: unexpected },
      assets: new Assets(path.join(root, "dist")),
      workspaces: new Workspaces(config),
    });
    const origin = await new Promise<string>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        resolve(`http://127.0.0.1:${info.port}`);
      });
    });
    let cookie = "";
    const request = async (route: string, method = "GET", body?: unknown) => {
      const raw = body instanceof Uint8Array;
      const headers = { Origin: origin, Cookie: cookie, "Content-Type": raw ? "application/octet-stream" : "application/json" };
      const res = await fetch(`${origin}/api/${route}`, {
        method, headers, body: raw ? Buffer.from(body) : body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!;
      return res;
    };
    const location = { account: "alice", path: folder };
    const route = (action = "", other: Record<string, string> = {}) => `files${action}?${new URLSearchParams({ ...location, ...other })}`;

    assert.equal((await request(route())).status, 401);
    assert.equal((await request("session", "POST", { username: "alice", password: "example-password" })).status, 200);
    assert.equal((await request(route("", { account: "other" }))).status, 403);
    assert.equal((await request("files/folders", "POST", { ...location, name: "../outside" })).status, 400);
    assert.equal((await request("files/folders", "POST", { ...location, name: "Reports" })).status, 201);

    const data = Buffer.alloc(128 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const upload = route("/upload", { name: "报告.bin", size: String(data.length) });
    assert.equal((await request(upload)).status, 204);
    assert.equal((await request(upload, "POST", data)).status, 201);
    assert.equal((await request(upload)).status, 409);
    assert.equal((await request(route("/upload", { name: "报告.bin", size: "1" }), "POST", Buffer.of(0))).status, 409);
    const malformed = route("/upload", { name: "unfinished.bin", size: "1" });
    assert.equal((await request(malformed, "POST", data)).status, 400);
    assert.deepEqual(fs.readdirSync(folder).sort(), ["Reports", "报告.bin"]);
    assert.deepEqual((await (await request(route())).json()).entries.map((entry: { name: string }) => entry.name), ["Reports", "报告.bin"]);

    const written = await request(route("/download", { name: "报告.bin" }));
    assert.equal(written.status, 200);
    assert.equal(written.headers.get("Content-Type"), "application/octet-stream");
    assert.match(written.headers.get("Content-Disposition") ?? "", /^attachment;.*UTF-8''%E6%8A%A5%E5%91%8A\.bin$/);
    assert.deepEqual(Buffer.from(await written.arrayBuffer()), data);
    assert.equal((await request("files/item", "PATCH", { ...location, name: "报告.bin", to: "archive.bin" })).status, 200);
    assert.equal((await request("files/item", "DELETE", { ...location, name: "Reports" })).status, 200);
    assert.deepEqual((await (await request(route())).json()).entries.map((entry: { name: string }) => entry.name), ["archive.bin"]);
  } finally {
    server?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
