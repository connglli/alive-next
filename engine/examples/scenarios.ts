// Every scenario, in the order they are worth reading: each one adds a single
// mechanism to the one before it.

import type { Scenario } from "../core/scenario.ts";
import { branch } from "./branch.ts";
import { cut } from "./cut.ts";
import { freeze } from "./freeze.ts";
import { induction } from "./induction.ts";
import { loop } from "./loop.ts";
import { loopbranch } from "./loopbranch.ts";
import { miscompile } from "./miscompile.ts";
import { nested } from "./nested.ts";
import { nuw } from "./nuw.ts";
import { pipeline } from "./pipeline.ts";
import { poison } from "./poison.ts";
import { predicate } from "./predicate.ts";
import { reassociate } from "./reassociate.ts";
import { rewrite } from "./rewrite.ts";
import { rotated } from "./rotated.ts";
import { rule } from "./rule.ts";
import { strengthReduce } from "./strength-reduce.ts";
import { strengthen } from "./strengthen.ts";
import { unroll } from "./unroll.ts";
import { vectorize } from "./vectorize.ts";
import { widen } from "./widen.ts";

export const scenarios: Scenario[] = [
  strengthReduce,
  rewrite,
  rule,
  cut,
  strengthen,
  pipeline,
  predicate,
  freeze,
  nuw,
  reassociate,
  vectorize,
  miscompile,
  poison,
  widen,
  branch,
  induction,
  loop,
  loopbranch,
  rotated,
  nested,
  unroll,
];

export function scenario(name: string): Scenario {
  const found = scenarios.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`no scenario ${name}; there is ${scenarios.map((s) => s.name).join(", ")}`);
  }
  return found;
}
