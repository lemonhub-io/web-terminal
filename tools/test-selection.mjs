import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { Assets } from "../server/assets.ts";

const text = "SELECTIONCHECK";
const line = `${text} EXTRA`;
const main = { id: "aaaaaaaaaaaaaaaa", account: "test", name: "Main", created: 0 };
const review = { id: "bbbbbbbbbbbbbbbb", account: "test", name: "Review", created: 1 };
const session = { username: "test", accounts: ["test"], logins: [{ account: "test", loginId: main.id, id: main.id }] };
const reviewTerminal = "000000000000000000000002";
const assets = new Assets("client/dist");
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/session" || url.pathname === "/api/workspaces") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ...session, workspaces: [main, review] }));
  }
  if (url.pathname === "/api/terminals") {
    const selected = url.searchParams.get("workspace") === review.id ? review : main;
    const id = selected === review ? reviewTerminal : "000000000000000000000001";
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify([{ id, account: "test", workspace: selected.id, title: selected.name, name: "", created: 0, clients: 1 }]));
  }
  if (url.pathname === "/api/files") {
    const account = url.searchParams.get("account");
    const home = "/home/test";
    const path = url.searchParams.get("path") ?? home;
    if (account !== "test" || ![home, home + "/Reports"].includes(path)) return res.writeHead(404).end();
    const entries = path === home
      ? [{ name: "Reports", kind: "directory", size: 0, link: false, modified: 0 }]
      : [{ name: "report.txt", kind: "file", size: 12, link: false, modified: 0 }];
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ home, path, entries }));
  }
  const file = assets.response(req.url ?? "/");
  res.writeHead(file.status, Object.fromEntries(file.headers));
  res.end(Buffer.from(await file.arrayBuffer()));
});
const sockets = new WebSocketServer({ server });
const writes = [];
let size;
sockets.on("connection", (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  const inReview = url.pathname.endsWith(reviewTerminal) && url.searchParams.get("workspace") === review.id;
  socket.send(JSON.stringify({ type: "snapshot", cols: 80, rows: 24, data: line + "\x1b[?1000h\x1b[?1006h" }));
  socket.on("message", (data, binary) => {
    if (binary) writes.push(data.toString());
    else if (inReview) size = JSON.parse(data.toString());
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
  const touch = (type, point) => send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
  const center = async (selector) => evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    const { x, y, width, height } = element.getBoundingClientRect();
    const point = { x: x + width / 2, y: y + height / 2 };
    if (!width || !height || !element.contains(document.elementFromPoint(point.x, point.y))) {
      throw new Error("Touch target is not visible: " + ${JSON.stringify(selector)});
    }
    return point;
  })()`);
  const tap = async (selector) => {
    await touch("touchStart", await center(selector));
    await touch("touchEnd");
  };
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 750, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await send("Page.navigate", { url: origin });
  await waitFor(() => evaluate('Boolean(document.querySelector(".xterm.enable-mouse-events"))'), "Initial session did not open");
  await tap('button[aria-label="Sessions"]');
  const reviewRow = '.workspace-open[title="Review"]';
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(reviewRow)}))`), "Session list did not show Review");
  await tap(reviewRow);
  await waitFor(() => size?.cols, "Review did not open its terminal in the selected session");
  assert.equal(await evaluate(`sessionStorage.getItem("web-terminal:session:${main.id}")`), review.id);
  assert.equal(await evaluate('document.querySelector(".tab-label[aria-selected=true]").textContent'), "Review");
  const screen = 'document.querySelector(".xterm.enable-mouse-events .xterm-screen")';
  await waitFor(() => evaluate(`Boolean(${screen})`), "Terminal did not enter mouse mode");
  const { left, top, width, height } = await evaluate(`${screen}.getBoundingClientRect().toJSON()`);
  const x = (col) => left + col * width / size.cols;
  const y = top + height / size.rows / 2;
  const copy = ".touch-actions-row button:first-of-type";
  const clipboard = () => evaluate("navigator.clipboard.readText()");
  const copyText = async (expected) => {
    await tap(copy);
    try {
      await waitFor(async () => await clipboard() === expected, `Clipboard did not receive ${expected}`);
    } catch (error) {
      const { status, manual, hit } = await evaluate(`(() => {
        const button = document.querySelector(${JSON.stringify(copy)});
        const { x, y, width, height } = button.getBoundingClientRect();
        const target = document.elementFromPoint(x + width / 2, y + height / 2);
        return { status: document.querySelector(".touch-actions-row span").textContent,
          manual: document.querySelector(".touch-actions textarea").hidden,
          hit: { target: target?.tagName, className: target?.className, x, y, width, height, hidden: button.hidden } };
      })()`);
      throw new Error(`${error.message}; received ${JSON.stringify(await clipboard())}; status ${JSON.stringify(status)}; manual hidden ${manual}; copy target ${JSON.stringify(hit)}`);
    }
  };

  await touch("touchStart", { x: x(4.5), y });
  const endHandle = ".touch-selection:not([hidden]) .touch-handle.end:not([hidden])";
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(endHandle)})?.getBoundingClientRect().width)`),
    "Touch hold did not show selection handles");
  await touch("touchEnd");
  await copyText(text);

  const handle = await center(endHandle);
  await touch("touchStart", handle);
  await touch("touchMove", { x: handle.x + x(line.length) - x(text.length), y: handle.y });
  await touch("touchEnd");
  await copyText(line);

  await evaluate('Object.defineProperty(navigator, "clipboard", { value: undefined })');
  await tap(copy);
  const manual = 'document.querySelector(".touch-actions textarea:not([hidden])")';
  assert.equal(await evaluate(`${manual}?.value`), line, "Manual copy lost the selected text");
  assert.deepEqual(writes, [], "Touch selection sent mouse reports to the program");

  await tap('button[aria-label="Files"]');
  const folder = '.file-entry[title="Reports"]';
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(folder)}))`), "File manager did not open the account's home folder");
  await tap(folder);
  const report = '.file-entry[title="report.txt"]';
  const download = await waitFor(() => evaluate(`document.querySelector(${JSON.stringify(report)})?.getAttribute("href")`), "Opening Reports did not show its file");
  const parameters = new URL(download, origin).searchParams;
  assert.deepEqual(Object.fromEntries(parameters), { account: "test", path: "/home/test/Reports", name: "report.txt" });
  console.log("Session switching, touch selection, and file navigation passed in the phone browser");
} finally {
  if (sessionId) await driverRequest(`/session/${sessionId}`, undefined, "DELETE").catch(() => {});
  driver.kill();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
}
