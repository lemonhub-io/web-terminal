import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { FileJob, FileReply } from "../shared/files.ts";
import type { SessionIdentity } from "./auth.ts";
import { checkUpload, fileFailure, pipeUpload, writeUpload } from "./file-uploads.ts";
import { HttpError } from "./http-error.ts";
import { resolveSystemUser } from "./terminal.ts";

const worker = path.join(import.meta.dirname, "file-worker.ts");
const serviceUser = os.userInfo().username;
const environment = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
};
const maxReply = 512 * 1024;

export async function uploadJob(
  account: SessionIdentity,
  job: Extract<FileJob, { action: "upload" | "checkUpload" }>,
  signal: AbortSignal,
  input?: Readable,
) {
  if (account.systemUser && account.systemUser !== serviceUser) {
    await fileJob(account, job, signal, input);
    return;
  }
  const file = path.join(job.path, job.name);
  try {
    if (job.action === "checkUpload") await checkUpload(file);
    else await writeUpload(file, job.size, job.replace, signal, input ?? Readable.from([]));
  } catch (error) {
    const [status, message] = fileFailure(error);
    throw new HttpError(status, message);
  }
}

async function readReply<T>(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const pieces: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new HttpError(503, "The file service could not start");
    const chunk = Buffer.from(value);
    const newline = chunk.indexOf(10);
    const header = newline < 0 ? chunk : chunk.subarray(0, newline);
    bytes += header.length;
    if (bytes > maxReply) throw new HttpError(500, "The file service returned too much data");
    pieces.push(header);
    if (newline >= 0) {
      const reply = JSON.parse(Buffer.concat(pieces).toString()) as FileReply<T>;
      if (!reply.ok) throw new HttpError(reply.status, reply.message);
      return { value: reply.value, tail: chunk.subarray(newline + 1) };
    }
  }
}

export async function fileJob<T>(
  account: SessionIdentity,
  job: FileJob,
  signal: AbortSignal,
  input?: Readable,
): Promise<{ value: T; body?: ReadableStream<Uint8Array> }> {
  const target = account.systemUser && account.systemUser !== serviceUser ? resolveSystemUser(account.systemUser) : undefined;
  const home = target?.homedir ?? os.homedir();
  const args = [worker, JSON.stringify(job), home];
  // Resolve paths and open files only after dropping to the shell account.
  const child = target
    ? spawn("sudo", ["-n", "-u", target.username, "--", process.execPath, ...args], { cwd: "/", env: environment })
    : spawn(process.execPath, args, { cwd: "/", env: environment });
  child.stderr.resume();
  const exit = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  const reader = (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).getReader();
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const cleanup = () => signal.removeEventListener("abort", abort);
  const transfer = input
    ? pipeUpload(input, child.stdin, finished(child.stdin, { readable: false, cleanup: true, signal })).then(() => true, () => false)
    : undefined;
  if (!transfer) child.stdin.end();
  try {
    const { value, tail } = await readReply<T>(reader);
    if (job.action !== "download") {
      const sent = await transfer;
      const code = await exit;
      if (code !== 0 || sent === false) throw new HttpError(503, "The file operation was interrupted");
      cleanup();
      return { value };
    }

    let prefix: Uint8Array | undefined = tail.length ? tail : undefined;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (prefix) {
            controller.enqueue(prefix);
            prefix = undefined;
            return;
          }
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          cleanup();
          if (await exit === 0) controller.close();
          else controller.error(new Error("The download was interrupted"));
        } catch (error) {
          cleanup();
          abort();
          controller.error(error);
        }
      },
      cancel() {
        cleanup();
        abort();
        return reader.cancel();
      },
    });
    return { value, body };
  } catch (error) {
    cleanup();
    abort();
    await reader.cancel().catch(() => {});
    throw error;
  }
}
