import { afterEach, expect, test } from "bun:test";
import { EditorController } from "../src/controllers/editor.ts";
import { BrowserSession } from "../src/controllers/session.ts";
import { DEFAULT_BUDGET, INPUT_BYTES } from "../src/limits.ts";
import type { ProcessResult, WorkerMessage } from "../src/protocol.ts";

const sessions: BrowserSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.reset();
});

function harness(changed: ConstructorParameters<typeof BrowserSession>[0]["changed"] = () => {}) {
  const workers: {
    port: Worker;
    sent: unknown[];
    terminated: boolean;
    emit(message: WorkerMessage): void;
  }[] = [];
  const pending: ((result: ProcessResult) => void)[] = [];
  // Pending replies deliberately survive cancel() to exercise the controller's stale guards.
  const runtime = {
    execute: () => new Promise<ProcessResult>((resolve) => pending.push(resolve)),
    kill: () => {},
    cancel: () => {},
  };
  const session = new BrowserSession(
    { changed, inspected: () => {} },
    {
      runtime,
      worker: () => {
        const sent: unknown[] = [];
        const item = {
          sent,
          terminated: false,
          port: undefined as unknown as Worker,
          emit(message: WorkerMessage) {
            item.port.onmessage?.call(item.port, new MessageEvent("message", { data: message }));
          },
        };
        item.port = {
          onmessage: null,
          onerror: null,
          onmessageerror: null,
          postMessage: (message: unknown) => sent.push(message),
          terminate: () => {
            item.terminated = true;
          },
        } as unknown as Worker;
        workers.push(item);
        return item.port;
      },
    },
  );
  sessions.push(session);
  return { session, workers, pending };
}

test("late checker replies cannot modify or reply to a replacement run", async () => {
  const { session, workers, pending } = harness();
  session.start("old input", DEFAULT_BUDGET);
  const old = workers[0] as (typeof workers)[number];
  old.emit({ type: "exec", id: 1, request: { tool: "alive-tv", args: [], stdin: "", files: {} } });
  session.reset();
  session.start("new input", DEFAULT_BUDGET);
  pending[0]?.({ exit: 0, stdout: "stale checker output", stderr: "", ms: 1 });
  await Promise.resolve();
  expect(old.terminated).toBe(true);
  expect(old.sent).toHaveLength(1);
  expect(session.state.checks).toEqual([]);
  expect(session.snapshot.module).toBe("new input");
});

test("Stop retains session history while closing the search worker", () => {
  const { session, workers } = harness();
  session.start("input", DEFAULT_BUDGET);
  workers[0]?.emit({ type: "program", hash: "hash", text: "program" });
  workers[0]?.emit({ type: "trajectory", line: "recorded entry\n" });
  session.stop();
  expect(session.state.status).toEqual({ kind: "stopped", reason: "user" });
  expect(session.state.inspectable).toBe(false);
  expect(session.state.hasReport).toBe(true);
  expect(session.snapshot.source).toEqual({
    programs: { hash: "program" },
    trajectory: ["recorded entry\n"],
  });
  expect(workers[0]?.terminated).toBe(true);
});

test("settled runs remain inspectable and late progress cannot restart them", () => {
  const { session, workers } = harness();
  session.start("input", DEFAULT_BUDGET);
  workers[0]?.emit({ type: "result", verdict: "verified", state: { goals: [] } });
  workers[0]?.emit({ type: "progress", activity: "late", state: { goals: [] } });
  session.inspect("g1");
  expect(session.state.status).toEqual({ kind: "finished", verdict: "verified" });
  expect(session.state.inspectable).toBe(true);
  expect(workers[0]?.terminated).toBe(false);
  expect(workers[0]?.sent.at(-1)).toEqual({ type: "inspect", gid: "g1" });
});

test("the run deadline stops its worker and reports timeout", async () => {
  let finished!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const { session, workers } = harness((state) => {
    if (state.status.kind === "stopped") finished();
  });
  session.start("input", { ...DEFAULT_BUDGET, ms: 10 });
  await stopped;
  expect(session.state.status).toEqual({ kind: "stopped", reason: "timeout" });
  expect(workers[0]?.terminated).toBe(true);
});

test("cancellation from a state listener cannot start a disposed worker", () => {
  let active!: BrowserSession;
  const { session, workers } = harness((state) => {
    if (state.status.kind === "running") active.reset();
  });
  active = session;
  session.start("input", DEFAULT_BUDGET);
  expect(workers[0]?.terminated).toBe(true);
  expect(workers[0]?.sent).toEqual([]);
  expect(session.state.status).toEqual({ kind: "ready" });
});

test("a file read that finishes after Run starts cannot overwrite its input", async () => {
  let finish!: (text: string) => void;
  let value = "";
  let changes = 0;
  const editor = new EditorController(
    {
      render: (text) => {
        value = text;
      },
      setRunning: () => {},
    },
    {
      changed: () => {
        changes++;
      },
      failed: (error) => {
        throw error;
      },
    },
  );
  const original = value;
  const file = {
    size: 1,
    text: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  } as File;
  const loading = editor.load(file);
  editor.setRunning(true);
  finish("obsolete file");
  await loading;
  expect(editor.text).toBe(original);
  expect(value).toBe(original);
  expect(changes).toBe(0);
});

test("file selections delivered while the editor is locked do not interrupt a run", async () => {
  const errors: unknown[] = [];
  const editor = new EditorController(
    { render: () => {}, setRunning: () => {} },
    {
      changed: () => {
        throw new Error("Unexpected input change");
      },
      failed: (error) => errors.push(error),
    },
  );
  editor.setRunning(true);
  await editor.load({
    size: INPUT_BYTES + 1,
    text: () => {
      throw new Error("Unexpected read");
    },
  } as unknown as File);
  expect(errors).toEqual([]);
});
