// give_up: the model saying it has nothing left to try.
//
// A run ends on a verdict, on a budget, or here. Without this the only way to
// stop short would be to fall silent, and falling silent is not the same
// thing: a model that stops talking mid-search is nudged to carry on, while
// one that says it is finished is believed and the reason is recorded.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResult } from "./format.ts";
import type { Stop } from "./index.ts";

export function createGiveUpTool(session: Session, stop: Stop) {
  return defineTool({
    name: "give_up",
    label: "Give up",
    description:
      "End the run without settling it, saying why. Call this when you have run out of things to try, not when you are merely between moves: a turn that calls nothing is taken as thinking aloud and you will be asked to continue. The run reports unknown, which is one of the three outcomes and not a failure to explain away.",
    parameters: Type.Object({
      reason: Type.String({
        description: "What you tried and what stopped you, for whoever reads the trajectory.",
      }),
    }),
    execute: async (_id, { reason }) => {
      stop.gaveUp = reason;
      const given = await session.giveUp(reason);
      return { ...toolResult(true, `the run stops here: ${reason}`, given), terminate: true };
    },
  });
}
