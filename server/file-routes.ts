import { Hono, type Context } from "hono";
import { z } from "zod";
import type { FilePage } from "../shared/files.ts";
import type { Session } from "./auth.ts";
import { fileJob } from "./files.ts";
import { HttpError } from "./http-error.ts";

type Env = { Variables: { session: Session } };
const accountName = z.string().min(1).max(200);
const absolutePath = z.string().max(4096).refine((value) => value.startsWith("/") && !value.includes("\0"));
const itemName = z.string().min(1).max(255).refine((value) =>
  value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0"));
const location = z.object({ account: accountName, path: absolutePath });
const item = location.extend({ name: itemName });
const list = location.partial({ path: true }).extend({
  offset: z.coerce.number().int().min(0).optional().default(0),
  hidden: z.enum(["0", "1"]).optional(),
});
const incomingFile = item.extend({
  size: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().nonnegative().int().max(Number.MAX_SAFE_INTEGER)),
  replace: z.literal("1").optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Enter a valid file path and name");
  return result.data;
}

function account(c: Context<Env>, username: string) {
  const identity = c.get("session").accounts.find((account) => account.username === username);
  if (!identity) throw new HttpError(403, "Sign in to that account first");
  return identity;
}

function attachment(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function fileRoutes() {
  const files = new Hono<Env>();
  files.get("/", async (c) => {
    const { account: username, path, offset, hidden } = parse(list, c.req.query());
    const { value } = await fileJob<FilePage>(account(c, username), { action: "list", path, offset, hidden: hidden === "1" }, c.req.raw.signal);
    return c.json(value);
  });
  files.get("/download", async (c) => {
    const { account: username, path, name } = parse(item, c.req.query());
    const { value, body } = await fileJob<{ name: string }>(account(c, username), { action: "download", path, name }, c.req.raw.signal);
    return new Response(body, {
      headers: { "Content-Type": "application/octet-stream", "Content-Disposition": attachment(value.name), "Cache-Control": "no-store" },
    });
  });
  files.post("/upload", async (c) => {
    const { account: username, path, name, size, replace } = parse(incomingFile, c.req.query());
    const body = c.req.raw.body;
    if (!body && size) throw new HttpError(400, "Choose a file to upload");
    await fileJob(account(c, username), { action: "upload", path, name, size, replace: replace === "1" }, c.req.raw.signal, body ?? undefined);
    return c.json({ ok: true }, 201);
  });
  files.post("/folders", async (c) => {
    const { account: username, path, name } = parse(item, await c.req.json().catch(() => undefined));
    await fileJob(account(c, username), { action: "mkdir", path, name }, c.req.raw.signal);
    return c.json({ ok: true }, 201);
  });
  files.patch("/item", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const { account: username, path, name, to } = parse(item.extend({ to: itemName }), body);
    await fileJob(account(c, username), { action: "rename", path, name, to }, c.req.raw.signal);
    return c.json({ ok: true });
  });
  files.delete("/item", async (c) => {
    const { account: username, path, name } = parse(item, await c.req.json().catch(() => undefined));
    await fileJob(account(c, username), { action: "delete", path, name }, c.req.raw.signal);
    return c.json({ ok: true });
  });
  return files;
}
