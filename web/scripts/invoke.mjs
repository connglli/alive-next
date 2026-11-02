// Run one Emscripten process in isolation; stdout belongs to the probe report.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { invoke } from "../src/wasm.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const started = performance.now();
const { default: create } = await import(pathToFileURL(process.argv[2]).href);
const wasmBinary = await readFile(process.argv[2].replace(/\.mjs$/, ".wasm"));
const result = await invoke(create, request, wasmBinary, started);

// Emscripten also sets Node's exit status; the guest status belongs in JSON.
process.exitCode = 0;
process.stdout.write(JSON.stringify(result));
