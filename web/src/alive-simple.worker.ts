// A standalone command interface around the unchanged alive-simple searcher.
import { AliveTv } from "../../engine/core/drivers/alive2.ts";
import { Llops } from "../../engine/core/drivers/llops.ts";
import { Llrwt } from "../../engine/core/drivers/llrwt.ts";
import { Session } from "../../engine/core/session.ts";
import { DEFAULT_LIMITS } from "../../engine/simple/limits.ts";
import { search } from "../../engine/simple/search.ts";
import { CHECK_MS, INPUT_BYTES, INPUT_LABEL, validateBudget } from "./limits.ts";
import { observeAppends } from "./platform/fs.ts";
import { spawnWith } from "./platform/process.ts";
import type { Execution, ProcessResult, Standing, WorkerMessage } from "./protocol.ts";

let serial = 0;
let session: Session | undefined;
const pending = new Map<
  number,
  { resolve(result: ProcessResult): void; reject(error: Error): void }
>();

function send(message: WorkerMessage) {
  postMessage(message);
}

// The page owns checker workers so it can enforce Stop during synchronous Wasm.
function execute(request: Execution) {
  const id = ++serial;
  const result = new Promise<ProcessResult>((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );

  send({ type: "exec", id, request });
  return { result, kill: () => send({ type: "kill", id }) };
}

// Preserve the native driver's spawn and scratch-directory interfaces.
Object.assign(globalThis, { Bun: { spawn: spawnWith(execute) }, process: { pid: 1 } });

// Keep progress small; fetch the two IR modules only when a goal is inspected.
function standing(): Standing {
  if (!session) return { goals: [] };

  const tree = session.tree;
  return {
    goals: [...tree.goals.values()].map((goal) => ({
      id: goal.id,
      parent: goal.parent,
      role: goal.role,
      status: goal.status,
    })),
  };
}

observeAppends((_path, text) => {
  const event = JSON.parse(text) as { kind: string; tool?: string };
  if (event.kind !== "tool_result") return;

  // Observe the goal tree after the engine finishes the synchronous log append.
  queueMicrotask(() => {
    if (session) send({ type: "progress", state: standing(), activity: event.tool ?? "search" });
  });
});

async function prove(module: string, value: unknown) {
  const budget = validateBudget(value);
  if (new TextEncoder().encode(module).length > INPUT_BYTES)
    throw new Error(`The input limit is ${INPUT_LABEL}`);

  // LLVM performs the split so shared declarations and attributes retain meaning.
  const splitResult = await execute({
    tool: "llops",
    args: ["split"],
    stdin: JSON.stringify({ module }),
    files: {},
  }).result;

  const split = JSON.parse(splitResult.stdout) as {
    ok: boolean;
    src: string;
    tgt: string;
    message?: string;
  };
  if (!split.ok) throw new Error(split.message ?? "Cannot split the input module");

  const llops = new Llops("llops");
  session = await Session.start({
    dir: "/run",
    llops,
    checker: new AliveTv("alive-tv", CHECK_MS),
    rewriter: new Llrwt("llrwt"),
    // Returning an error leaves alive2 as the browser's only refutation checker.
    interp: {
      run: async () => ({
        outcome: "error",
        observations: {},
        reason: "Concrete replay is unavailable in the browser",
        trace: "",
        ms: 0,
      }),
    },
    timeouts: {
      checkDefaultMs: CHECK_MS,
      checkCapMs: CHECK_MS,
      eagerCheckMs: 300,
      llrwtMs: CHECK_MS,
    },
    src: split.src,
    tgt: split.tgt,
  });

  send({ type: "progress", state: standing(), activity: "search" });
  await search(session, llops, {
    ...DEFAULT_LIMITS,
    ...budget,
    rootMs: CHECK_MS,
    counterexampleMs: 200,
    // The verified-rule executable is unavailable in this browser build.
    rules: false,
  });

  send({ type: "result", verdict: session.finish(), state: standing() });
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (data.type === "execution") {
    const call = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) call?.reject(new Error(data.error));
    else call?.resolve(data.result);
  } else if (data.type === "run") {
    prove(data.module, data.budget).catch((error) =>
      send({ type: "error", message: String(error.message ?? error) }),
    );
  } else if (data.type === "inspect" && session) {
    const goal = session.tree.goals.get(data.gid);
    if (goal)
      send({
        type: "inspection",
        gid: goal.id,
        src: session.store.get(goal.src.history.at(-1) as string),
        tgt: session.store.get(goal.tgt.history.at(-1) as string),
      });
  }
};
