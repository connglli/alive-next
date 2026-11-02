import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const web = resolve(import.meta.dir, "..");
const root = resolve(web, "..");
const dist = join(web, "dist");

// Keep incomplete output separate from the last successful local build.
await mkdir(join(web, "build"), { recursive: true });
const staging = await mkdtemp(join(web, "build/site-"));

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// Content-addressed URLs let each build reference exactly its own assets.
async function asset(name: string, extension: string, bytes: Uint8Array | string) {
  const path = `${name}.${digest(bytes)}.${extension}`;
  await writeFile(join(staging, path), bytes);
  return path;
}

async function bundle(name: string, define: Record<string, string> = {}) {
  const result = await Bun.build({
    entrypoints: [join(web, "src", `${name}.ts`)],
    target: "browser",
    format: "esm",
    minify: true,
    define,
    plugins: [
      {
        name: "browser-platform",
        setup(build) {
          // Adapt the engine's imports without adding browser code to the engine.
          build.onResolve({ filter: /^node:(fs|path|os|crypto)$/ }, (args) => ({
            path: join(web, "src/platform", `${args.path.slice(5)}.ts`),
          }));
        },
      },
    ],
  });

  if (!result.success) throw new AggregateError(result.logs, `Cannot bundle ${name}`);

  const entry = result.outputs.find((output) => output.kind === "entry-point");
  if (!entry) throw new Error(`No bundle output for ${name}`);

  return asset(name, "js", new Uint8Array(await entry.arrayBuffer()));
}

async function generate() {
  await mkdir(join(staging, "assets"));
  const checkers: Record<string, { glue: string; wasm: string }> = {};

  for (const [tool, binary] of [
    ["llops", "llops"],
    ["alive2", "alive-tv"],
  ] as const) {
    const source = join(web, "build", tool, "bin", binary);
    const glue = await readFile(`${source}.mjs`);
    const wasm = await readFile(`${source}.wasm`);

    // Glue and Wasm share a hash so caches cannot mix versions of one checker.
    const hash = createHash("sha256").update(glue).update(wasm).digest("hex");
    const gluePath = `assets/${binary}.${hash}.mjs`;
    const wasmPath = `assets/${binary}.${hash}.wasm.gz`;

    await writeFile(join(staging, gluePath), glue);
    await writeFile(join(staging, wasmPath), gzipSync(wasm, { level: 9 }));
    checkers[binary] = { glue: gluePath, wasm: wasmPath };
  }

  // Bundle dependencies first, then embed their relative URLs in the page code.
  const manifest = await asset("assets/checkers", "json", JSON.stringify(checkers));
  const [search, tool] = await Promise.all([bundle("alive-simple.worker"), bundle("tool.worker")]);
  const app = await bundle("app", {
    SEARCH_WORKER_FILE: JSON.stringify(search),
    TOOL_WORKER_FILE: JSON.stringify(tool),
    CHECKERS_MANIFEST: JSON.stringify(manifest),
  });

  const syntax = await asset(
    "syntax",
    "css",
    await readFile(join(web, "node_modules/highlight.js/styles/github.min.css")),
  );
  const theme = await asset(
    "theme",
    "css",
    await readFile(join(root, "scripts/visualize_theme.css")),
  );
  const style = await asset("style", "css", await readFile(join(web, "static/style.css")));
  const html = (await readFile(join(web, "static/index.html"), "utf8"))
    .replace('src="./app.js"', `src="./${app}"`)
    .replace('href="./syntax.css"', `href="./${syntax}"`)
    .replace('href="./theme.css"', `href="./${theme}"`)
    .replace('href="./style.css"', `href="./${style}"`);
  await writeFile(join(staging, "index.html"), html);

  // The distributed checker binaries carry their upstream license notices.
  const native = execFileSync(join(root, "scripts/depman.sh"), ["toolchain"], {
    encoding: "utf8",
  }).trim();
  const licenses = [
    ["LLVM", join(native, "llvm-project/llvm/LICENSE.TXT")],
    ["alive2", join(native, "alive2/LICENSE")],
    ["Z3", join(web, "build/z3-src/LICENSE.txt")],
    ["Emscripten", join(web, "build/emsdk/upstream/emscripten/LICENSE")],
    ["noble-hashes", join(web, "node_modules/@noble/hashes/LICENSE")],
    ["Highlight.js", join(web, "node_modules/highlight.js/LICENSE")],
  ] as const;

  await writeFile(
    join(staging, "third-party-licenses.txt"),
    (
      await Promise.all(
        licenses.map(async ([name, path]) => `${name}\n${await readFile(path, "utf8")}\n`),
      )
    ).join("\n"),
  );

  // GitHub Pages must serve the generated files without Jekyll processing.
  await writeFile(join(staging, ".nojekyll"), "");
}

// Install the local dist directory only after generation succeeds, with rollback.
async function publish() {
  const backup = `${staging}.previous`;
  let previous = false;

  try {
    await rename(dist, backup);
    previous = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await rename(staging, dist);
  } catch (error) {
    if (previous) await rename(backup, dist);
    throw error;
  }

  if (previous) await rm(backup, { recursive: true });
}

try {
  await generate();
  await publish();
} finally {
  await rm(staging, { recursive: true, force: true });
}

console.log(
  `\n\n=============================================\nStatic site: ${dist}\nServe: python3 -m http.server 8000 --directory web/dist\nOpen: http://localhost:8000/`,
);
