import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { Assets } from "../server/assets.ts";

const text = "SELECTIONCHECK";
const id = "000000000000000000000001";
const assets = new Assets("client/dist");
const server = createServer(async (req, res) => {
  if (req.url === "/api/session") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ username: "test", accounts: ["test"] }));
  }
  if (req.url === "/api/terminals") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify([{ id, account: "test", title: "Shell", name: "", created: 0, clients: 1 }]));
  }
  const file = assets.response(req.url ?? "/");
  res.writeHead(file.status, Object.fromEntries(file.headers));
  res.end(Buffer.from(await file.arrayBuffer()));
});
const sockets = new WebSocketServer({ server });
const writes = [];
let size;
sockets.on("connection", (socket) => {
  socket.send(JSON.stringify({ type: "snapshot", cols: 80, rows: 24, data: text + "\x1b[?1000h\x1b[?1006h" }));
  socket.on("message", (data, binary) => {
    if (binary) writes.push(data.toString());
    else size = JSON.parse(data.toString());
  });
});

async function waitFor(read, message) {
  const deadline = Date.now() + 8_000;
  do {
    const value = await read();
    if (value) return value;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new Error(message);
}

const profile = mkdtempSync(path.join(tmpdir(), "wt-chrome-"));
const chrome = spawn(process.env.CHROME ?? "google-chrome", [
  "--headless", "--no-sandbox", "--no-first-run", "--lang=en-US",
  "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
let debuggerSocket;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = await waitFor(async () => {
    try {
      const port = readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
    } catch {
      return undefined;
    }
  }, "Chrome did not start");
  debuggerSocket = new WebSocket(target);
  await once(debuggerSocket, "open");
  let requestId = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++requestId;
    const receive = (raw) => {
      const reply = JSON.parse(raw.toString());
      if (reply.id !== request) return;
      debuggerSocket.off("message", receive);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    };
    debuggerSocket.on("message", receive);
    debuggerSocket.send(JSON.stringify({ id: request, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: origin });
  const screen = 'document.querySelector(".xterm.enable-mouse-events .xterm-screen")';
  await waitFor(() => evaluate(`Boolean(${screen})`), "Terminal did not enter mouse mode");
  await waitFor(() => size?.cols, "Terminal resize did not reach the shell");
  const { left, top, width, height } = await evaluate(`${screen}.getBoundingClientRect().toJSON()`);
  const x = (col) => left + col * width / size.cols;
  const y = top + height / size.rows / 2;
  const mouse = (type, col, button, buttons) => send("Input.dispatchMouseEvent", {
    type, x: x(col), y, button, buttons, clickCount: 1,
  });
  const copy = 'document.querySelector(\'button[aria-label="Copy selection"]\')';
  const clipboard = () => evaluate("navigator.clipboard.readText()");
  const copyText = async () => {
    assert.equal(await evaluate(`${copy}.hidden`), false, "Terminal selection did not appear");
    await evaluate(`${copy}.click()`);
    assert.equal(await waitFor(clipboard, "Clipboard did not receive the selection"), text);
  };

  await mouse("mousePressed", 0.1, "left", 1);
  await mouse("mouseMoved", text.length + 0.1, "none", 1);
  await mouse("mouseReleased", text.length + 0.1, "left", 0);
  await copyText();
  assert.deepEqual(writes, [], "Text drag sent mouse reports to the program");

  await mouse("mousePressed", 18, "left", 1);
  await mouse("mouseReleased", 18, "left", 0);
  await waitFor(() => writes.length >= 2, "A click did not reach the program");
  assert.match(writes.join(""), /\x1b\[<0;\d+;1M\x1b\[<0;\d+;1m/);

  await evaluate('navigator.clipboard.writeText("")');
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  const touch = (type, col) => send("Input.dispatchTouchEvent", {
    type, touchPoints: col === undefined ? [] : [{ x: x(col), y, id: 1 }],
  });
  await touch("touchStart", 0.5);
  await waitFor(() => evaluate(`!${copy}.hidden`), "Touch hold did not start a selection");
  await touch("touchMove", text.length - 0.5);
  await touch("touchEnd");
  await copyText();
  assert.equal(writes.length, 2, "Touch selection sent mouse reports to the program");
  console.log("Mouse drag and touch hold copied terminal text with mouse tracking enabled");
} finally {
  debuggerSocket?.terminate();
  const exited = once(chrome, "exit");
  chrome.kill();
  if (chrome.exitCode === null) await exited;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
}
