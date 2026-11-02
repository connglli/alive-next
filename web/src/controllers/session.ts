import { INPUT_BYTES, INPUT_LABEL, validateBudget } from "../limits.ts";
import type { ReportSource, WorkerMessage } from "../protocol.ts";
import { Runtime } from "../services/runtime.ts";
import { checkOf, emptySession, type SessionState } from "../state.ts";

interface SessionEvents {
  changed(state: Readonly<SessionState>): void;
  inspected(gid: string, src: string, tgt: string): void;
}

interface SessionServices {
  // Narrow capabilities let lifecycle tests drive replies without a browser or Wasm.
  worker(): Worker;
  runtime: Pick<Runtime, "execute" | "kill" | "cancel">;
}

/** Own one search and its timers; views receive state, never worker handles. */
export class BrowserSession {
  private current = emptySession();
  // Large immutable programs and exact log lines live outside the frequently rendered UI state.
  private source: ReportSource = { trajectory: [], programs: {} };
  private input = "";
  private worker?: Worker;
  private readonly services: SessionServices;
  private started = 0;
  private deadline?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(
    private readonly events: SessionEvents,
    services?: SessionServices,
  ) {
    this.services = services ?? {
      worker: () => new Worker(new URL(SEARCH_WORKER_FILE, import.meta.url), { type: "module" }),
      runtime: new Runtime((loading) => {
        if (this.running) this.update({ status: { kind: "running", loading } });
      }),
    };
  }

  get state(): Readonly<SessionState> {
    return this.current;
  }
  get running() {
    return this.current.status.kind === "running";
  }
  /** Pair the current history with the original input captured at Run. */
  get snapshot() {
    return { source: this.source, module: this.input };
  }

  private update(change: Partial<SessionState>) {
    // Keep unchanged arrays and goal snapshots stable so views can reuse their DOM.
    this.current = { ...this.current, ...change };
    this.events.changed(this.current);
  }

  private clearTimers() {
    clearTimeout(this.deadline);
    clearInterval(this.ticker);
  }

  private dispose() {
    // Resource cleanup preserves recorded data; only reset or a new run discards it.
    this.worker?.terminate();
    this.worker = undefined;
    this.services.runtime.cancel();
    this.clearTimers();
  }

  /** Leave the previous input's scope, cancelling work and discarding its results. */
  reset() {
    this.dispose();
    this.source = { trajectory: [], programs: {} };
    this.input = "";
    this.current = emptySession();
    this.events.changed(this.current);
  }

  fail(error: unknown) {
    this.dispose();
    this.update({
      status: { kind: "error", message: String(error instanceof Error ? error.message : error) },
      inspectable: false,
    });
  }

  /** End an active search as unknown while retaining everything already recorded. */
  stop(reason: "user" | "timeout" = "user") {
    if (!this.running) return;
    this.dispose();
    this.update({
      status: { kind: "stopped", reason },
      elapsedMs: performance.now() - this.started,
      inspectable: false,
    });
  }

  inspect(gid: string) {
    this.worker?.postMessage({ type: "inspect", gid });
  }

  start(module: string, value: unknown) {
    if (this.running) return;
    try {
      const budget = validateBudget(value);
      this.dispose();
      this.source = { trajectory: [], programs: {} };
      this.input = module;
      this.current = emptySession();
      if (new TextEncoder().encode(module).length > INPUT_BYTES)
        throw new Error(`The input limit is ${INPUT_LABEL}.`);

      const worker = this.services.worker();
      this.worker = worker;
      this.started = performance.now();
      // This deadline includes loading and remains independent of synchronous Wasm.
      this.deadline = setTimeout(() => this.stop("timeout"), budget.ms);
      this.ticker = setInterval(
        () => this.update({ elapsedMs: performance.now() - this.started }),
        100,
      );
      worker.onerror = (event) => {
        event.preventDefault();
        if (this.worker === worker) this.fail(event.message);
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.fail("Cannot read the search response");
      };
      worker.onmessage = (event) => {
        void this.receive(worker, event.data as WorkerMessage);
      };
      // Establish ownership before publishing: a state listener may cancel the run.
      this.update({ status: { kind: "running" }, inspectable: true });
      if (this.worker === worker) worker.postMessage({ type: "run", module, budget });
    } catch (error) {
      this.fail(error);
    }
  }

  private async receive(worker: Worker, message: WorkerMessage) {
    // Termination can leave messages queued on the page from an older worker.
    if (this.worker !== worker) return;
    switch (message.type) {
      case "program":
        this.source.programs[message.hash] = message.text;
        break;
      case "trajectory":
        // Reserializing entries could change the bytes covered by their hash chain.
        this.source.trajectory.push(message.line);
        if (!this.current.hasReport) this.update({ hasReport: true });
        break;
      case "exec":
        try {
          const result = await this.services.runtime.execute(message.id, message.request);
          // A late result cannot update or reply to a replacement session.
          if (this.worker !== worker) return;
          const check = checkOf(message.request, result);
          if (check) this.update({ checks: [...this.current.checks, check] });
          worker.postMessage({ type: "execution", id: message.id, result });
        } catch (error) {
          if (this.worker === worker)
            worker.postMessage({
              type: "execution",
              id: message.id,
              error: String(error instanceof Error ? error.message : error),
            });
        }
        break;
      case "kill":
        this.services.runtime.kill(message.id);
        break;
      case "progress":
        // A settled worker stays alive for inspection; late progress cannot restart it.
        if (this.running)
          this.update({
            standing: message.state,
            status: { kind: "running", activity: message.activity },
          });
        break;
      case "result":
        this.clearTimers();
        // Retain the settled worker for inspection of its immutable program store.
        this.update({
          standing: message.state,
          status: { kind: "finished", verdict: message.verdict },
          elapsedMs: performance.now() - this.started,
        });
        break;
      case "error":
        this.fail(message.message);
        break;
      case "inspection":
        this.events.inspected(message.gid, message.src, message.tgt);
        break;
    }
  }
}
