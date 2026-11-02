import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { certify } from "../../engine/cert/main.ts";
import { sha256 } from "../../engine/core/state/hash.ts";
import { sessionArchive } from "../src/archive.ts";
import { certificatePackage } from "../src/certificate.ts";
import type { ReportSource } from "../src/protocol.ts";
import { visualizerData } from "../src/visualizer-data.ts";

const scratch = mkdtempSync(join(import.meta.dir, "../build/visualizer-test-"));
const checker = readFileSync(join(import.meta.dir, "../../kernel/check.py"), "utf8");
let fixtures: { source: ReportSource; expected: ReturnType<typeof visualizerData> }[];
try {
  const result = spawnSync("python3", [join(import.meta.dir, "visualizer-fixtures.py")], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: scratch },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  fixtures = JSON.parse(result.stdout);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

test("browser data matches the native visualizer's regression sessions", () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(20);
  for (const fixture of fixtures) expect(visualizerData(fixture.source)).toEqual(fixture.expected);
});

test("details reject a damaged trajectory or missing program instead of showing a false history", () => {
  const source = structuredClone(fixtures[0]?.source) as ReportSource;
  source.trajectory[0] = (source.trajectory[0] as string).replace('"prev": ""', '"prev": "broken"');
  expect(() => visualizerData(source)).toThrow("trajectory line 1");
  expect(() =>
    visualizerData({ trajectory: fixtures[0]?.source.trajectory ?? [], programs: {} }),
  ).toThrow("Missing program");
});

test("ZIPs preserve the module, report and native session layout for completed and partial runs", () => {
  const full = fixtures[0]?.source as ReportSource;
  const module = "; Original module: λ雪😀\n";
  const html = "<!doctype html><title>Saved session</title><p>λ雪😀</p>";
  for (const source of [full, { ...full, trajectory: full.trajectory.slice(0, 1) }]) {
    const scratch = mkdtempSync(join(import.meta.dir, "../build/archive-test-"));
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          `
import io, json, re, sys, tempfile, zipfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import visualize
with tempfile.TemporaryDirectory() as directory:
    with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
        assert archive.testzip() is None
        archive.extractall(directory)
        module = archive.read('module.ll').decode()
        report = archive.read('session/session.html').decode()
        files = {name: archive.read(name).decode() for name in archive.namelist()}
    page = visualize.render(Path(directory) / 'session')
    data = json.loads(re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S)[1])
    print(json.dumps({'module': module, 'report': report, 'data': data, 'files': files}))
`,
          join(import.meta.dir, "../../scripts"),
        ],
        {
          input: sessionArchive(source, module, html, checker),
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", TMPDIR: scratch },
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      const saved = JSON.parse(result.stdout);
      expect(saved.module).toBe(module);
      expect(saved.report).toBe(html);
      expect(saved.files["session/trajectory.jsonl"]).toBe(source.trajectory.join(""));
      for (const [hash, text] of Object.entries(source.programs))
        expect(saved.files[`session/store/${hash}.ll`]).toBe(text);
      expect(saved.data).toEqual(visualizerData(source));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test("ZIP store filenames cannot escape the session directory", () => {
  expect(() =>
    sessionArchive({ trajectory: [], programs: { "../escape": "bad" } }, "", "", checker),
  ).toThrow("Invalid stored program name");
});

test("certificate packages match the native generator for verified and refuted runs", () => {
  const base = fixtures.find((fixture) => fixture.expected.verdict === "verified")
    ?.source as ReportSource;
  const start = JSON.parse(base.trajectory[0] as string);
  for (const outcome of ["verified", "counterexample"] as const) {
    let previous = "";
    const events = [
      { kind: "start", src: start.src, tgt: start.tgt, config: {}, versions: {} },
      { kind: "tool_call", id: "c", tool: "check", args: { gid: "g1" } },
      {
        kind: "tool_result",
        id: "c",
        tool: "check",
        ms: 0,
        effects: [{ effect: outcome === "verified" ? "proved" : "refuted", gid: "g1" }],
        result: {
          outcome: outcome === "verified" ? "proved" : "refuted",
          check: { detail: "test checker" },
        },
      },
      { kind: "verdict", outcome },
    ];
    const trajectory = events.map((event) => {
      const line = JSON.stringify({ ...event, time: 0, prev: previous });
      previous = sha256(line);
      return `${line}\n`;
    });
    const source = { trajectory, programs: base.programs };
    const directory = mkdtempSync(join(import.meta.dir, "../build/certificate-test-"));
    try {
      mkdirSync(join(directory, "store"));
      writeFileSync(join(directory, "trajectory.jsonl"), trajectory.join(""));
      for (const [hash, text] of Object.entries(source.programs))
        writeFileSync(join(directory, "store", `${hash}.ll`), text);
      const native = certify(directory, join(directory, "certificate"));
      const expected: Record<string, string> = {
        "manifest.json": readFileSync(join(native, "manifest.json"), "utf8"),
        "check.py": readFileSync(join(native, "check.py"), "utf8"),
      };
      for (const name of readdirSync(join(native, "programs")))
        expected[`programs/${name}`] = readFileSync(join(native, "programs", name), "utf8");
      expect(certificatePackage(source, checker)).toEqual({ outcome, files: expected });
      const altered = structuredClone(source);
      altered.programs[start.src] += "\n";
      expect(() => certificatePackage(altered, checker)).toThrow("has been altered");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("unknown runs do not claim a certificate", () => {
  const base = fixtures[0]?.source as ReportSource;
  expect(certificatePackage({ ...base, trajectory: base.trajectory.slice(0, 1) }, checker)).toEqual(
    { outcome: "unknown", files: {} },
  );
});
