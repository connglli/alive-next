import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = fileURLToPath(new URL("../", import.meta.url));
const dist = join(web, "dist");

async function snapshot(directory) {
  const contents = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    contents[entry.name] = entry.isDirectory()
      ? await snapshot(path)
      : createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
  }
  return contents;
}

const html = await readFile(join(dist, "index.html"), "utf8");
for (const match of html.matchAll(/(?:src|href)="\.\/([^"/][^"]*)"/g)) {
  await readFile(join(dist, match[1]));
  assert.match(match[1], /\.[a-f0-9]{64}\.(js|css)$/);
}

const before = await snapshot(dist);
const scratch = await mkdtemp(join(web, "build/failing-build-"));

try {
  // Inject a bundler failure after staging starts, then compare the entire dist.
  const fixture = join(scratch, "fail.mjs");
  await writeFile(
    fixture,
    `Bun.build = async () => ({ success: false, logs: [new Error("test failure")] });
await import(${JSON.stringify(pathToFileURL(join(web, "scripts/bundle-site.ts")).href)});`,
  );

  const failure = spawnSync("bun", [fixture], { encoding: "utf8", timeout: 30000 });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /test failure/);
  assert.deepEqual(await snapshot(dist), before, "Failed builds must preserve the working site");
  console.log("Hashed assets and preservation of the site after a failed build: passed");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
