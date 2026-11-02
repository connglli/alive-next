import type { Execution, ProcessResult } from "../protocol.ts";
import { existsSync, readFileSync } from "./fs.ts";

export interface Job {
  result: Promise<ProcessResult>;
  kill(): void;
}

// Match the Bun.spawn subset consumed by the unchanged native tool drivers.
export function spawnWith(execute: (request: Execution) => Job) {
  return (argv: string[], options: { stdin?: string | Uint8Array } = {}) => {
    const tool = argv[0];
    if (tool !== "llops" && tool !== "alive-tv")
      throw new Error(`Unavailable browser tool: ${tool}`);

    const args = argv.slice(1);
    // Copy file arguments into the checker's separate Emscripten filesystem.
    const files = Object.fromEntries(
      args.filter(existsSync).map((path) => [path, readFileSync(path)]),
    );
    const input = options.stdin;
    const stdin = typeof input === "string" ? input : input ? new TextDecoder().decode(input) : "";
    const job = execute({ tool, args, stdin, files });

    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        out = controller;
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        err = controller;
      },
    });

    const child = {
      stdout,
      stderr,
      exitCode: null as number | null,
      kill: job.kill,
      exited: Promise.resolve(0),
    };

    // Drivers await exit and read streams, while worker RPC returns one result.
    child.exited = job.result.then(
      (result) => {
        child.exitCode = result.exit;
        out.enqueue(new TextEncoder().encode(result.stdout));
        out.close();
        err.enqueue(new TextEncoder().encode(result.stderr));
        err.close();
        return result.exit;
      },
      (error) => {
        out.error(error);
        err.error(error);
        throw error;
      },
    );

    return child;
  };
}
