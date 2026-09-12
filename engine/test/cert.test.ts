// Assembling a certificate.
//
// What is under test is the manifest: which goals it keeps, what each chain
// says, and what it refuses to certify. Whether the proof holds is
// kernel/check.py's question, and kernel/check_test.py asks it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { type Counterexample, manifestOf, NotCertifiable, type Proof } from "../cert/manifest.ts";
import { loadConfig } from "../core/config.ts";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt, LlrwtInvocation } from "../core/drivers/llrwt.ts";
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

/**
 * A checker that agrees, so what is left under test is the bookkeeping. It
 * reports the options it was handed, as the real one does, because what the
 * manifest keeps is the invocation that happened.
 */
class YesMan implements Checker {
  async check(
    _src: string,
    _tgt: string,
    options?: { timeoutMs?: number; flags?: string[] },
  ): Promise<CheckResult> {
    const timeoutMs = options?.timeoutMs ?? 5000;
    return {
      outcome: "correct",
      detail: "",
      invocation: {
        binary: "yes-man",
        flags: [`--smt-to=${timeoutMs}`, ...(options?.flags ?? [])],
        timeoutMs,
      },
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

/** A stand-in for llrwt that folds to the module it was given. */
function folding(folded: string): Llrwt {
  return {
    async apply(module: string, rules: string[]) {
      const invocation: LlrwtInvocation = { binary: "fake-llrwt", rules: [...rules], timeoutMs: 0 };
      return { ok: true as const, module: folded, changed: folded !== module, invocation };
    },
  } as unknown as Llrwt;
}

/** A checker that refutes everything, so a run can start refuted. */
class NoMan implements Checker {
  constructor(private readonly stdout: string = "") {}
  async check(): Promise<CheckResult> {
    return {
      outcome: "incorrect",
      detail: "Value mismatch",
      invocation: { binary: "no-man", flags: [], timeoutMs: 0 },
      stdout: this.stdout,
      ms: 0,
    };
  }
}

/** A body with an addition of zero for the rewriter to fold away. */
const ADD_ZERO = `define i32 @f(i32 %x) {
entry:
  %s = add i32 %x, 0
  ret i32 %s
}
`;

const FOLDED = `define i32 @f(i32 %x) {
entry:
  ret i32 %x
}
`;

/** A body long enough that an edit to one line of it is a window. */
const WIDE = `define i32 @f(i32 %x, i32 %y) {
entry:
  %h = lshr i32 %x, 4
  %g = add i32 %h, %y
  %s = mul i32 %g, 2
  %t = add i32 %s, 1
  ret i32 %t
}
`;

/** Counts the runs the stand-in interpreter was asked for, src then tgt. */
let diverging = 0;

/** A stand-in for llrwt that refuses any use, for tests that never rewrite. */
const unrewriting = {
  apply: async () => ({
    ok: false as const,
    code: "unavailable",
    message: "unused in this test",
  }),
} as unknown as Llrwt;

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
    rewriter: unrewriting,
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
        if (step.kind === "strengthen") {
          expect(step.from).toEqual({ src, tgt });
          src = step.to.src;
          tgt = step.to.tgt;
        } else {
          expect(step.from).toBe(step.side === "src" ? src : tgt);
          if (step.side === "src") src = step.to;
          else tgt = step.to;
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
    expect(only.param_attrs).toEqual({ 0: { noundef: true, range: { min: 0, max: 256 } } });
    // The step it names is a step of the outer's chain, which is checked.
    expect(only.by?.gid).toBe("g2");
    const outer = manifest.goals.g2?.steps ?? [];
    expect(outer.some((step) => step.kind === "check" && step.to === only.by?.hash)).toBe(true);
  });

  test("records a narrowed step as the three halves it was cut into", async () => {
    // The commit below touches one instruction of a longer body, so it is
    // certified from the window and the manifest has to say so: a checker that
    // reran the whole pair instead would be asking a different question.
    const session = await Session.start({
      dir: join(dir, "narrowed"),
      src: WIDE,
      tgt: WIDE.replace("mul i32 %g, 2", "shl i32 %g, 1"),
      llops,
      checker: new YesMan(),
      interp: noRun,
      rewriter: unrewriting,
    });
    await session.begin("g1", "src");
    // The same value in and the same value out, so the window is one line.
    await session.edit({ op: "replace", v: "%4", insts: ["%s = shl i32 %3, 1"] });
    const step = await session.commit();
    if (step.kind !== "certified") throw new Error("expected the commit to land");
    expect(step.by).toBe("window");
    expect(session.finish()).toBe("verified");

    const out = certify(session.dir, join(dir, "certificate"));
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Proof;
    const [only] = manifest.goals.g1?.steps ?? [];
    if (only?.kind !== "window") throw new Error("expected a window step");
    expect(only.window.callee).toBe("outlined_window");
    // Its three halves travel with the package, since a replay reads them.
    for (const hash of [only.window.outer, only.window.from, only.window.to]) {
      expect(readFileSync(join(out, "programs", `${hash}.ll`), "utf8").length).toBeGreaterThan(0);
    }
  });

  test("records a rewrite as the rules it ran, for a replay without a solver", async () => {
    const session = await Session.start({
      dir: join(dir, "rewritten"),
      src: ADD_ZERO,
      tgt: FOLDED,
      llops,
      checker: new YesMan(),
      interp: noRun,
      rewriter: folding(FOLDED),
    });
    const rewritten = await session.rewrite("g1", "src", ["addi-zero-to-x"]);
    if (rewritten.kind !== "certified") throw new Error("expected the rewrite to land");
    expect(session.finish()).toBe("verified");

    const manifest = manifestFrom(session.dir);
    const [only] = manifest.goals.g1?.steps ?? [];
    if (only?.kind !== "rewrite") throw new Error("expected a rewrite step");
    expect(only.side).toBe("src");
    expect(only.rules).toEqual(["addi-zero-to-x"]);
    expect(only.invocation).toMatchObject({ binary: "fake-llrwt", rules: ["addi-zero-to-x"] });
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
      rewriter: unrewriting,
    });
    const input = [{ kind: "int", value: "-3" } as const];
    const reported = await session.reportCex(input);
    expect(reported.kind).toBe("refuted");
    expect(session.finish()).toBe("counterexample");

    const manifest = JSON.parse(
      readFileSync(join(certify(session.dir, join(dir, "cex")), "manifest.json"), "utf8"),
    ) as Counterexample;
    expect(manifest.verdict).toBe("counterexample");
    expect(manifest.source).toBe("llubi");
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
      rewriter: unrewriting,
    });
    session.finish();
    const entries = parse(readFileSync(join(session.dir, "trajectory.jsonl"), "utf8"));
    expect(() => manifestOf(entries, derive(entries))).toThrow(NotCertifiable);
    expect(() => manifestOf(entries, derive(entries))).toThrow(/the root is open/);
  });

  test("certifies a root the start check proved, with no steps at all", async () => {
    const session = await Session.start({
      dir: join(dir, "auto-proved"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new YesMan(),
      interp: noRun,
      rewriter: unrewriting,
      eager: true,
    });
    expect(session.finish()).toBe("verified");

    const manifest = JSON.parse(
      readFileSync(join(certify(session.dir, join(dir, "auto-ok")), "manifest.json"), "utf8"),
    ) as Proof;
    expect(manifest.verdict).toBe("verified");
    const [goal] = Object.values(manifest.goals);
    if (!goal) throw new Error("the proof has no goal");
    expect(goal.steps).toEqual([]);
    expect(goal.start).toEqual(goal.end);
  });

  test("a start check's counterexample ships the pair and no input", async () => {
    // The interpreter refuses, so nothing was replayed and the check alone
    // refutes the run.
    const session = await Session.start({
      dir: join(dir, "auto-refuted"),
      src: miscompile.src,
      tgt: miscompile.tgt,
      llops,
      checker: new NoMan(),
      interp: noRun,
      rewriter: unrewriting,
      eager: true,
    });
    expect(session.finish()).toBe("counterexample");

    const manifest = JSON.parse(
      readFileSync(join(certify(session.dir, join(dir, "auto-cex")), "manifest.json"), "utf8"),
    ) as Counterexample;
    expect(manifest.verdict).toBe("counterexample");
    expect(manifest.source).toBe("alive2");
    expect(manifest.input).toBeUndefined();
    // What the checker printed travels with the package.
    expect(manifest.divergence).toBe("Value mismatch");
    const tree = session.tree.goals.get("g1");
    expect(manifest.pair).toEqual({
      src: tree?.src.history[0] as string,
      tgt: tree?.tgt.history[0] as string,
    });
    for (const side of ["src", "tgt"] as const) {
      expect(
        readFileSync(join(dir, "auto-cex", "programs", `${manifest.pair[side]}.ll`), "utf8").length,
      ).toBeGreaterThan(0);
    }
  });

  test("a start check's counterexample carries no input, parseable or not", async () => {
    // The search for a whole-program input stays the agent's problem, so the
    // checker's example text is never lifted into one. The interpreter refuses
    // if the replay ran.
    const example = `ERROR: Value mismatch

Example:
i32 noundef %x = #xfffffffb (4294967291, -5)

Source:
i32 %h = #xfffffffe (4294967294, -2)

Target:
i32 %h = #xfffffffd (4294967293, -3)

Summary:
  0 correct transformations
  1 incorrect transformations
  0 failed-to-prove transformations
  0 Alive2 errors
`;
    const session = await Session.start({
      dir: join(dir, "auto-parseable"),
      src: miscompile.src,
      tgt: miscompile.tgt,
      llops,
      checker: new NoMan(example),
      interp: noRun,
      rewriter: unrewriting,
      eager: true,
    });
    expect(session.finish()).toBe("counterexample");

    const manifest = JSON.parse(
      readFileSync(
        join(certify(session.dir, join(dir, "auto-parseable-cex")), "manifest.json"),
        "utf8",
      ),
    ) as Counterexample;
    expect(manifest.verdict).toBe("counterexample");
    expect(manifest.source).toBe("alive2");
    expect(manifest.input).toBeUndefined();
    // What the checker printed travels with the package.
    expect(manifest.divergence).toBe("Value mismatch");
  });

  test("an executed input supersedes a checker counterexample in the manifest", async () => {
    let diverging = 0;
    const session = await Session.start({
      dir: join(dir, "superseded"),
      src: miscompile.src,
      tgt: miscompile.tgt,
      llops,
      // The checker refutes without a parseable example, so the eager check
      // falls back to the checker's answer (source alive2). Then report_cex
      // offers a concrete input the interpreter confirms, and the manifest
      // carries that one instead.
      checker: new NoMan(),
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
      rewriter: unrewriting,
      eager: true,
    });
    expect(session.verdict).toBe("counterexample");

    const input = [{ kind: "int", value: "-3" } as const];
    const reported = await session.reportCex(input);
    expect(reported.kind).toBe("refuted");

    const manifest = JSON.parse(
      readFileSync(
        join(certify(session.dir, join(dir, "superseded-cex")), "manifest.json"),
        "utf8",
      ),
    ) as Counterexample;
    expect(manifest.source).toBe("llubi");
    expect(manifest.input).toEqual(input);
    expect(manifest.divergence).toContain("i32 -1 in the src and i32 -2 in the tgt");
  });
});
