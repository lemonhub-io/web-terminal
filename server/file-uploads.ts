import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

const bufferSize = 256 * 1024;

export function fileFailure(error: unknown): [number, string] {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  return Object.hasOwn(errors, code) ? errors[code]! : [500, "File operation failed"];
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function checkUpload(file: string) {
  if (await exists(file)) throw Object.assign(new Error("Name exists"), { code: "EEXIST" });
}

// Keep the inbound socket open on a filesystem error so we can send its status.
export async function pipeUpload(input: Readable, destination: Writable, completed: Promise<void>) {
  const sourceError = (error: Error) => destination.destroy(error);
  input.on("error", sourceError);
  try {
    if (input.errored) sourceError(input.errored);
    else input.pipe(destination);
    await completed;
  } finally {
    input.unpipe(destination);
    input.off("error", sourceError);
  }
}

export async function writeUpload(file: string, size: number, replace: boolean, signal: AbortSignal, input: Readable) {
  signal.throwIfAborted();
  const temporary = path.join(path.dirname(file), `.wt-upload-${randomBytes(16).toString("hex")}`);
  const handle = await fs.open(temporary, "wx", 0o600);
  let received = 0;
  const counter = new Transform({
    highWaterMark: bufferSize,
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      if (received > size) done(Object.assign(new Error("Upload size changed"), { code: "EINVAL" }));
      else done(null, chunk);
    },
  });
  try {
    await pipeUpload(input, counter, pipeline(counter, handle.createWriteStream({ highWaterMark: bufferSize }), { signal }));
    if (received !== size) throw Object.assign(new Error("Upload size changed"), { code: "EINVAL" });
    signal.throwIfAborted();
    if (replace) await fs.rename(temporary, file);
    else await fs.link(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}
