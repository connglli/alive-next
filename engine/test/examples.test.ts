// The scenarios, run twice for two different reasons.
//
// The first pass stands a yes-man in for alive2. It says nothing about whether
// any program refines any other, and is not meant to: what it tests is that
// the scripts still describe moves the framework can make, which is where a
// renamed slot or a changed refusal shows up, and it runs on a machine with no
// solver on it. It leaves out the scenarios that end in a counterexample,
// since a checker that proves everything cannot reach one.
//
// The second pass is the real one, and needs alive-tv and llubi installed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { RunResult } from "../core/drivers/llubi.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import type { Checker } from "../core/state/steps.ts";
import { timeoutsFrom } from "../core/state/steps.ts";
import { scenarios } from "../examples/scenarios.ts";
import { toolchain } from "./toolchain-under-test.ts";

const config = loadConfig();
const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const timeouts = timeoutsFrom(config.timeouts);
const aliveTv = new AliveTv(toolchain.path("alive-tv"), timeouts.alive2Ms);
const llubi = new Llubi(toolchain.path("llubi"));
const installed = await Promise.all([aliveTv.version(), llubi.version()])
  .then((lines) => lines.every((line) => line.length > 0))
  .catch(() => false);

/** The interpreter of a session that will not report a counterexample. */
class NoRun implements Interpreter {
  async run(): Promise<RunResult> {
    throw new Error("this session has no interpreter");
  }
}

/** A checker that agrees with everything, so only the moves are under test. */
class YesMan implements Checker {
  calls = 0;
  async check(): Promise<CheckResult> {
    this.calls += 1;
    return {
      outcome: "correct",
      detail: "",
      invocation: { binary: "yes-man", flags: [], timeoutMs: 0 },
      stdout: "",
      ms: 0,
    };
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-e2e-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A yes-man proves everything, so it can only drive the scenarios that end
// verified; the counterexample ones need a refutation and an interpreter.
describe.skipIf(!built)("scenarios, with a stand-in checker", () => {
  for (const one of scenarios.filter((one) => (one.verdict ?? "verified") === "verified")) {
    test(`${one.name} makes every move`, async () => {
      const checker = new YesMan();
      const session = await Session.start({
        dir,
        src: one.src,
        tgt: one.tgt,
        llops,
        checker,
        interp: new NoRun(),
        timeouts,
      });
      await one.prove(session);
      expect(session.finish()).toBe("verified");
      expect(checker.calls).toBeGreaterThan(0);

      // The tree is derived state, so a session picked back up has to be the
      // session that was put down.
      const again = Session.resume({ dir, llops, checker, interp: new NoRun(), timeouts });
      expect(shape(again)).toEqual(shape(session));
    });
  }
});

describe.skipIf(!built || !installed)("scenarios, checked by the toolchain", () => {
  for (const one of scenarios) {
    test(
      `${one.name} reaches ${one.verdict ?? "verified"}`,
      async () => {
        const session = await Session.start({
          dir,
          src: one.src,
          tgt: one.tgt,
          llops,
          checker: aliveTv,
          interp: llubi,
          timeouts,
        });
        await one.prove(session);
        expect(session.finish()).toBe(one.verdict ?? "verified");
      },
      { timeout: timeouts.alive2Ms * 4 },
    );
  }
});

/** A session's tree as something two of them can be compared by. */
function shape(session: Session): unknown {
  return [...session.tree.goals.values()].map((goal) => ({
    id: goal.id,
    status: goal.status,
    src: goal.src.history,
    tgt: goal.tgt.history,
    children: goal.children,
  }));
}
