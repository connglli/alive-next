// The scenarios, run twice for two different reasons.
//
// The first pass stands a yes-man in for alive2. It says nothing about whether
// any program refines any other, and is not meant to: what it tests is that
// the scripts still describe moves the framework can make, which is where a
// renamed slot or a changed refusal shows up, and it runs on a machine with no
// solver on it.
//
// The second pass is the real one, and needs alive-tv installed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Session } from "../core/session.ts";
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
const installed = await aliveTv
  .version()
  .then((line) => line.length > 0)
  .catch(() => false);

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

describe.skipIf(!built)("scenarios, with a stand-in checker", () => {
  for (const one of scenarios) {
    test(`${one.name} makes every move`, async () => {
      const checker = new YesMan();
      const session = await Session.start({
        dir,
        src: one.src,
        tgt: one.tgt,
        llops,
        checker,
        timeouts,
      });
      await one.prove(session);
      expect(session.finish()).toBe("verified");
      expect(checker.calls).toBeGreaterThan(0);

      // The tree is derived state, so a session picked back up has to be the
      // session that was put down.
      const again = Session.resume({ dir, llops, checker, timeouts });
      expect(shape(again)).toEqual(shape(session));
    });
  }
});

describe.skipIf(!built || !installed)("scenarios, checked by alive2", () => {
  for (const one of scenarios) {
    test(
      `${one.name} verifies`,
      async () => {
        const session = await Session.start({
          dir,
          src: one.src,
          tgt: one.tgt,
          llops,
          checker: aliveTv,
          timeouts,
        });
        await one.prove(session);
        expect(session.finish()).toBe("verified");
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
