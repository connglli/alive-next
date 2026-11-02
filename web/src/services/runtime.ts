import type { Execution, ProcessResult, Tool } from "../protocol.ts";

type Assets = Record<Tool, { glue: string; wasm: string }>;

interface Job {
  worker?: Worker;
  finish(result: ProcessResult): void;
}

// The page owns subprocess workers so Stop can terminate a blocking checker.
export class Runtime {
  private readonly modules = new Map<Tool, Promise<{ module: WebAssembly.Module; glue: string }>>();
  private manifest?: Promise<Assets>;
  private readonly jobs = new Map<number, Job>();

  constructor(private readonly loading: (message: string) => void) {}

  private assets() {
    if (!this.manifest) {
      const manifest: Promise<Assets> = fetch(new URL(CHECKERS_MANIFEST, import.meta.url)).then(
        (response) => {
          if (!response.ok)
            throw new Error("Checker assets are missing. Rebuild or reload the site.");
          return response.json();
        },
      );

      this.manifest = manifest;
      // A transient network failure must allow the next run to retry.
      manifest.catch(() => {
        if (this.manifest === manifest) this.manifest = undefined;
      });
    }

    return this.manifest;
  }

  private load(tool: Tool) {
    const cached = this.modules.get(tool);
    if (cached) return cached;

    // Cache compilation, while each command receives a fresh Wasm instance.
    const result = (async () => {
      this.loading(`Loading ${tool}… First use downloads the checker.`);
      const asset = (await this.assets())[tool];
      const response = await fetch(new URL(asset.wasm, import.meta.url));
      if (!response.ok)
        throw new Error(`Cannot load ${tool}: HTTP ${response.status}. Reload the site.`);

      let bytes = await response.arrayBuffer();
      const magic = new Uint8Array(bytes);

      // Some hosts set Content-Encoding for .gz files; fetch then decompresses.
      if (magic[0] === 0x1f && magic[1] === 0x8b) {
        bytes = await new Response(
          new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
        ).arrayBuffer();
      }

      return {
        module: await WebAssembly.compile(bytes),
        glue: new URL(asset.glue, import.meta.url).href,
      };
    })();

    this.modules.set(tool, result);
    result.catch(() => {
      if (this.modules.get(tool) === result) this.modules.delete(tool);
    });

    return result;
  }

  execute(id: number, request: Execution): Promise<ProcessResult> {
    if (this.jobs.has(id)) return Promise.reject(new Error(`Duplicate checker request ${id}`));

    return new Promise((resolve, reject) => {
      // Identity, rather than the reusable request ID, rejects late callbacks.
      const active = () => this.jobs.get(id) === job;

      const close = () => {
        job.worker?.terminate();
        this.jobs.delete(id);
      };

      const fail = (error: unknown) => {
        if (active()) {
          close();
          reject(error);
        }
      };

      const job: Job = {
        finish: (result) => {
          if (active()) {
            close();
            resolve(result);
          }
        },
      };

      this.jobs.set(id, job);
      this.load(request.tool)
        .then(({ module, glue }) => {
          // A download can finish after this checker request has been cancelled.
          if (!active()) return;

          const worker = new Worker(new URL(TOOL_WORKER_FILE, import.meta.url), { type: "module" });
          job.worker = worker;
          worker.onmessage = (event) =>
            event.data.error ? fail(new Error(event.data.error)) : job.finish(event.data.result);
          worker.onerror = (event) => {
            event.preventDefault();
            fail(new Error(event.message));
          };
          worker.onmessageerror = () => fail(new Error("Cannot read the checker response"));
          worker.postMessage({ ...request, module, glue });
        })
        .catch(fail);
    });
  }

  kill(id: number) {
    // Return a process exit so checker drivers can finish their timeout handling.
    this.jobs.get(id)?.finish({ exit: 143, stdout: "", stderr: "Stopped", ms: 0 });
  }

  cancel() {
    for (const id of [...this.jobs.keys()]) this.kill(id);
  }
}
