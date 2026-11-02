import type { Execution } from "./protocol.ts";
import { invoke } from "./wasm.mjs";

// One command per worker isolates LLVM registries and solver globals.
self.onmessage = async (
  event: MessageEvent<Execution & { module: WebAssembly.Module; glue: string }>,
) => {
  try {
    const { module, glue, args, stdin, files } = event.data;
    const started = performance.now();
    const { default: create } = await import(glue);
    const result = await invoke(create, { args, stdin, files }, module, started);

    postMessage({ result });
  } catch (error) {
    postMessage({ error: String(error instanceof Error ? error.message : error) });
  }
};
