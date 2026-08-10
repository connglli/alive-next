// Assembling a certificate.
//
// What is under test is the manifest: which goals it keeps, what each chain
// says, and what it refuses to certify. Whether the proof holds is
// scripts/check.py's question, and scripts/check_test.py asks it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { type Counterexample, manifestOf, NotCertifiable, type Proof } from "../cert/manifest.ts";
import { loadConfig } from "../core/config.ts";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { RunResult } from "../core/drivers/llubi.ts";
import type { Scenario } from "../core/scenario.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { derive } from "../core/state/goals.ts";
import type { Checker } from "../core/state/steps.ts";
import { parse } from "../core/state/trajectory.ts";
import { cut } from "../examples/cut.ts";
import { miscompile } from "../examples/miscompile.ts";
import { strengthen } from "../examples/strengthen.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** A checker that agrees, so what is left under test is the bookkeeping. */
class YesMan implements Checker {
  async check(): Promise<CheckResult> {
    return {
      outcome: "correct",
      detail: "",
      invocation: { binary: "yes-man", flags: ["--smt-to=5000"], timeoutMs: 5000 },
      stdout: "",
      ms: 0,
    };
  }
}

/** No scenario here reports a counterexample, so nothing runs a program. */
const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};

/** Counts the runs the stand-in interpreter was asked for, src then tgt. */
let diverging = 0;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-cert-"));
  diverging = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Prove a scenario into a session, and answer with the session directory. */
async function prove(scenario: Scenario): Promise<string> {
  const session = await Session.start({
    dir: join(dir, "session"),
    src: scenario.src,
    tgt: scenario.tgt,
    llops,
    checker: new YesMan(),
    interp: noRun,
    config: loadConfig(),
  });
  await scenario.prove(session);
  session.finish();
  return join(dir, "session");
}

function manifestFrom(session: string): Proof {
  const out = certify(session, join(dir, "certificate"));
  return JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Proof;
}

describe.skipIf(!built)("the manifest", () => {
  test("keeps the goals that discharged the root, and their chains", async () => {
    const manifest = manifestFrom(await prove(cut));
    expect(manifest.verdict).toBe("verified");
    expect(Object.keys(manifest.goals).sort()).toEqual(["g1", "g2", "g3"]);

    const root = manifest.goals.g1;
    if (root?.discharge.kind !== "split") throw new Error("the root was cut");
    expect(root.discharge).toMatchObject({ outer: "g2", inner: "g3", callee: "outlined_g3" });
    // The pair a goal proves about is the one it started with, and the chain
    // has to arrive at the one it ended with.
    for (const goal of Object.values(manifest.goals)) {
      let src = goal.start.src;
      let tgt = goal.start.tgt;
      for (const step of goal.steps) {
        if (step.kind === "checked") {
          expect(step.from).toBe(step.side === "src" ? src : tgt);
          if (step.side === "src") src = step.to;
          else tgt = step.to;
        } else {
          expect(step.from).toEqual({ src, tgt });
          src = step.to.src;
          tgt = step.to.tgt;
        }
      }
      expect({ src, tgt }).toEqual(goal.end);
    }
  });

  test("records an attribute as the claim it is, naming what stands behind it", async () => {
    const manifest = manifestFrom(await prove(strengthen));
    const callee = manifest.goals.g3;
    const attributed = callee?.steps.filter((step) => step.kind === "strengthen") ?? [];
    expect(attributed).toHaveLength(1);
    const [only] = attributed;
    if (only?.kind !== "strengthen") throw new Error("a strengthen step");
    // The step it names is a step of the outer's chain, which is checked.
    expect(only.by.gid).toBe("g2");
    const outer = manifest.goals.g2?.steps ?? [];
    expect(outer.some((step) => step.kind === "checked" && step.to === only.by.hash)).toBe(true);
  });

  test("carries the flags a check was run with, and not its timeout", async () => {
    const manifest = manifestFrom(await prove(cut));
    for (const goal of Object.values(manifest.goals)) {
      for (const step of goal.steps) {
        if (step.kind === "checked") expect(step.flags).toEqual([]);
      }
    }
  });

  test("copies every program the proof names", async () => {
    const session = await prove(cut);
    const out = certify(session, join(dir, "certificate"));
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Proof;
    for (const goal of Object.values(manifest.goals)) {
      for (const pair of [goal.start, goal.end]) {
        for (const side of ["src", "tgt"] as const) {
          expect(
            readFileSync(join(out, "programs", `${pair[side]}.ll`), "utf8").length,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  test("a refuted run ships the pair it was asked about and the input", async () => {
    // The interpreter is a stand-in: what is under test is what the manifest
    // keeps, and whether the two runs really diverge is check.py's question.
    const session = await Session.start({
      dir: join(dir, "refuted"),
      src: miscompile.src,
      tgt: miscompile.tgt,
      llops,
      checker: new YesMan(),
      interp: {
        async run(): Promise<RunResult> {
          diverging += 1;
          return {
            outcome: "returned",
            observations: { "%obs.result": diverging === 1 ? "i32 -1" : "i32 -2" },
            reason: "",
            trace: "",
            ms: 1,
          };
        },
      },
    });
    const input = [{ kind: "int", value: "-3" } as const];
    const reported = await session.reportCex(input);
    expect(reported.kind).toBe("refuted");
    expect(session.finish()).toBe("counterexample");

    const manifest = JSON.parse(
      readFileSync(join(certify(session.dir, join(dir, "cex")), "manifest.json"), "utf8"),
    ) as Counterexample;
    expect(manifest.verdict).toBe("counterexample");
    expect(manifest.input).toEqual(input);
    expect(manifest.divergence).toContain("i32 -1 in the src and i32 -2 in the tgt");
    // The pair is the one the run started from, and both programs travel.
    const tree = session.tree.goals.get("g1");
    expect(manifest.pair).toEqual({
      src: tree?.src.history[0] as string,
      tgt: tree?.tgt.history[0] as string,
    });
    for (const side of ["src", "tgt"] as const) {
      expect(
        readFileSync(join(dir, "cex", "programs", `${manifest.pair[side]}.ll`), "utf8").length,
      ).toBeGreaterThan(0);
    }
  });

  test("refuses a run that proved nothing", async () => {
    const session = await Session.start({
      dir: join(dir, "open"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new YesMan(),
      interp: noRun,
    });
    session.finish();
    const entries = parse(readFileSync(join(session.dir, "trajectory.jsonl"), "utf8"));
    expect(() => manifestOf(entries, derive(entries))).toThrow(NotCertifiable);
    expect(() => manifestOf(entries, derive(entries))).toThrow(/the root is open/);
  });
});
