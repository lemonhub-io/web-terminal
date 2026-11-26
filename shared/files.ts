export interface FileEntry {
  name: string;
  kind: "directory" | "file" | "other";
  link: boolean;
  size: number;
  modified: number;
}

export interface FilePage {
  path: string;
  home: string;
  entries: FileEntry[];
  next?: number;
}

export type FileJob =
  | { action: "list"; path?: string; offset: number; hidden: boolean }
  | { action: "download" | "mkdir" | "delete"; path: string; name: string }
  | { action: "checkUpload"; path: string; name: string }
  | { action: "rename"; path: string; name: string; to: string }
  | { action: "upload"; path: string; name: string; size: number; replace: boolean };

export type FileReply<T> = { ok: true; value: T } | { ok: false; status: number; message: string };
