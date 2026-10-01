// tx_abort: throw the open transaction away.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatEdits, toolResult } from "./format.ts";

export function createAbortTool(session: Session) {
  return defineTool({
    name: "tx_abort",
    label: "Abort",
    description:
      "Discard the open transaction. Nothing was checked, so the side stays as it was before tx_begin.",
    parameters: Type.Object({}),
    execute: async () => {
      const thrown = await session.abort();
      return toolResult(
        true,
        `dropped ${formatEdits(thrown.ops.length)} on ${thrown.gid} ${thrown.side}`,
        {
          gid: thrown.gid,
          side: thrown.side,
          ops: thrown.ops.length,
        },
      );
    },
  });
}
