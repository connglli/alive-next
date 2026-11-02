// The standalone browser tool implements only the file operations used by the
// unchanged engine. Its session and checker scratch files never leave memory.
import { dirname, join } from "./path.ts";

const files = new Map<string, string>();
const directories = new Set<string>(["/", "/tmp"]);
let serial = 0;
let appended: ((path: string, text: string) => void) | undefined;
let written: ((path: string, text: string) => void) | undefined;

export function observeWrites(listener: (path: string, text: string) => void) {
  written = listener;
}

// Trajectory appends expose progress without changing the engine's logger.
export function observeAppends(listener: (path: string, text: string) => void) {
  appended = listener;
}

export function mkdirSync(path: string) {
  let current = join(path);
  while (!directories.has(current)) {
    directories.add(current);
    current = dirname(current);
  }
}

export function existsSync(path: string) {
  return files.has(join(path)) || directories.has(join(path));
}

export function readFileSync(path: string): string {
  const text = files.get(join(path));
  if (text === undefined) throw new Error(`No in-memory file: ${path}`);
  return text;
}

export function writeFileSync(path: string, data: string | Uint8Array) {
  mkdirSync(dirname(path));
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const key = join(path);
  files.set(key, text);
  written?.(key, text);
}

export function appendFileSync(path: string, data: string) {
  writeFileSync(path, (files.get(join(path)) ?? "") + data);
  appended?.(join(path), data);
}

export function renameSync(from: string, to: string) {
  writeFileSync(to, readFileSync(from));
  files.delete(join(from));
}

export function readdirSync(path: string): string[] {
  const prefix = `${join(path)}/`;
  return [
    ...new Set(
      [...files.keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("/")[0] as string),
    ),
  ];
}

export function mkdtempSync(prefix: string): string {
  const path = `${prefix}${++serial}`;
  mkdirSync(path);
  return path;
}

export function rmSync(path: string) {
  const key = join(path);
  for (const file of files.keys())
    if (file === key || file.startsWith(`${key}/`)) files.delete(file);
  for (const dir of directories)
    if (dir === key || dir.startsWith(`${key}/`)) directories.delete(dir);
}
