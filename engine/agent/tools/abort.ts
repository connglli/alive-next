// abort: throw the open transaction away.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResult } from "./format.ts";

export function createAbortTool(session: Session) {
  return defineTool({
    name: "abort",
    label: "Abort",
    description:
      "Discard the open transaction. Nothing was certified, so nothing is undone; the head is where it was before begin.",
    parameters: Type.Object({}),
    execute: async () => {
      const thrown = await session.abort();
      return toolResult(true, `dropped ${thrown.ops.length} ops on ${thrown.gid} ${thrown.side}`, {
        gid: thrown.gid,
        side: thrown.side,
        ops: thrown.ops.length,
      });
    },
  });
}
