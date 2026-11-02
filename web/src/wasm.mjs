// One command runner for the Node probe and browser subprocess workers.
/**
 * @typedef {{callMain(args: string[]): number, HEAPU8: Uint8Array,
 * FS: {mkdirTree(path: string): void, writeFile(path: string, text: string): void}}} Instance
 */

/**
 * @param {(options: Record<string, unknown>) => Promise<Instance>} create
 * @param {{args: string[], stdin?: string, files?: Record<string, string>}} request
 * @param {Uint8Array | WebAssembly.Module} binary
 * @param {number} started
 */
export async function invoke(create, request, binary, started = performance.now()) {
  /** @type {string[]} */ const stdout = [];
  /** @type {string[]} */ const stderr = [];
  const input = new TextEncoder().encode(request.stdin ?? "");
  let offset = 0;

  // Delay main until stdin and scratch files are ready for the native command.
  /** @type {Record<string, unknown>} */
  const options = {
    noInitialRun: true,
    stdin: () => (offset < input.length ? input[offset++] : null),
    print: stdout.push.bind(stdout),
    printErr: stderr.push.bind(stderr),
  };

  if (binary instanceof WebAssembly.Module) {
    // Reuse compiled code while giving each command its own globals and memory.
    /**
     * @param {WebAssembly.Imports} imports
     * @param {(instance: WebAssembly.Instance, module: WebAssembly.Module) => void} receive
     */
    options.instantiateWasm = (imports, receive) => {
      const instance = new WebAssembly.Instance(binary, imports);
      receive(instance, binary);
      return instance.exports;
    };
  } else options.wasmBinary = binary;

  const tool = await create(options);
  for (const [path, text] of Object.entries(request.files ?? {})) {
    const end = path.lastIndexOf("/");
    if (end > 0) tool.FS.mkdirTree(path.slice(0, end));
    tool.FS.writeFile(path, text);
  }

  // Probes report instantiation separately from command execution.
  const ready = performance.now();
  const exit = tool.callMain(request.args);
  const ended = performance.now();

  return {
    exit,
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    ms: ended - started,
    loadMs: ready - started,
    runMs: ended - ready,
    linearMemoryBytes: tool.HEAPU8.buffer.byteLength,
  };
}
