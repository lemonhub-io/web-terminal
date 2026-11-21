// Runs with the same OS identity as the account's shells. The first output line
// is a JSON reply, followed by raw file bytes for downloads.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { FileEntry, FileJob, FilePage, FileReply } from "../shared/files.ts";

const exec = promisify(execFile);
const pageSize = 160;
const errors: Record<string, [number, string]> = {
  EACCES: [403, "Access denied"],
  EPERM: [403, "Access denied"],
  EROFS: [403, "Filesystem is read only"],
  ENOENT: [404, "File or folder not found"],
  ENOTDIR: [404, "Folder not found"],
  EEXIST: [409, "An item with that name already exists"],
  ENOTEMPTY: [409, "The folder is not empty"],
  ENOSPC: [507, "The filesystem is full"],
  EDQUOT: [507, "The storage quota was reached"],
  EINVAL: [400, "Invalid file operation"],
  EISDIR: [400, "Select a regular file"],
};

function reply(value: FileReply<unknown>) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

const kind = (stat: { isDirectory(): boolean; isFile(): boolean }): FileEntry["kind"] =>
  stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";

async function list(home: string, directory: string, offset: number, hidden: boolean): Promise<FilePage> {
  const dir = await fs.realpath(directory);
  const entries = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((entry) => hidden || !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const result: FileEntry[] = [];
  // Bound the concurrent filesystem requests even for a large directory.
  const page = entries.slice(offset, offset + pageSize);
  for (let i = 0; i < page.length; i += 12) {
    const batch = await Promise.all(page.slice(i, i + 12).map(async (entry) => {
      const file = path.join(dir, entry.name);
      try {
        const stat = await fs.lstat(file);
        const link = stat.isSymbolicLink();
        const target = link ? await fs.stat(file).catch(() => undefined) : stat;
        return { name: entry.name, kind: target ? kind(target) : "other" as const, link, size: target?.size ?? stat.size, modified: stat.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    }));
    for (const entry of batch) if (entry) result.push(entry);
  }
  const next = offset + page.length;
  return { path: dir, home, entries: result, ...(next < entries.length && { next }) };
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rename(source: string, target: string) {
  if (await exists(target)) fail("EEXIST");
  if (process.platform === "linux") {
    try {
      await exec("mv", ["--no-clobber", "--no-target-directory", "--", source, target]);
    } catch (error) {
      if (await exists(target)) fail("EEXIST");
      if (!(await exists(source))) fail("ENOENT");
      throw error;
    }
    if (await exists(source)) fail("EEXIST");
  } else {
    await fs.rename(source, target);
  }
}

async function upload(file: string, size: number, replace: boolean, signal: AbortSignal) {
  const temporary = path.join(path.dirname(file), `.wt-upload-${randomBytes(16).toString("hex")}`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > size) done(Object.assign(new Error("Upload size changed"), { code: "EINVAL" }));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(process.stdin, counter, handle.createWriteStream(), { signal });
    if (received !== size) fail("EINVAL");
    signal.throwIfAborted();
    if (replace) await fs.rename(temporary, file);
    else await fs.link(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

const cancellation = new AbortController();
process.on("SIGTERM", () => cancellation.abort());
process.on("SIGINT", () => cancellation.abort());

async function run(job: FileJob, home: string) {
  switch (job.action) {
    case "list":
      return list(home, job.path ?? home, job.offset, job.hidden);
    case "download": {
      const file = path.join(job.path, job.name);
      // Opening in nonblocking mode keeps a named pipe from hanging the worker.
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) fail("EISDIR");
        reply({ ok: true, value: { name: job.name } });
        await pipeline(handle.createReadStream(), process.stdout, { signal: cancellation.signal }).catch(() => { process.exitCode = 1; });
      } finally {
        await handle.close();
      }
      return;
    }
    case "mkdir":
      await fs.mkdir(path.join(job.path, job.name));
      return null;
    case "rename":
      if (job.name !== job.to) await rename(path.join(job.path, job.name), path.join(job.path, job.to));
      return null;
    case "delete":
      await fs.rm(path.join(job.path, job.name), { recursive: true });
      return null;
    case "upload":
      await upload(path.join(job.path, job.name), job.size, job.replace, cancellation.signal);
      return null;
  }
}

try {
  const job = JSON.parse(process.argv[2]!) as FileJob;
  const value = await run(job, process.argv[3]!);
  if (job.action !== "download") reply({ ok: true, value });
} catch (error) {
  const code = String((error as NodeJS.ErrnoException).code ?? "");
  const [status, message] = errors[code] ?? [500, "File operation failed"];
  if (!process.stdout.destroyed) reply({ ok: false, status, message });
}
