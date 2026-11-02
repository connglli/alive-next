// Compare real native and WebAssembly tools; an absent tool fails the probe.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = dirname(web);
const native = spawnSync(join(root, "scripts/depman.sh"), ["toolchain"], { encoding: "utf8" });
if (native.status !== 0) throw new Error(native.stderr);

const toolchain = native.stdout.trim();
const requested = process.argv.slice(2);
if (requested.some((tool) => !["llops", "alive2", "llubi"].includes(tool))) {
  throw new Error("usage: node web/scripts/probe.mjs [llops|alive2|llubi ...]");
}

const tools = new Set(requested.length ? requested : ["llops", "alive2", "llubi"]);
const report = {
  node: process.version,
  host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  at: new Date().toISOString(),
  artifacts: [],
  cases: [],
};

// Fresh processes expose cold startup and peak RSS; the outer timeout bounds hangs.
function measured(command, args, input) {
  const started = performance.now();
  const result = spawnSync(
    "timeout",
    ["--signal=KILL", "120", "/usr/bin/time", "-f", "\nPROBE_RSS=%M", command, ...args],
    {
      input,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;

  const rss = /PROBE_RSS=(\d+)/.exec(result.stderr);
  return {
    exit: result.status,
    stdout: result.stdout,
    stderr: result.stderr.replace(/\nPROBE_RSS=\d+\n/, ""),
    wallMs: performance.now() - started,
    maxRssKiB: rss ? Number(rss[1]) : null,
  };
}

function compare(name, binary, wasm, request, accept) {
  // Native file arguments refer to disk; the Wasm runner receives file contents.
  const nativeArgs = request.args.map((arg) =>
    Object.hasOwn(request.files ?? {}, arg) ? join(web, "build", arg) : arg,
  );
  for (const [path, text] of Object.entries(request.files ?? {})) {
    writeFileSync(join(web, "build", path), text);
  }

  const host = measured(binary, nativeArgs, request.stdin ?? "");
  const child = measured(
    process.execPath,
    [join(web, "scripts/invoke.mjs"), wasm],
    JSON.stringify(request),
  );
  if (child.exit !== 0)
    throw new Error(`${name}: WASM runner failed: ${child.stderr}\n${child.stdout}`);

  const guest = { ...child, ...JSON.parse(child.stdout), runnerStderr: child.stderr };
  if (!accept(host) || !accept(guest)) {
    throw new Error(
      `${name}: native/WASM disagreement\n${JSON.stringify({ host, guest }, null, 2)}`,
    );
  }

  report.cases.push({ name, native: host, wasm: guest });
  console.log(`${name}: native ${host.wallMs.toFixed(0)} ms; WASM ${guest.wallMs.toFixed(0)} ms`);
  return { host, guest };
}

function artifact(path) {
  const data = readFileSync(path);
  report.artifacts.push({
    file: path.slice(web.length + 1),
    bytes: data.byteLength,
    gzipBytes: gzipSync(data).length,
  });
}

if (tools.has("llops")) {
  const wasm = join(web, "build/llops/bin/llops.mjs");
  artifact(wasm);
  artifact(wasm.replace(/\.mjs$/, ".wasm"));
  const binary = join(toolchain, "llops/build/llops");
  const module = "define i32 @f(i32 %x) {\nentry:\n  %r = add i32 %x, 0\n  ret i32 %r\n}\n";

  compare(
    "validate",
    binary,
    wasm,
    { args: ["validate"], stdin: JSON.stringify({ module }) },
    (r) => r.exit === 0 && JSON.parse(r.stdout).conforms === true,
  );

  const canonical = compare(
    "canon",
    binary,
    wasm,
    { args: ["canon"], stdin: JSON.stringify({ module }) },
    (r) => r.exit === 0 && JSON.parse(r.stdout).ok === true,
  );
  if (JSON.parse(canonical.host.stdout).module !== JSON.parse(canonical.guest.stdout).module) {
    throw new Error("native and WASM canonical text differ");
  }

  compare(
    "reject undef",
    binary,
    wasm,
    { args: ["canon"], stdin: JSON.stringify({ module: module.replace("%r\n", "undef\n") }) },
    (r) => r.exit === 1 && JSON.parse(r.stdout).error?.code === "undef",
  );
}

if (tools.has("alive2")) {
  const wasm = join(web, "build/alive2/bin/alive-tv.mjs");
  artifact(wasm);
  artifact(wasm.replace(/\.mjs$/, ".wasm"));
  const binary = join(toolchain, "alive2/build/alive-tv");
  const fn = (body) => `define i32 @f(i32 %x) {\n${body}\n}\n`;
  const additions = Array.from(
    { length: 512 },
    (_, i) => `%v${i} = add i32 ${i === 0 ? "%x" : `%v${i - 1}`}, 1`,
  );

  for (const [name, src, tgt, correct] of [
    ["identity", fn("ret i32 %x"), fn("ret i32 %x"), true],
    [
      "strength reduction",
      fn("%r = mul i32 %x, 2\nret i32 %r"),
      fn("%r = shl i32 %x, 1\nret i32 %r"),
      true,
    ],
    [
      "overflow refutation",
      fn("%r = add i32 %x, 1\nret i32 %r"),
      fn("%r = add nsw i32 %x, 1\nret i32 %r"),
      false,
    ],
    [
      "512 additions",
      fn(`${additions.join("\n")}\nret i32 %v511`),
      fn("%r = add i32 %x, 512\nret i32 %r"),
      true,
    ],
  ]) {
    compare(
      name,
      binary,
      wasm,
      {
        args: ["src.ll", "tgt.ll", "--smt-to=1000", "--disable-undef-input"],
        files: { "src.ll": src, "tgt.ll": tgt },
      },
      (r) =>
        r.exit === 0 &&
        (correct
          ? /^\s*1 correct transformations\s*$/m
          : /^\s*1 incorrect transformations\s*$/m
        ).test(r.stdout),
    );
  }

  // Exercise solver cancellation, which the single-threaded timer port must retain.
  compare(
    "solver timeout",
    binary,
    wasm,
    {
      args: ["src.ll", "tgt.ll", "--smt-to=1", "--disable-undef-input"],
      files: {
        "src.ll": "define i64 @f(i64 %x) { %r = udiv i64 %x, 3\nret i64 %r }\n",
        "tgt.ll":
          "define i64 @f(i64 %x) { %z = zext i64 %x to i128\n%p = mul i128 %z, 12297829382473034411\n%q = lshr i128 %p, 65\n%r = trunc i128 %q to i64\nret i64 %r }\n",
      },
    },
    (r) => r.exit === 0 && /^\s*1 failed-to-prove transformations\s*$/m.test(r.stdout),
  );
}

if (tools.has("llubi")) {
  const wasm = join(web, "build/llubi/bin/llubi.mjs");
  artifact(wasm);
  artifact(wasm.replace(/\.mjs$/, ".wasm"));
  compare(
    "llubi main",
    join(toolchain, "llubi-legacy/build/llubi"),
    wasm,
    { args: ["-"], stdin: "define i32 @main() { ret i32 42 }\n" },
    (r) => r.exit === 42,
  );
}

const path = join(web, "build", `probe${tools.size === 1 ? `-${[...tools][0]}` : ""}.json`);
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Report: ${path}`);
