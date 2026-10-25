// A loop that runs a fixed number of times, which the tgt computes outright.
//
// r = r * x + i for each i below 4 is (x + 2) * x + 3, and the tgt has no
// loop. The src is peeled one time more than its loop runs: each peel gives
// the edges into the loop their own copy of its blocks, a step reshaped
// certifies, and the loop left over is one no run enters. A cut of the src
// alone moves it into a function the tgt never calls, so the outer, which no
// longer loops, holds only because the src never calls it either.
import { expect, type Scenario } from "../core/scenario.ts";
import type { Session } from "../core/session.ts";

export const bounded: Scenario = {
  name: "bounded",
  about: "a loop peeled until what is left runs never, cut out of the src alone",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %x.addr = alloca i32, align 4
  %r = alloca i32, align 4
  %i = alloca i32, align 4
  store i32 %x, ptr %x.addr, align 4
  store i32 0, ptr %r, align 4
  store i32 0, ptr %i, align 4
  br label %head

head:
  %iv = load i32, ptr %i, align 4
  %more = icmp slt i32 %iv, 4
  br i1 %more, label %body, label %exit

exit:
  %res = load i32, ptr %r, align 4
  ret i32 %res

body:
  %rv = load i32, ptr %r, align 4
  %xv = load i32, ptr %x.addr, align 4
  %m = mul nsw i32 %rv, %xv
  %iv2 = load i32, ptr %i, align 4
  %a = add nsw i32 %m, %iv2
  store i32 %a, ptr %r, align 4
  br label %latch

latch:
  %iv3 = load i32, ptr %i, align 4
  %inc = add nsw i32 %iv3, 1
  store i32 %inc, ptr %i, align 4
  br label %head
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %a = add nsw i32 %x, 2
  %m = mul nsw i32 %a, %x
  %r = add nsw i32 %m, 3
  ret i32 %r
}
`,

  async prove(session) {
    // `%bb1` is the header. Four iterations run, and the fifth test leaves.
    let text = (await session.begin("g1", "src")).text;
    for (let n = 0; n < 5; n++) text = await peel(session, text, "bb1");
    await keepOwnCopies(session, text, "bb1");
    const peeled = await session.commit({ narrow: false, eager: false });
    expect(
      "peel the loop five times, a step reshaped certifies",
      peeled.kind === "certified",
      peeled,
    );

    const header = leftover((await session.show("g1")).src.text);
    const cut = await session.cut("g1", `%${header}`);
    expect("cut the loop that is left out of the src alone", cut.kind === "cut", cut);
    if (cut.kind !== "cut") return;
    const outer = await session.check(cut.children.outer);
    expect(
      "the outer holds, so the src never calls what was cut",
      outer.outcome === "proved",
      outer,
    );
  },
};

/** The blocks each block may go to, in the order the body has them. */
function successors(text: string): Map<string, string[]> {
  const body = text.slice(text.indexOf("define"), text.indexOf("\n}\n"));
  const next = new Map<string, string[]>([["entry", []]]);
  let block = "entry";
  for (const line of body.split("\n").slice(1)) {
    const label = line.match(/^(\w[\w.]*):/);
    if (label) {
      block = label[1] ?? "";
      next.set(block, []);
    } else for (const to of line.matchAll(/label %([\w.]+)/g)) next.get(block)?.push(to[1] ?? "");
  }
  return next;
}

function reached(next: Map<string, string[]>, from: string): Set<string> {
  const seen = new Set([from]);
  for (const b of seen) for (const to of next.get(b) ?? []) seen.add(to);
  return seen;
}

function into(next: Map<string, string[]>, block: string): string[] {
  return [...next].flatMap(([from, tos]) => (tos.includes(block) ? [from] : []));
}

/** Copies `block` for `preds` in the transaction: the text after, and the copy's name. */
async function copied(session: Session, text: string, block: string, preds: string[]) {
  const before = new Set(successors(text).keys());
  const made = await session.edit({
    op: "copy_block",
    block: `%${block}`,
    preds: preds.map((p) => `%${p}`),
  });
  if (made.kind !== "applied") throw new Error(JSON.stringify(made));
  return {
    text: made.text,
    name: [...successors(made.text).keys()].find((b) => !before.has(b)) ?? "",
  };
}

/** Runs the loop at `header`'s first iteration before it, a copy of each of its blocks. */
async function peel(session: Session, text: string, header: string): Promise<string> {
  const next = successors(text);
  const loop = new Set([...reached(next, header)].filter((b) => reached(next, b).has(header)));
  let made = await copied(
    session,
    text,
    header,
    into(next, header).filter((p) => !loop.has(p)),
  );
  const copies = new Map([[header, made.name]]);
  // Each block after the blocks of the loop that go to it, back edges aside.
  const order: string[] = [];
  const seen = new Set([header]);
  const visit = (block: string) => {
    for (const to of next.get(block) ?? [])
      if (loop.has(to) && !seen.has(to)) {
        seen.add(to);
        visit(to);
        order.push(to);
      }
  };
  visit(header);
  for (const block of order.reverse()) {
    const preds = into(next, block).flatMap((p) => (copies.has(p) ? [copies.get(p) ?? ""] : []));
    if (preds.length === 0) continue;
    made = await copied(session, made.text, block, preds);
    copies.set(block, made.name);
  }
  return made.text;
}

/** Gives code outside the loop its own copy of each block the loop reaches. */
async function keepOwnCopies(session: Session, text: string, header: string) {
  for (;;) {
    const next = successors(text);
    const left = reached(next, header);
    const shared = [...left].find((b) => b !== header && into(next, b).some((p) => !left.has(p)));
    if (!shared) return;
    text = (
      await copied(
        session,
        text,
        shared,
        into(next, shared).filter((p) => !left.has(p)),
      )
    ).text;
  }
}

/** The header of the loop a peel leaves: the block a later block goes back to. */
function leftover(text: string): string {
  const blocks = [...successors(text)];
  return blocks.find(([b], k) => blocks.slice(k).some(([, tos]) => tos.includes(b)))?.[0] ?? "";
}
