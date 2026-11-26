// Runs with the same OS identity as the account's shells. The first output line
// is a JSON reply, followed by raw file bytes for downloads.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { FileEntry, FileJob, FilePage, FileReply } from "../shared/files.ts";
import { checkUpload, exists, fileFailure, writeUpload } from "./file-uploads.ts";

const exec = promisify(execFile);
const pageSize = 160;

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
    case "checkUpload":
      await checkUpload(path.join(job.path, job.name));
      return null;
    case "upload":
      await writeUpload(path.join(job.path, job.name), job.size, job.replace, cancellation.signal, process.stdin);
      return null;
  }
}

try {
  const job = JSON.parse(process.argv[2]!) as FileJob;
  const value = await run(job, process.argv[3]!);
  if (job.action !== "download") reply({ ok: true, value });
} catch (error) {
  const [status, message] = fileFailure(error);
  if (!process.stdout.destroyed) reply({ ok: false, status, message });
}
