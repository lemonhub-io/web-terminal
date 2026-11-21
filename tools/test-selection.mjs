import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer } from "ws";
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

const driver = spawn("chromedriver", ["--port=9515"], { stdio: "ignore" });
let sessionId;
async function driverRequest(route, body, method = body ? "POST" : "GET") {
  const response = await fetch(`http://127.0.0.1:9515${route}`, {
    method,
    ...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const { value } = await response.json();
  if (!response.ok) throw new Error(value?.message ?? `ChromeDriver returned ${response.status}`);
  return value;
}

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  await waitFor(() => driverRequest("/status").then((state) => state.ready).catch(() => false), "ChromeDriver did not start");
  ({ sessionId } = await driverRequest("/session", { capabilities: { alwaysMatch: {
    browserName: "chrome",
    "goog:chromeOptions": { args: ["--headless", "--no-sandbox", "--disable-dev-shm-usage", "--lang=en-US"] },
  } } }));
  const send = (cmd, params = {}) => driverRequest(`/session/${sessionId}/goog/cdp/execute`, { cmd, params });
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
  if (sessionId) await driverRequest(`/session/${sessionId}`, undefined, "DELETE").catch(() => {});
  driver.kill();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
}
