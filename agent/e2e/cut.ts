// Cutting a goal in two and proving the halves.
//
// Nothing here needs the cut, since alive2 would take the pair whole. It is
// the mechanism on the smallest program that shows it: the prefix is shared,
// so the outer pair is two identical programs around the same call, and the
// difference is alone in the callee.
//
// Cutting costs something the root did not have to pay. The root's parameter
// is `noundef`, but the callee's are fresh, and nothing about a function says
// its arguments are defined; asked about undef-capable inputs alive2 does not
// answer a multiply by eight inside thirty seconds. So the first thing after a
// cut is to prove the interface defined, which is what the caller's own
// definedness gives: an assume before the call, then the attribute, and the
// callee is a question with an answer.
//
// Canonically `%0` is the parameter, `%1` the add and `%2` the multiply, which
// is where both sides are cut.
import { expect, type Scenario } from "./scenario.ts";

export const cut: Scenario = {
  name: "cut",
  about: "a split, and a check on each half",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %a = add i32 %x, 1
  %b = mul i32 %a, 8
  %c = sub i32 %b, %x
  ret i32 %c
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %a = add i32 %x, 1
  %b = shl i32 %a, 3
  %c = sub i32 %b, %x
  ret i32 %c
}
`,

  async prove(session) {
    // The suffix uses the add and the parameter, so both cross the cut.
    const split = await session.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    expect("cut at the multiply", split.kind === "split", split);
    if (split.kind !== "split") return;

    // Which of the values crossing the cut can be promised to the callee is a
    // question with an answer, so ask it rather than assert it. Both are
    // computed from a defined parameter by instructions that cannot make
    // poison, and the analysis says so.
    const facts = await session.analyze(split.children.outer, "src", "defined");
    expect("ask what the caller has", facts.ok, facts);
    if (!facts.ok) return;
    const defined = new Set(facts.facts.filter((fact) => fact.noundef).map((fact) => fact.value));

    for (const [param, entry] of split.params.entries()) {
      expect(`${entry.live} is defined`, defined.has(entry.live), facts);
      const proved = await session.strengthen("g1", param, { noundef: true });
      expect(`prove ${entry.param} defined`, proved.kind === "strengthened", proved);
    }

    const outer = await session.check(split.children.outer);
    expect(`check ${split.children.outer}`, outer.outcome === "proved", outer);
    const callee = await session.check(split.children.callee);
    expect(`check ${split.children.callee}`, callee.outcome === "proved", callee);
  },
};
