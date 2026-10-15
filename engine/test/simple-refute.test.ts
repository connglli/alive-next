// Tests reading alive2's counterexamples as inputs to the original programs.
import { describe, expect, test } from "bun:test";
import { inputsOf } from "../simple/refute.ts";

describe("inputs", () => {
  test("each has its type, and its bits or that it is poison", () => {
    const detail = `ERROR: Value mismatch

Example:
i32 noundef %#0 = #x0000000a (10)
ptr %#1 = pointer(non-local, block_id=1, offset=0)
i8 %#2 = poison

Source:
i32 %#3 = #x0000000a (10)
`;
    expect(inputsOf(detail)).toEqual([
      { type: "i32", value: 10n },
      { type: "ptr", value: undefined },
      { type: "i8", value: undefined, poison: true },
    ]);
  });
});
