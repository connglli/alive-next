// Every scenario, in the order they are worth reading: each one adds a single
// mechanism to the one before it.

import type { Scenario } from "../core/scenario.ts";
import { cut } from "./cut.ts";
import { miscompile } from "./miscompile.ts";
import { poison } from "./poison.ts";
import { reassociate } from "./reassociate.ts";
import { rewrite } from "./rewrite.ts";
import { strengthReduce } from "./strength-reduce.ts";
import { strengthen } from "./strengthen.ts";
import { widen } from "./widen.ts";

export const scenarios: Scenario[] = [
  strengthReduce,
  rewrite,
  cut,
  strengthen,
  reassociate,
  miscompile,
  poison,
  widen,
];

export function scenario(name: string): Scenario {
  const found = scenarios.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`no scenario ${name}; there is ${scenarios.map((s) => s.name).join(", ")}`);
  }
  return found;
}
