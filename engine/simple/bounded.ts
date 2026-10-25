// Loops the tgt no longer has. A src loop whose back edge a constant bounds is
// peeled two times more than that bound, which leaves a loop no run enters, and
// a cut of the src alone takes it away. Loops go the last first, and a nest by
// its outer loop, whose copies bring the inner loops out of it, so that what a
// leftover loop reaches holds no loop to copy.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { copyInto } from "./loops.ts";
import { headers, predecessors, successors } from "./regions.ts";
import { bodies } from "./windows.ts";

/** The most times a loop is peeled. */
const MOST = 300;

/** The goal left once each bounded src loop of goal `gid` the tgt lacks is peeled away. */
export async function peelBounded(session: Session, llops: Llops, gid: string): Promise<string> {
  let at = gid;
  for (;;) {
    const [src, tgt] = await bodies(session, llops, at);
    const header = outermost(src).at(-1);
    if (!header || headers(src).length <= headers(tgt).length) return at;
    const times = await peels(llops, (await session.show(at)).src.text, header);
    const outer = times && (await peeledAway(session, llops, at, header, times));
    if (!outer) return at;
    at = outer;
  }
}

/** How many peels leave the loop at `header` one no run enters, or nothing past `MOST`. */
async function peels(llops: Llops, module: string, header: string) {
  const bounds = await llops.loops(module);
  const most = bounds.ok ? bounds.facts.find((f) => f.loop === header) : undefined;
  const times = most?.max_backedge_taken ? Number(most.max_backedge_taken) + 2 : Infinity;
  return times <= MOST ? times : undefined;
}

/**
 * Peels the loop at `header` of goal `gid` and cuts away what is left: the
 * outer goal, or nothing, with the src as it was, when a step or the cut fails.
 */
async function peeledAway(
  session: Session,
  llops: Llops,
  gid: string,
  header: string,
  times: number,
) {
  const before = (await session.show(gid)).src.id;
  await session.begin(gid, "src");
  for (let n = 0; n < times; n++)
    if ((await session.edit({ op: "peel", block: header })).kind !== "applied") {
      await session.abort();
      return undefined;
    }
  if ((await session.commit({ narrow: false, eager: false })).kind !== "certified")
    return undefined;
  // The peeled code comes first in the body, so the loop left is again the last.
  const leftover = (body: Instruction[]) => outermost(body).at(-1);
  await copyInto(session, llops, gid, "src", leftover);
  const left = leftover((await bodies(session, llops, gid))[0]);
  const made = left ? await session.cut(gid, left) : undefined;
  if (made?.kind === "cut") return made.children.outer;
  await session.revert(gid, "src", before);
  return undefined;
}

/** The headers of the loops no other loop holds, in body order. */
export function outermost(body: Instruction[]): string[] {
  const all = headers(body);
  const [next, before] = [successors(body), predecessors(body)];
  const loops = all.map((header) => loopOf(next, before, header));
  return all.filter((h, k) => !loops.some((inside, j) => j !== k && inside.has(h)));
}

/** The blocks of the loop at `header`, which reach its back edges without passing it. */
function loopOf(next: Map<string, string[]>, before: Map<string, string[]>, header: string) {
  const order = [...next.keys()];
  const at = order.indexOf(header);
  const inside = new Set([header]);
  const todo = order.filter((b, k) => k >= at && next.get(b)?.includes(header));
  for (let block = todo.pop(); block !== undefined; block = todo.pop()) {
    if (inside.has(block)) continue;
    inside.add(block);
    todo.push(...(before.get(block) ?? []));
  }
  return inside;
}
