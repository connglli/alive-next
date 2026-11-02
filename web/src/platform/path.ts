// Session and checker scratch paths share one POSIX-style in-memory namespace.
export function join(...parts: string[]): string {
  const path = parts.filter(Boolean).join("/");
  const result: string[] = [];

  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }

  return `${path.startsWith("/") ? "/" : ""}${result.join("/")}` || ".";
}

export function dirname(path: string): string {
  const normalized = join(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index) || "/";
}
