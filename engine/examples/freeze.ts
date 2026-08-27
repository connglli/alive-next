// Freezing a potentially poisonous input so a cut can promise non-poison.
//
// The root function takes `i32 %x` without `noundef`, so `%x` is permitted to
// be poison. Inside the body, `freeze` resolves any poison into an arbitrary
// defined value. Any downstream value computed from the frozen input without
// overflow flags is guaranteed not to be poison.
//
// When we cut at the multiply, the values crossing the cut (`%f` and `%a`)
// cannot be poison, so `session.analyze` identifies them as `not_poison` and
// `session.strengthen` formally proves `noundef` on the callee's parameters.
import type { Attrs } from "../core/drivers/llops.ts";
import { expect, type Scenario } from "../core/scenario.ts";

export const freeze: Scenario = {
  name: "freeze",
  about: "freezing a potentially poisonous input to give a callee noundef parameters",

  src: `define i32 @f(i32 %x) {
entry:
  %f = freeze i32 %x
  %a = add i32 %f, 1
  %b = mul i32 %a, 8
  %c = sub i32 %b, %f
  ret i32 %c
}
`,

  tgt: `define i32 @f(i32 %x) {
entry:
  %f = freeze i32 %x
  %a = add i32 %f, 1
  %b = shl i32 %a, 3
  %c = sub i32 %b, %f
  ret i32 %c
}
`,

  async prove(session) {
    // Canonically:
    // `%0` is `%x` (may be poison)
    // `%1` is `%f = freeze i32 %0` (guaranteed not poison)
    // `%2` is `%a = add i32 %1, 1` (guaranteed not poison)
    // `%3` is `%b = mul i32 %2, 8` (cut point)
    const split = await session.split("g1", "%3", "%3", { "%1": "%1", "%2": "%2" });
    expect("cut at the multiply", split.kind === "split", split);
    if (split.kind !== "split") return;

    // Although the root parameter `%0` may be poison, the values crossing the
    // cut (`%1` and `%2`) are derived from a frozen value and cannot be poison.
    const facts = await session.analyze(split.children.outer, "src", "defined");
    expect("ask what the caller has", facts.ok, facts);
    if (!facts.ok) return;

    const defined = new Set(
      facts.facts.filter((fact) => fact.not_poison).map((fact) => fact.value),
    );

    // Strengthen the callee interface with noundef for each non-poison live-in.
    const wanted: Record<number, Attrs> = {};
    for (const [param, entry] of split.params.entries()) {
      expect(`${entry.live} is not poison`, defined.has(entry.live), facts);
      wanted[param] = { noundef: true };
    }
    const proved = await session.strengthen("g1", { param_attrs: wanted });
    expect("prove the callee interface noundef", proved.kind === "strengthened", proved);

    const outer = await session.check(split.children.outer);
    expect(`check ${split.children.outer}`, outer.outcome === "proved", outer);
    const callee = await session.check(split.children.callee);
    expect(`check ${split.children.callee}`, callee.outcome === "proved", callee);
  },
};
