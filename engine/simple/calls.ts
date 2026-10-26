// Aligns tail markers before the blocks containing the calls need to match.
// When the target's calls of one function agree on a marker, each source call
// without pointer arguments can take it in a window of its own. The edit
// preserves the source call's operands and attributes; the checker certifies it.
import type { Instruction } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";

/** Steps the source calls toward the target's tail markers; returns the number of steps. */
export async function stepCalls(
  session: Session,
  gid: string,
  src: Instruction[],
  tgt: Instruction[],
): Promise<number> {
  const wanted = tailsIn(tgt);
  let changed = 0;
  // A marker moves no instruction, so these indices survive each edit.
  for (const [k, call] of [...src.entries()].reverse()) {
    const before = tailOf(call);
    const after = call.calls ? wanted.get(call.calls) : undefined;
    if (before === undefined || after === undefined || before === after) continue;
    await session.begin(gid, "src");
    const v = `#${k}`;
    if ((await session.edit({ op: "flags", v, flags: { tail: after } })).kind !== "applied") {
      await session.abort();
      continue;
    }
    const step = await session.commit({ window: { from: v, to: v }, whole: false, eager: false });
    if (step.kind === "certified") changed++;
  }
  return changed;
}

/** The marker each function's target calls agree on, absent when any call rules it out. */
function tailsIn(body: Instruction[]): Map<string, boolean | undefined> {
  const markers = new Map<string, boolean | undefined>();
  for (const call of body) {
    if (!call.calls) continue;
    const tail = tailOf(call);
    const same = !markers.has(call.calls) || markers.get(call.calls) === tail;
    markers.set(call.calls, same ? tail : undefined);
  }
  return markers;
}

/** An ordinary tail marker on a call whose arguments cannot contain a pointer. */
function tailOf(call: Instruction): boolean | undefined {
  if (call.opcode !== "call" || call.pointer_args !== false) return undefined;
  if (call.flags.includes("musttail") || call.flags.includes("notail")) return undefined;
  return call.flags.includes("tail");
}
