#!/usr/bin/env python3
"""Tests for the llops binary.

Each test drives llops over stdin/stdout JSON, the same way the agent's
drivers do. Run through `make test-llops`, or directly:

    python3 llops/test/llops_test.py
    LLOPS=/path/to/llops python3 llops/test/llops_test.py
"""

import json
import os
import subprocess
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def llops_binary() -> str:
  """The binary under test, in the toolchain unless LLOPS says otherwise.

  Where the toolchain is has one answer, and scripts/depman.sh is the thing
  that gives it, so a test run and a build cannot disagree about which llops
  is meant.
  """
  if os.environ.get("LLOPS"):
    return os.environ["LLOPS"]
  depman = os.path.join(ROOT, "scripts", "depman.sh")
  toolchain = subprocess.run(
    [depman, "toolchain"], capture_output=True, text=True, check=True
  ).stdout.strip()
  return os.path.join(toolchain, "llops", "build", "llops")


LLOPS = llops_binary()

F_SIMPLE = """define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %x, %y
  %s = add i32 %m, %x
  ret i32 %s
}
"""

F_TWO_ADDS = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  %b = add i32 %y, %x
  ret i32 %a
}
"""

F_MEMORY = """define i32 @f(ptr %p, i32 %v) {
entry:
  store i32 %v, ptr %p, align 4
  %l = load i32, ptr %p, align 4
  ret i32 %l
}
"""


def call(sub: str, req: dict):
  """Run one subcommand; returns (exit status, decoded stdout)."""
  p = subprocess.run([LLOPS, sub], input=json.dumps(req).encode(), capture_output=True, timeout=60)
  out = p.stdout.decode()
  try:
    return p.returncode, json.loads(out)
  except json.JSONDecodeError:
    return p.returncode, out


def run(sub: str, req: dict):
  """Run one subcommand and check the exit status against the response."""
  rc, r = call(sub, req)
  if isinstance(r, dict):
    assert rc == (0 if r.get("ok") else 1), f"{sub}: exit {rc} for {r}"
  return r


class Case(unittest.TestCase):
  def good(self, r):
    self.assertTrue(r.get("ok"), f"unexpected failure: {r}")
    return r

  def bad(self, r, code=None):
    self.assertFalse(r.get("ok"), f"unexpected success: {r}")
    if code:
      self.assertEqual(r["error"]["code"], code, r["error"]["message"])
    return r

  def body(self, module):
    """The instruction lines of the single function, without the label."""
    lines = module.splitlines()
    start = lines.index("entry:") + 1
    end = lines.index("}", start)
    return [line.strip() for line in lines[start:end] if line.strip()]

  def edit(self, op, module=F_SIMPLE, **kw):
    return run("edit", {"module": module, "op": op, **kw})

  def opt(self, what, module=F_SIMPLE, **kw):
    return run("opt", {"module": module, "what": what, **kw})

  def canon(self, module):
    return self.good(run("canon", {"module": module}))["module"]

  def conforms(self, module):
    return self.good(run("validate", {"module": module}))["conforms"]


class TestProtocol(Case):
  def test_version(self):
    rc, out = call("version", {})
    self.assertEqual(rc, 0)
    self.assertIn("llops", out)

  def test_help(self):
    rc, out = call("help", {})
    self.assertEqual(rc, 0)
    self.assertIn("usage", out)

  def test_unknown_subcommand(self):
    rc, _ = call("nonsense", {})
    self.assertEqual(rc, 2)

  def test_bad_json(self):
    p = subprocess.run([LLOPS, "canon"], input=b"{not json", capture_output=True)
    self.assertEqual(p.returncode, 1)
    self.assertEqual(json.loads(p.stdout)["error"]["code"], "bad_json")

  def test_request_must_be_an_object(self):
    p = subprocess.run([LLOPS, "canon"], input=b"[1]", capture_output=True)
    self.assertEqual(p.returncode, 1)
    self.assertEqual(json.loads(p.stdout)["error"]["code"], "bad_request")

  def test_exit_status_follows_ok(self):
    rc, r = call("canon", {"module": F_SIMPLE})
    self.assertEqual((rc, r["ok"]), (0, True))
    rc, r = call("canon", {"module": "not ir"})
    self.assertEqual((rc, r["ok"]), (1, False))


class TestValidate(Case):
  def test_conforming(self):
    self.assertTrue(self.conforms(F_SIMPLE))
    self.assertTrue(self.conforms(F_MEMORY))

  def test_globals_are_allowed(self):
    module = """@g = global i32 7

define i32 @f() {
entry:
  %l = load i32, ptr @g, align 4
  ret i32 %l
}
"""
    self.assertTrue(self.conforms(module))

  def test_declarations_are_allowed(self):
    module = """declare i32 @h(i32)

define i32 @f(i32 %x) {
entry:
  %c = call i32 @h(i32 %x)
  ret i32 %c
}
"""
    self.assertTrue(self.conforms(module))

  def test_function_metadata_and_signatures(self):
    module = """declare i32 @g(i32 noundef range(i32 0, 256)) memory(none) nounwind

define i32 @f(i32 noundef %x) memory(none) {
entry:
  %c = call i32 @g(i32 %x)
  ret i32 %c
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertTrue(r["conforms"])
    funcs = r["functions"]
    self.assertIn("g", funcs)
    self.assertIn("f", funcs)
    self.assertFalse(funcs["g"]["defined"])
    self.assertTrue(funcs["f"]["defined"])
    self.assertEqual(funcs["g"]["return_type"], "i32")
    self.assertEqual(funcs["g"]["params"][0]["attrs"]["noundef"], True)
    self.assertEqual(funcs["g"]["params"][0]["attrs"]["range"], {"min": 0, "max": 256})
    self.assertEqual(funcs["g"]["fn_attrs"]["memory"], "none")
    self.assertEqual(funcs["g"]["fn_attrs"]["nounwind"], True)
    self.assertEqual(
      funcs["g"]["signature"],
      "i32(i32 noundef range(i32 0, 256)) {memory(none), nounwind}",
    )
    self.assertEqual(
      funcs["f"]["signature"],
      "i32(i32 noundef) {memory(none)}",
    )

  def test_use_before_def(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %t = add i32 %s, %x
  %s = mul i32 %x, %y
  ret i32 %t
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertFalse(r["conforms"])
    self.assertEqual(r["diagnostics"][0]["code"], "dominance")

  def test_branches_without_a_loop(self):
    module = """define i32 @f(i32 %x) {
entry:
  %c = icmp slt i32 %x, 0
  br i1 %c, label %neg, label %join

neg:
  %m = sub i32 0, %x
  br label %join

join:
  %a = phi i32 [ %m, %neg ], [ %x, %entry ]
  switch i32 %a, label %done [
    i32 0, label %never
  ]

never:
  unreachable

done:
  ret i32 %a
}
"""
    self.assertTrue(self.conforms(module))

  def test_a_loop(self):
    module = """define i32 @f(i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %i
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertFalse(r["conforms"])
    self.assertEqual(r["diagnostics"][0]["code"], "cyclic")
    self.assertIn("'%loop'", r["diagnostics"][0]["message"])

  def test_a_loop_is_held_to_the_other_rules(self):
    # The subcommands that take a loop pass over `cyclic`, so it cannot
    # stand in front of what else the body breaks.
    module = """define i32 @f(i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %r = call i32 @f(i32 %i)
  %i.next = add i32 %i, %r
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %i
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertEqual(r["diagnostics"][0]["code"], "recursive_call")
    self.bad(
      run("detach", {"module": module, "side": "src", "block": "%loop", "callee": "k"}),
      "recursive_call",
    )

  def test_two_definitions(self):
    module = F_SIMPLE + F_SIMPLE.replace("@f", "@g")
    r = self.good(run("validate", {"module": module}))
    self.assertEqual(r["diagnostics"][0]["code"], "too_many_defines")

  def test_no_definition(self):
    r = self.good(run("validate", {"module": "declare i32 @h(i32)\n"}))
    self.assertEqual(r["diagnostics"][0]["code"], "no_define")

  def test_indirect_call(self):
    module = """define i32 @f(ptr %fp, i32 %x) {
entry:
  %c = call i32 %fp(i32 %x)
  ret i32 %c
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertEqual(r["diagnostics"][0]["code"], "indirect_call")

  def test_recursive_call(self):
    module = """define i32 @f(i32 %x) {
entry:
  %c = call i32 @f(i32 %x)
  ret i32 %c
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertEqual(r["diagnostics"][0]["code"], "recursive_call")

  def test_unsupported_terminator(self):
    module = """define i32 @f(ptr %p) {
entry:
  indirectbr ptr %p, [label %next]

next:
  ret i32 0
}
"""
    r = self.good(run("validate", {"module": module}))
    self.assertEqual(r["diagnostics"][0]["code"], "unsupported_terminator")

  def test_parse_error(self):
    self.bad(run("validate", {"module": "not ir at all"}), "parse_error")


class TestCanon(Case):
  def test_names_are_dropped(self):
    self.assertEqual(
      self.canon(F_SIMPLE),
      "define i32 @f(i32 %0, i32 %1) {\n"
      "entry:\n"
      "  %2 = mul i32 %0, %1\n"
      "  %3 = add i32 %2, %0\n"
      "  ret i32 %3\n"
      "}\n",
    )

  def test_blocks_are_laid_out_in_reverse_postorder(self):
    printed = """define i32 @f(i32 %x) {
entry:
  %c = icmp slt i32 %x, 0
  br i1 %c, label %flip, label %join

flip:
  %m = sub i32 0, %x
  br label %join

join:
  %a = phi i32 [ %m, %flip ], [ %x, %entry ]
  ret i32 %a
}
"""
    moved = """define i32 @f(i32 %x) {
entry:
  %c = icmp slt i32 %x, 0
  br i1 %c, label %flip, label %join

join:
  %a = phi i32 [ %m, %flip ], [ %x, %entry ]
  ret i32 %a

flip:
  %m = sub i32 0, %x
  br label %join
}
"""
    canon = self.canon(printed)
    self.assertEqual(self.canon(moved), canon)
    self.assertEqual(self.canon(canon), canon)
    self.assertLess(canon.index("sub i32 0"), canon.index("phi i32"))

  def test_block_names_that_collide_with_positions(self):
    module = """define i32 @f(i32 %x) {
entry:
  br label %bb2

bb2:
  br label %bb1

bb1:
  ret i32 %x
}
"""
    canon = self.canon(module)
    self.assertIn("bb1:", canon)
    self.assertIn("bb2:", canon)
    self.assertEqual(self.canon(canon), canon)

  def test_predecessors_are_listed_in_block_order(self):
    # Parsed as printed, the join's uses come in the order its branches were
    # read, which is not the order canon prints its predecessors in.
    module = """define i64 @f(i64 %x, i64 %y, i1 %c) {
entry:
  br i1 %c, label %left, label %right

left:
  %s = sub i64 %x, %y
  br label %join

right:
  %t = or i64 %x, %y
  br label %join

join:
  %v = phi i64 [ %s, %left ], [ %t, %right ]
  ret i64 %v
}
"""
    canon = self.canon(module)
    self.assertEqual(self.canon(canon), canon)

  def test_a_block_the_entry_does_not_reach_goes_last(self):
    module = """define i32 @f(i32 %x) {
entry:
  br label %done

dead:
  br label %done

done:
  ret i32 %x
}
"""
    canon = self.canon(module)
    self.assertLess(canon.index("ret i32"), canon.rindex("br label"))

  def test_idempotent(self):
    once = self.canon(F_SIMPLE)
    self.assertEqual(once, self.canon(once))

  def test_names_do_not_matter(self):
    renamed = F_SIMPLE.replace("%m", "%prod").replace("%s", "%sum")
    self.assertEqual(self.canon(F_SIMPLE), self.canon(renamed))

  def test_order_does_matter(self):
    reordered = """define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %y, %x
  %s = add i32 %m, %x
  ret i32 %s
}
"""
    self.assertNotEqual(self.canon(F_SIMPLE), self.canon(reordered))

  def test_declarations_survive(self):
    module = "declare i32 @h(i32)\n\n" + F_SIMPLE
    self.assertIn("declare i32 @h(i32)", self.canon(module))

  def test_refuses_an_undef_value(self):
    # The no-undef model leaves no program holding an undef value inside
    # what llops will answer about, and canon is where that is enforced.
    r = run("canon", {"module": F_SIMPLE.replace("ret i32 %s", "ret i32 undef")})
    self.bad(r, "undef")

  def test_refuses_an_undef_operand(self):
    r = run("canon", {"module": F_SIMPLE.replace("%s = add i32 %m, %x", "%s = add i32 %m, undef")})
    self.bad(r, "undef")

  def test_poison_is_not_undef(self):
    self.good(run("canon", {"module": F_SIMPLE.replace("ret i32 %s", "ret i32 poison")}))

  def test_a_value_named_undef_is_not_an_undef_value(self):
    # What is refused is the value, not the word: a local called %undef
    # is an ordinary name.
    module = F_SIMPLE.replace("%m = mul", "%undef = mul").replace("%m,", "%undef,")
    self.canon(module)

  def test_refuses_an_undef_initializer_behind_an_aggregate(self):
    module = "@g = global { i32, i32 } { i32 0, i32 undef }\n\n" + F_SIMPLE
    self.bad(run("canon", {"module": module}), "undef")

  def test_metadata_does_not_hold_values(self):
    # Metadata names no runtime state, so it is not searched.
    module = F_SIMPLE.replace("ret i32 %s", "ret i32 %s, !foo !0") + "\n!0 = !{i32 undef}\n"
    self.good(run("canon", {"module": module}))

  def test_a_self_referential_global_is_not_undef(self):
    # A global whose initializer points to itself is a cycle through
    # Constant::operands; it must terminate, not crash.
    module = "@g = global ptr @g\n\n" + F_SIMPLE
    self.canon(module)

  def test_mutually_referential_globals_are_not_undef(self):
    module = "@a = global ptr @b\n@b = global ptr @a\n\n" + F_SIMPLE
    self.canon(module)

  def test_refuses_undef_behind_a_global_reference(self):
    # The initializer holds undef; the global symbol itself is just an
    # address, but the initializer is inspected at module scope.
    module = "@g = global i32 undef\n\n" + F_SIMPLE
    self.bad(run("canon", {"module": module}), "undef")


class TestRefs(Case):
  """Values are addressed the way printed IR names them."""

  def test_slot_reference_on_canonical_text(self):
    canon = self.canon(F_SIMPLE)
    r = self.good(self.edit("commute", module=canon, v="%2"))
    self.assertIn("mul i32 %1, %0", r["module"])

  def test_slot_reference_without_percent(self):
    canon = self.canon(F_SIMPLE)
    self.good(self.edit("commute", module=canon, v="2"))

  def test_name_reference(self):
    self.good(self.edit("commute", v="%m"))
    self.good(self.edit("commute", v="m"))

  def test_index_reference_reaches_a_store(self):
    r = self.good(self.edit("erase", module=F_MEMORY, v="#0"))
    self.assertNotIn("store", r["module"])

  def test_index_reference_reaches_the_terminator(self):
    r = self.good(self.edit("insert", where="before", w="#2", insts=["%z = add i32 %s, 1"]))
    self.assertEqual(self.body(r["module"])[-2], "%z = add i32 %s, 1")

  def test_unknown_reference(self):
    self.bad(self.edit("commute", v="%nope"), "not_found")
    self.bad(self.edit("commute", v="%99"), "not_found")
    self.bad(self.edit("commute", v="#99"), "not_found")


class TestEditStructure(Case):
  def test_swap_exchanges_positions(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = mul i32 %x, %y
  %b = add i32 %x, %x
  %c = sub i32 %x, %y
  ret i32 %a
}
"""
    r = self.good(self.edit("swap", module=module, a="a", b="c"))
    self.assertEqual(
      self.body(r["module"])[:3],
      ["%c = sub i32 %x, %y", "%b = add i32 %x, %x", "%a = mul i32 %x, %y"],
    )

  def test_swap_that_breaks_an_order_is_rejected(self):
    self.bad(self.edit("swap", a="s", b="m"), "dominance")

  def test_swap_with_itself(self):
    self.bad(self.edit("swap", a="s", b="s"), "invalid")

  def test_swap_the_terminator(self):
    self.bad(self.edit("swap", a="m", b="#2"), "invalid")

  def test_move(self):
    r = self.good(self.edit("move", module=F_TWO_ADDS, v="b", where="before", w="a"))
    self.assertEqual(self.body(r["module"])[0], "%b = add i32 %y, %x")

  def test_move_the_terminator(self):
    self.bad(self.edit("move", v="#2", where="before", w="m"), "invalid")

  def test_move_after_the_terminator(self):
    self.bad(self.edit("move", v="m", where="after", w="#2"), "invalid")

  def test_erase_dead(self):
    module = """define i32 @f(i32 %x) {
entry:
  %dead = mul i32 %x, 3
  ret i32 %x
}
"""
    r = self.good(self.edit("erase", module=module, v="dead"))
    self.assertNotIn("mul", r["module"])

  def test_erase_used(self):
    self.bad(self.edit("erase", v="m"), "used")

  def test_erase_without_cascade_keeps_operands(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 3
  %b = add i32 %a, 1
  ret i32 %x
}
"""
    r = self.good(self.edit("erase", module=module, v="b"))
    self.assertIn("mul", r["module"])

  def test_erase_with_cascade_drops_them(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 3
  %b = add i32 %a, 1
  ret i32 %x
}
"""
    r = self.good(self.edit("erase", module=module, v="b", cascade=True))
    self.assertNotIn("mul", r["module"])

  def test_cascade_stops_at_side_effects(self):
    module = """declare i32 @h(i32)

define i32 @f(i32 %x) {
entry:
  %c = call i32 @h(i32 %x)
  %a = add i32 %c, 1
  ret i32 %x
}
"""
    r = self.good(self.edit("erase", module=module, v="a", cascade=True))
    self.assertIn("call i32 @h", r["module"])

  def test_cascade_removes_a_dead_load(self):
    # A plain load has no side effect, so a cascade treats it as dead.
    module = """define i32 @f(ptr %p, i32 %x) {
entry:
  %l = load i32, ptr %p, align 4
  %a = add i32 %l, 1
  ret i32 %x
}
"""
    r = self.good(self.edit("erase", module=module, v="a", cascade=True))
    self.assertNotIn("load", r["module"])

  def test_erase_the_terminator(self):
    self.bad(self.edit("erase", v="#2"), "invalid")


class TestEditValues(Case):
  def test_substitute(self):
    r = self.good(self.edit("substitute", module=F_TWO_ADDS, a="a", b="b"))
    self.assertEqual(self.body(r["module"])[-1], "ret i32 %b")

  def test_substitute_out_of_order(self):
    self.bad(self.edit("substitute", module=F_TWO_ADDS, a="x", b="a"), "dominance")

  def test_substitute_type_mismatch(self):
    module = """define i32 @f(i32 %x, i64 %y) {
entry:
  %t = trunc i64 %y to i32
  ret i32 %t
}
"""
    self.bad(self.edit("substitute", module=module, a="t", b="y"), "type_mismatch")

  def test_dedup(self):
    r = self.good(self.edit("dedup", module=F_TWO_ADDS, a="a", b="b"))
    self.assertNotIn("%b", r["module"])

  def test_dedup_out_of_order(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  %b = add i32 %a, %y
  %c = add i32 %x, %y
  ret i32 %b
}
"""
    # %c cannot stand in for %a: %a is used before %c is defined.
    self.bad(self.edit("dedup", module=module, a="c", b="a"), "dominance")

  def test_commute(self):
    r = self.good(self.edit("commute", v="m"))
    self.assertEqual(self.body(r["module"])[0], "%m = mul i32 %y, %x")

  def test_commute_a_comparison_swaps_the_predicate(self):
    module = """define i1 @f(i32 %x, i32 %y) {
entry:
  %c = icmp slt i32 %x, %y
  ret i1 %c
}
"""
    r = self.good(self.edit("commute", module=module, v="c"))
    self.assertEqual(self.body(r["module"])[0], "%c = icmp sgt i32 %y, %x")

  def test_commute_a_subtraction(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %d = sub i32 %x, %y
  ret i32 %d
}
"""
    self.bad(self.edit("commute", module=module, v="d"), "invalid")

  def test_retype_narrows_and_fixes_up_uses(self):
    r = self.good(self.edit("retype", v="m", ty="i16"))
    self.assertEqual(
      self.body(r["module"]),
      [
        "%0 = mul i32 %x, %y",
        "%m = trunc i32 %0 to i16",
        "%1 = zext i16 %m to i32",
        "%s = add i32 %1, %x",
        "ret i32 %s",
      ],
    )
    self.assertTrue(self.conforms(r["module"]))

  def test_retype_signed(self):
    r = self.good(self.edit("retype", v="m", ty="i16", ext="sext"))
    self.assertIn("sext i16 %m to i32", r["module"])

  def test_retype_widens(self):
    r = self.good(self.edit("retype", v="m", ty="i64"))
    self.assertIn("zext i32 %0 to i64", r["module"])
    self.assertIn("trunc i64 %m to i32", r["module"])

  def test_retype_to_the_same_type(self):
    self.bad(self.edit("retype", v="m", ty="i32"), "invalid")

  def test_retype_a_pointer(self):
    self.bad(self.edit("retype", module=F_MEMORY, v="l", ty="ptr"), "invalid")


class TestEditSnippets(Case):
  def test_replace(self):
    r = self.good(self.edit("replace", v="m", insts=["%t = shl i32 %x, 1", "%u = add i32 %t, %y"]))
    self.assertEqual(
      self.body(r["module"]),
      ["%t = shl i32 %x, 1", "%u = add i32 %t, %y", "%s = add i32 %u, %x", "ret i32 %s"],
    )

  def test_replace_may_reuse_the_old_name(self):
    r = self.good(self.edit("replace", v="m", insts=["%m = shl i32 %x, 1"]))
    self.assertEqual(self.body(r["module"])[0], "%m = shl i32 %x, 1")

  def test_replace_may_not_use_the_old_value(self):
    self.bad(self.edit("replace", v="m", insts=["%t = add i32 %m, 1"]), "invalid")

  def test_replace_a_store(self):
    r = self.good(
      self.edit("replace", module=F_MEMORY, v="#0", insts=["store i32 %v, ptr %p, align 2"])
    )
    self.assertEqual(self.body(r["module"])[0], "store i32 %v, ptr %p, align 2")

  def test_replace_type_mismatch(self):
    self.bad(self.edit("replace", v="m", insts=["%t = trunc i32 %x to i16"]), "type_mismatch")

  def test_replace_rejects_a_terminator(self):
    # A snippet may not end the block; the block's own terminator stays.
    self.bad(
      self.edit("replace", v="m", insts=["  %g = mul i32 %x, %y", "  ret i32 %g"]),
      "snippet_terminator",
    )

  def test_insert_rejects_a_terminator(self):
    self.bad(
      self.edit("insert", where="before", w="s", insts=["unreachable"]),
      "snippet_terminator",
    )

  def test_replace_on_canonical_text_by_slot(self):
    canon = self.canon(F_SIMPLE)
    r = self.good(self.edit("replace", module=canon, v="%2", insts=["%t = shl i32 %0, 1"]))
    self.assertEqual(self.body(r["module"])[0], "%t = shl i32 %0, 1")

  def test_insert_before(self):
    r = self.good(self.edit("insert", where="before", w="s", insts=["%t = mul i32 %x, %x"]))
    self.assertEqual(self.body(r["module"])[1], "%t = mul i32 %x, %x")

  def test_insert_after(self):
    r = self.good(self.edit("insert", where="after", w="m", insts=["%t = mul i32 %m, %m"]))
    self.assertEqual(self.body(r["module"])[1], "%t = mul i32 %m, %m")

  def test_insert_an_assume_before_the_terminator(self):
    module = """declare void @llvm.assume(i1)

define i32 @f(i32 %x) {
entry:
  %c = icmp sgt i32 %x, 0
  ret i32 %x
}
"""
    r = self.good(
      self.edit(
        "insert",
        module=module,
        where="before",
        w="#1",
        insts=["call void @llvm.assume(i1 %c)"],
      )
    )
    self.assertEqual(self.body(r["module"])[1], "call void @llvm.assume(i1 %c)")
    self.assertTrue(self.conforms(r["module"]))

  def test_insert_after_the_terminator(self):
    self.bad(self.edit("insert", where="after", w="#2", insts=["%t = add i32 %x, 1"]), "invalid")

  def test_snippet_may_not_shadow_a_name(self):
    self.bad(self.edit("insert", where="before", w="s", insts=["%m = add i32 %x, 1"]), "name_taken")

  def test_snippet_may_call_an_undeclared_function(self):
    r = self.good(
      self.edit("insert", where="before", w="#2", insts=["call void @llvm.assume(i1 true)"])
    )
    self.assertIn("declare void @llvm.assume(i1", r["module"])
    self.assertTrue(self.conforms(r["module"]))

  def test_snippet_naming_a_struct_type(self):
    module = """%pair = type { i32, i32 }

define i32 @f(ptr %p) {
entry:
  %l = load i32, ptr %p, align 4
  ret i32 %l
}
"""
    self.bad(
      self.edit(
        "insert",
        module=module,
        where="before",
        w="l",
        insts=["%v = load %pair, ptr %p, align 4"],
      ),
      "named_type",
    )

  def test_snippet_with_an_unknown_value(self):
    self.bad(
      self.edit("insert", where="before", w="s", insts=["%t = add i32 %zz, 1"]),
      "undefined_value",
    )

  def test_snippet_that_does_not_parse(self):
    self.bad(
      self.edit("insert", where="before", w="s", insts=["%t = add i32 %x"]),
      "snippet_parse_error",
    )

  def test_snippet_out_of_order_is_rejected(self):
    # %t would use %s, which is defined after the insertion point.
    self.bad(self.edit("insert", where="before", w="m", insts=["%t = add i32 %s, 1"]), "dominance")

  def test_snippet_comments_and_repeated_uses(self):
    r = self.good(
      self.edit(
        "insert",
        where="before",
        w="s",
        insts=["%t = add i32 %x, %x ; twice the same value"],
      )
    )
    self.assertEqual(self.body(r["module"])[1], "%t = add i32 %x, %x")

  def test_set_body(self):
    r = self.good(self.edit("set_body", body="  %n = mul i32 %x, %x\n  ret i32 %n"))
    self.assertEqual(self.body(r["module"]), ["%n = mul i32 %x, %x", "ret i32 %n"])

  def test_set_body_keeps_the_signature_and_the_rest_of_the_module(self):
    module = """declare i32 @h(i32)

define noundef i32 @f(i32 noundef %x, i32 %y) {
entry:
  ret i32 %x
}
"""
    r = self.good(self.edit("set_body", module=module, body="  ret i32 %y"))
    self.assertIn("define noundef i32 @f(i32 noundef %x, i32 %y)", r["module"])
    self.assertIn("declare i32 @h(i32)", r["module"])

  def test_set_body_that_does_not_parse(self):
    self.bad(self.edit("set_body", body="  %n = mul i32 %x"), "snippet_parse_error")

  def test_set_body_rejects_a_define_header(self):
    # set_body takes only the instructions after 'entry:', not the header.
    self.bad(
      self.edit(
        "set_body",
        body="define i32 @f(i32 %x, i32 %y) {\nentry:\n  %n = mul i32 %x, %y\n  ret i32 %n\n}\n",
      ),
      "set_body_contract",
    )

  def test_set_body_rejects_a_declare_header(self):
    # A body that opens with a declaration is the same mistake; the lexer
    # classifies it even though no instruction ever starts with "declare".
    self.bad(self.edit("set_body", body="declare i32 @h(i32)\n"), "set_body_contract")

  def test_set_body_rejects_a_global(self):
    self.bad(self.edit("set_body", body="@g = global i32 7\n"), "set_body_contract")

  def test_set_body_rejects_a_type_definition(self):
    self.bad(self.edit("set_body", body="%pair = type { i32, i32 }\n"), "set_body_contract")

  def test_set_body_rejects_an_attribute_group(self):
    self.bad(self.edit("set_body", body="#0 = { nounwind }\n"), "set_body_contract")

  def test_set_body_takes_several_blocks_and_may_loop(self):
    body = "  br label %l\nl:\n  %i = phi i32 [ %x, %entry ], [ %j, %l ]\n  %j = add i32 %i, %y\n  br label %l"
    r = self.good(self.edit("set_body", body=body))
    self.assertIn("%j = add i32 %i, %y", r["module"])
    self.assertFalse(self.conforms(r["module"]))


class TestEditAttrs(Case):
  DECL = """declare i32 @h(ptr, i32)

define i32 @f(ptr %p, i32 %x) {
entry:
  %c = call i32 @h(ptr %p, i32 %x)
  ret i32 %c
}
"""

  def test_pointer_attributes(self):
    r = self.good(
      self.edit(
        "attrs",
        module=self.DECL,
        fn="h",
        param=0,
        attrs={"noundef": True, "nonnull": True, "align": 8, "dereferenceable": 16},
      )
    )
    self.assertIn(
      "declare i32 @h(ptr noundef nonnull align 8 dereferenceable(16), i32)", r["module"]
    )

  def test_range(self):
    r = self.good(
      self.edit("attrs", module=self.DECL, fn="h", param=1, attrs={"range": {"min": 0, "max": 256}})
    )
    self.assertIn("range(i32 0, 256)", r["module"])

  def test_range_on_a_pointer(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=0, attrs={"range": {"min": 0, "max": 8}}),
      "invalid",
    )

  def test_empty_range(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=1, attrs={"range": {"min": 4, "max": 4}}),
      "invalid",
    )

  def test_align_must_be_a_power_of_two(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=0, attrs={"align": 3}),
      "invalid",
    )

  def test_attribute_that_does_not_fit_the_type(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=1, attrs={"nonnull": True}),
      "invalid_ir",
    )

  def test_unknown_attribute(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=0, attrs={"speedy": True}),
      "invalid",
    )

  def test_unknown_function(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="nope", param=0, attrs={"noundef": True}),
      "not_found",
    )

  def test_parameter_out_of_range(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", param=7, attrs={"noundef": True}),
      "invalid",
    )

  def test_function_attributes_on_declaration(self):
    r = self.good(
      self.edit(
        "attrs",
        module=self.DECL,
        fn="h",
        attrs={"memory": "none", "nounwind": True, "willreturn": True, "nofree": True},
      )
    )
    self.assertIn("declare i32 @h(ptr, i32)", r["module"])
    self.assertTrue(
      "memory(none)" in r["module"]
      and "nounwind" in r["module"]
      and "willreturn" in r["module"]
      and "nofree" in r["module"]
    )

  def test_function_attributes_on_definition(self):
    r = self.good(
      self.edit(
        "attrs",
        module=self.DECL,
        fn="f",
        attrs={"memory": "none", "nounwind": True},
      )
    )
    self.assertTrue("memory(none)" in r["module"] and "nounwind" in r["module"])

  def test_invalid_function_attribute(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", attrs={"speedy": True}),
      "invalid",
    )

  def test_invalid_memory_effect(self):
    self.bad(
      self.edit("attrs", module=self.DECL, fn="h", attrs={"memory": "bogus"}),
      "invalid",
    )


class TestEditFlags(Case):
  def test_add_nuw(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  ret i32 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nuw": True}))
    self.assertIn("%a = add nuw i32 %x, 1", self.body(r["module"]))

  def test_remove_nsw(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add nsw i32 %x, 1
  ret i32 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nsw": False}))
    self.assertIn("%a = add i32 %x, 1", self.body(r["module"]))

  def test_exact_on_a_shift(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = ashr i32 %x, 1
  ret i32 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"exact": True}))
    self.assertIn("%a = ashr exact i32 %x, 1", self.body(r["module"]))

  def test_fast_math_flags(self):
    module = """define float @f(float %x) {
entry:
  %a = fadd float %x, 1.0
  ret float %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nnan": True, "nsz": True}))
    line = self.body(r["module"])[0]
    self.assertIn("nnan", line)
    self.assertIn("nsz", line)

  def test_nneg_on_zext(self):
    module = """define i32 @f(i8 %x) {
entry:
  %a = zext i8 %x to i32
  ret i32 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nneg": True}))
    self.assertIn("%a = zext nneg i8 %x to i32", self.body(r["module"]))
    r = self.good(self.edit("flags", module=r["module"], v="a", flags={"nneg": False}))
    self.assertIn("%a = zext i8 %x to i32", self.body(r["module"]))

  def test_nneg_on_uitofp(self):
    module = """define float @f(i32 %x) {
entry:
  %a = uitofp i32 %x to float
  ret float %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nneg": True}))
    self.assertIn("%a = uitofp nneg i32 %x to float", self.body(r["module"]))

  def test_nneg_on_an_add_is_refused(self):
    self.bad(self.edit("flags", v="m", flags={"nneg": True}), "invalid")

  def test_overflow_flag_on_a_division_is_refused(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = sdiv i32 %x, 2
  ret i32 %a
}
"""
    self.bad(self.edit("flags", module=module, v="a", flags={"nuw": True}), "invalid")

  def test_exact_on_an_add_is_refused(self):
    self.bad(self.edit("flags", v="m", flags={"exact": True}), "invalid")

  def test_overflow_flag_on_an_integer_add_is_kept(self):
    # `nuw` means nothing on an fadd, and `nnan` means nothing on an add;
    # each flag is refused where the instruction cannot carry it.
    module = """define float @f(float %x) {
entry:
  %a = fadd float %x, 1.0
  ret float %a
}
"""
    self.bad(self.edit("flags", module=module, v="a", flags={"nuw": True}), "invalid")

  def test_unknown_flag_is_refused(self):
    self.bad(self.edit("flags", v="m", flags={"speedy": True}), "invalid")

  def test_flag_value_must_be_a_boolean(self):
    self.bad(self.edit("flags", v="m", flags={"nuw": 1}), "bad_request")

  def test_unknown_instruction(self):
    self.bad(self.edit("flags", v="nope", flags={"nuw": True}), "not_found")

  def test_nuw_on_trunc(self):
    module = """define i16 @f(i32 %x) {
entry:
  %a = trunc i32 %x to i16
  ret i16 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nuw": True}))
    self.assertIn("%a = trunc nuw i32 %x to i16", self.body(r["module"]))

  def test_nsw_on_trunc(self):
    module = """define i16 @f(i32 %x) {
entry:
  %a = trunc i32 %x to i16
  ret i16 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"nsw": True}))
    self.assertIn("%a = trunc nsw i32 %x to i16", self.body(r["module"]))

  def test_disjoint_on_or(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = or i32 %x, %y
  ret i32 %a
}
"""
    r = self.good(self.edit("flags", module=module, v="a", flags={"disjoint": True}))
    self.assertIn("%a = or disjoint i32 %x, %y", self.body(r["module"]))

  def test_disjoint_on_an_add_is_refused(self):
    self.bad(self.edit("flags", v="m", flags={"disjoint": True}), "invalid")


class TestOpt(Case):
  def test_simplify_folds_an_instruction_away(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 0
  %r = mul i32 %a, 3
  ret i32 %r
}
"""
    r = self.good(self.opt("simplify", module=module, v="a"))
    body = self.body(r["module"])
    self.assertNotIn("add i32 %x, 0", body)
    self.assertIn("%r = mul i32 %x, 3", body)

  def test_simplify_folds_constants(self):
    module = """define i32 @f() {
entry:
  %a = add i32 2, 3
  ret i32 %a
}
"""
    r = self.good(self.opt("simplify", module=module, v="a"))
    self.assertIn("ret i32 5", self.body(r["module"]))

  def test_simplify_an_identity(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = sub i32 %x, %x
  ret i32 %a
}
"""
    r = self.good(self.opt("simplify", module=module, v="a"))
    self.assertIn("ret i32 0", self.body(r["module"]))

  def test_simplify_leaves_what_it_cannot_fold(self):
    r = self.good(self.opt("simplify", v="m"))
    self.assertEqual(self.body(r["module"])[0], "%m = mul i32 %x, %y")

  def test_simplify_reaches_the_terminator(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 1
  ret i32 %a
}
"""
    r = self.good(self.opt("simplify", module=module, v="a"))
    self.assertIn("ret i32 %x", self.body(r["module"]))

  def test_simplify_the_terminator_is_refused(self):
    self.bad(self.opt("simplify", v="#2"), "invalid")

  def test_simplify_unknown_instruction(self):
    self.bad(self.opt("simplify", v="nope"), "not_found")

  def test_instcombine_combines_the_function(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %b = add i32 %a, 1
  ret i32 %b
}
"""
    r = self.good(self.opt("instcombine", module=module, max_iterations=1))
    body = self.body(r["module"])
    self.assertNotIn("%a = add i32 %x, 1", body)
    self.assertIn("%b = add i32 %x, 2", body)

  def test_instcombine_rejects_invalid_max_iterations(self):
    self.bad(self.opt("instcombine", max_iterations=0), "bad_request")
    self.bad(self.opt("instcombine", max_iterations="one"), "bad_request")

  def test_instcombine_selects_one_debug_counter_visit(self):
    module = (
      "define i32 @f(i32 %x) {\n"
      "entry:\n"
      "  %a = add i32 %x, 0\n"
      "  %b = mul i32 %a, 1\n"
      "  ret i32 %b\n"
      "}\n"
    )
    first = self.good(self.opt("instcombine", module=module, debug_counter=0))
    self.assertEqual(self.body(first["module"]), ["%b = mul i32 %x, 1", "ret i32 %b"])

    second = self.good(self.opt("instcombine", module=module, debug_counter=1))
    self.assertEqual(self.body(second["module"]), ["%a = add i32 %x, 0", "ret i32 %a"])

  def test_instcombine_rejects_invalid_debug_counter(self):
    self.bad(self.opt("instcombine", debug_counter=-1), "bad_request")
    self.bad(self.opt("instcombine", debug_counter="one"), "bad_request")

  def test_unknown_opt(self):
    self.bad(self.opt("nope"), "bad_request")


class TestOutline(Case):
  def outline_src(self, module=F_SIMPLE, cut="s", callee="g"):
    return self.good(
      run("outline", {"module": module, "side": "src", "cut": cut, "callee": callee})
    )

  def test_signature_is_the_live_in_set(self):
    r = self.outline_src()
    self.assertEqual(
      r["params"],
      [
        {"param": "%p0", "type": "i32", "live": "%m"},
        {"param": "%p1", "type": "i32", "live": "%x"},
      ],
    )

  def test_outer_calls_the_callee(self):
    r = self.outline_src()
    self.assertEqual(
      self.body(r["outer"]),
      ["%m = mul i32 %x, %y", "%0 = call i32 @g(i32 %m, i32 %x)", "ret i32 %0"],
    )
    self.assertIn("declare i32 @g(i32, i32)", r["outer"])
    self.assertTrue(self.conforms(r["outer"]))

  def test_callee_is_self_contained(self):
    r = self.outline_src()
    self.assertEqual(self.body(r["callee"]), ["%s = add i32 %p0, %p1", "ret i32 %s"])
    self.assertTrue(self.conforms(r["callee"]))

  def test_the_callee_declaration_carries_no_attributes(self):
    module = """define i32 @f(ptr nonnull align 8 %p, i32 %n) {
entry:
  %v = load i32, ptr %p, align 4
  %s = add i32 %v, %n
  ret i32 %s
}
"""
    r = self.outline_src(module=module, cut="s")
    self.assertIn("declare i32 @g(i32, i32)", r["outer"])
    self.assertTrue(self.conforms(r["outer"]))
    self.assertTrue(self.conforms(r["callee"]))

  def test_cut_at_the_first_instruction(self):
    r = self.outline_src(cut="m")
    self.assertEqual(self.body(r["outer"]), ["%0 = call i32 @g(i32 %x, i32 %y)", "ret i32 %0"])

  def test_cut_at_the_terminator(self):
    r = self.outline_src(cut="#2")
    self.assertEqual(self.body(r["callee"]), ["ret i32 %p0"])

  def test_cut_carries_memory_across(self):
    r = self.outline_src(module=F_MEMORY, cut="l")
    self.assertEqual(
      self.body(r["outer"]),
      ["store i32 %v, ptr %p, align 4", "%0 = call i32 @g(ptr %p)", "ret i32 %0"],
    )

  def test_void_function(self):
    module = """define void @f(ptr %p, i32 %v) {
entry:
  %a = add i32 %v, 1
  store i32 %a, ptr %p, align 4
  ret void
}
"""
    r = self.outline_src(module=module, cut="#1")
    self.assertEqual(
      self.body(r["outer"]),
      ["%a = add i32 %v, 1", "call void @g(i32 %a, ptr %p)", "ret void"],
    )

  def test_unknown_cut(self):
    self.bad(
      run("outline", {"module": F_SIMPLE, "side": "src", "cut": "%zz", "callee": "g"}),
      "not_found",
    )

  def test_callee_name_already_taken(self):
    self.bad(
      run("outline", {"module": F_SIMPLE, "side": "src", "cut": "s", "callee": "f"}),
      "invalid",
    )

  def test_outline_rejects_a_non_v1_module(self):
    self.bad(
      run(
        "outline",
        {"module": "declare i32 @h(i32)", "side": "src", "cut": "s", "callee": "g"},
      ),
      "no_define",
    )


class TestOutlineTgt(Case):
  SRC = F_SIMPLE
  # The same function computed in the other order, with different names.
  TGT = """define i32 @f(i32 %a, i32 %b) {
entry:
  %prod = mul i32 %b, %a
  %sum = add i32 %prod, %a
  ret i32 %sum
}
"""

  def src_params(self):
    r = run("outline", {"module": self.SRC, "side": "src", "cut": "s", "callee": "g"})
    return r["params"]

  def outline_tgt(self, value_map, params=None, module=None):
    return run(
      "outline",
      {
        "module": module or self.TGT,
        "side": "tgt",
        "cut": "sum",
        "callee": "g",
        "params": params or self.src_params(),
        "value_map": value_map,
      },
    )

  def test_both_sides_share_one_signature(self):
    r = self.good(self.outline_tgt({"%m": "%prod", "%x": "%a"}))
    self.assertEqual(r["params"], self.src_params())
    self.assertEqual(self.body(r["callee"]), ["%sum = add i32 %p0, %p1", "ret i32 %sum"])

  def test_value_map_must_cover_every_live_value(self):
    self.bad(self.outline_tgt({"%m": "%prod"}), "bad_request")

  def test_mapped_value_must_be_in_scope_at_the_cut(self):
    self.bad(self.outline_tgt({"%m": "%prod", "%x": "%sum"}), "invalid")

  def test_mapped_value_must_exist(self):
    self.bad(self.outline_tgt({"%m": "%prod", "%x": "%nope"}), "not_found")

  def test_types_must_match_the_signature(self):
    params = [
      {"param": "%p0", "type": "i64", "live": "%m"},
      {"param": "%p1", "type": "i32", "live": "%x"},
    ]
    self.bad(self.outline_tgt({"%m": "%prod", "%x": "%a"}, params=params), "type_mismatch")

  def test_a_suffix_value_the_map_misses_fails_the_split(self):
    # The tgt suffix reads %b, which the src signature has no slot for.
    tgt = """define i32 @f(i32 %a, i32 %b) {
entry:
  %prod = mul i32 %b, %a
  %sum = add i32 %prod, %b
  ret i32 %sum
}
"""
    self.bad(self.outline_tgt({"%m": "%prod", "%x": "%a"}, module=tgt), "invalid")


ROTATED = """define i32 @g(i32 noundef %n) {
entry:
  %guard = icmp eq i32 %n, 0
  br i1 %guard, label %exit, label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %acc = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  %acc.next = add i32 %acc, %i
  %i.next = add nuw i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  %r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  ret i32 %r
}
"""

STILL = """define i32 @g(i32 noundef %n, i32 noundef %x) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %k = phi i32 [ %x, %entry ], [ %k, %loop ]
  %i.next = add i32 %i, %k
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %i
}
"""


class TestDetach(Case):
  def detach(self, module, block, callee, **tgt):
    side = "tgt" if tgt else "src"
    return run("detach", {"module": module, "side": side, "block": block, "callee": callee, **tgt})

  def reattaches(self, whole, half, callee):
    request = {"outer": half["outer"], "callee": half["callee"], "callee_name": callee}
    request["phis"] = half["phis"]
    if "hypothesis" in half:
      request["hypothesis"] = half["hypothesis"]
    back = self.good(run("reattach", request))["module"]
    self.assertEqual(self.canon(back), self.canon(whole))

  def test_a_loop_detached_at_its_header_calls_its_hypothesis(self):
    whole = ROTATED.replace("br i1 %guard, label %exit, label %loop", "br label %loop").replace(
      "%r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]", "%r = phi i32 [ %acc.next, %loop ]"
    )
    src = self.good(self.detach(whole, "%loop", "k"))
    self.assertEqual([p["live"] for p in src["params"]], ["%i", "%acc", "%n"])
    self.assertEqual(src["phis"], [0, 1])
    self.assertEqual(src["hypothesis"], "k.ih")
    self.assertTrue(self.conforms(src["callee"]))
    self.reattaches(whole, src, "k")
    tgt = self.good(
      self.detach(
        whole,
        "%loop",
        "k",
        params=src["params"],
        value_map={"%i": "%i", "%acc": "%acc", "%n": "%n"},
      )
    )
    self.reattaches(whole, tgt, "k")

  def test_a_rotated_loop_is_detached_at_its_exit_then_its_header(self):
    self.bad(self.detach(ROTATED, "%loop", "k"), "not_single_entry")
    exit = self.good(self.detach(ROTATED, "%exit", "k1"))
    self.assertNotIn("hypothesis", exit)
    header = self.good(self.detach(exit["outer"], "%loop", "k2"))
    self.assertIn("call i32 @k1(", header["callee"])
    self.assertIn("call i32 @k2.ih(", header["callee"])
    self.assertTrue(self.conforms(header["callee"]))
    self.reattaches(exit["outer"], header, "k2")
    self.reattaches(ROTATED, exit, "k1")

  def test_a_phi_that_never_changes_comes_back(self):
    # k is x on every iteration, a phi on the src side and x itself on the
    # tgt's, so only the list of phis tells the two apart.
    src = STILL
    tgt = STILL.replace("  %k = phi i32 [ %x, %entry ], [ %k, %loop ]\n", "").replace(
      "add i32 %i, %k", "add i32 %i, %x"
    )
    s = self.good(self.detach(src, "%loop", "k"))
    self.assertEqual(s["phis"], [0, 1])
    self.reattaches(src, s, "k")
    live = {"%i": "%i", "%k": "%x", "%n": "%n"}
    t = self.good(self.detach(tgt, "%loop", "k", params=s["params"], value_map=live))
    self.assertEqual(t["phis"], [0])
    self.reattaches(tgt, t, "k")

  def test_one_tgt_value_for_two_parameters_comes_back(self):
    # k copies n on the src side, so the tgt's n stands for both, and each
    # has to go around the loop in its own position.
    src = STILL.replace("i32 noundef %n, i32 noundef %x", "i32 noundef %n").replace(
      "[ %x, %entry ]", "[ %n, %entry ]"
    )
    tgt = src.replace("  %k = phi i32 [ %n, %entry ], [ %k, %loop ]\n", "").replace(
      "add i32 %i, %k", "add i32 %i, %n"
    )
    s = self.good(self.detach(src, "%loop", "k"))
    live = {"%i": "%i", "%k": "%n", "%n": "%n"}
    t = self.good(self.detach(tgt, "%loop", "k", params=s["params"], value_map=live))
    self.assertIn("@k.ih(i32 %i.next, i32 %p1, i32 %p2)", t["callee"])
    self.reattaches(tgt, t, "k")

  def test_a_value_from_outside_passed_as_it_changes_is_refused(self):
    half = self.good(self.detach(STILL, "%loop", "k"))
    request = {"outer": half["outer"], "callee": half["callee"], "callee_name": "k"}
    request["hypothesis"] = half["hypothesis"]
    self.bad(run("reattach", {**request, "phis": [1]}), "invalid")
    self.bad(run("reattach", {**request, "phis": [3]}), "bad_request")
    self.bad(run("reattach", request), "bad_request")

  def test_the_entry_block_is_not_detached(self):
    self.bad(self.detach(ROTATED, "%entry", "k"), "invalid")

  def test_a_hypothesis_that_names_the_callee_is_refused(self):
    half = self.good(self.detach(ROTATED, "%exit", "k"))
    request = {
      "outer": half["outer"],
      "callee": half["callee"],
      "callee_name": "k",
      "hypothesis": "k",
      "phis": half["phis"],
    }
    self.bad(run("reattach", request), "bad_request")

  def test_an_auxiliary_the_halves_disagree_about_is_refused(self):
    loop = """declare void @h()

define void @g(i32 noundef %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %i.next = add nuw i32 %i, 1
  call void @h()
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret void
}
"""
    half = self.good(self.detach(loop, "%loop", "k"))
    callee = half["callee"].replace("declare void @h()", "declare void @h() memory(none)")
    self.assertNotEqual(callee, half["callee"])
    request = {"outer": half["outer"], "callee": callee, "callee_name": "k"}
    r = self.bad(run("reattach", {**request, "phis": half["phis"]}), "invalid")
    self.assertIn("disagree about a symbol", r["error"]["message"])

  def test_a_tgt_phi_the_map_does_not_cover(self):
    src = self.good(self.detach(ROTATED, "%exit", "k"))
    tgt = ROTATED.replace(
      "%r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]",
      "%r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]\n  %s = phi i32 [ 1, %entry ], [ %i, %loop ]",
    )
    r = self.detach(tgt, "%exit", "k", params=src["params"], value_map={"%r": "%r"})
    self.bad(r, "invalid")

  def test_a_call_with_anything_on_it_is_not_reattached(self):
    half = self.good(self.detach(ROTATED, "%exit", "k"))
    marked = half["outer"].replace("call i32 @k(i32 ", "call i32 @k(i32 noundef ")
    self.assertNotEqual(marked, half["outer"])
    request = {"outer": marked, "callee": half["callee"], "callee_name": "k"}
    self.bad(run("reattach", {**request, "phis": half["phis"]}), "invalid")

  def test_a_hypothesis_called_other_than_by_an_edge_is_refused(self):
    # The call would come back as a call of an unknown function, which the
    # callee's check read as the rest of the loop.
    half = self.good(self.detach(STILL, "%loop", "k"))
    used = half["callee"].replace("  ret i32 %1\n", "  %y = add i32 %1, 0\n  ret i32 %y\n")
    self.assertNotEqual(used, half["callee"])
    request = {"outer": half["outer"], "callee": used, "callee_name": "k", "hypothesis": "k.ih"}
    r = self.bad(run("reattach", {**request, "phis": half["phis"]}), "invalid")
    self.assertIn("'@k.ih' is used", r["error"]["message"])

  def test_canon_orders_phi_incoming_by_block(self):
    flipped = ROTATED.replace(
      "%i = phi i32 [ 0, %entry ], [ %i.next, %loop ]",
      "%i = phi i32 [ %i.next, %loop ], [ 0, %entry ]",
    )
    self.assertEqual(self.canon(flipped), self.canon(ROTATED))


class TestOutlineWindow(Case):
  # Two bodies that differ only in how the middle value is computed, and in
  # how many instructions that takes. Asking about that middle on its own is
  # what a window is for, so what these check is that the rest comes out the
  # same on both.
  BEFORE = """define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 2
  %b = add i32 %a, 0
  %c = add i32 %b, 1
  ret i32 %c
}
"""
  AFTER = """define i32 @f(i32 %x) {
entry:
  %b = shl i32 %x, 1
  %c = add i32 %b, 1
  ret i32 %c
}
"""

  def window(self, module=F_SIMPLE, frm="m", to="m", callee="r"):
    return self.good(run("outline", {"module": module, "cut": frm, "to": to, "callee": callee}))

  def test_a_window_becomes_a_call_where_it_was(self):
    r = self.window()
    self.assertEqual(
      self.body(r["outer"]),
      ["%0 = call i32 @r(i32 %x, i32 %y)", "%s = add i32 %0, %x", "ret i32 %s"],
    )
    self.assertEqual(self.body(r["callee"]), ["%m = mul i32 %p0, %p1", "ret i32 %m"])
    self.assertEqual(
      r["params"],
      [
        {"param": "%p0", "type": "i32", "live": "%x"},
        {"param": "%p1", "type": "i32", "live": "%y"},
      ],
    )
    self.assertEqual(r["result"], {"type": "i32", "live": ["%m"]})
    self.assertTrue(self.conforms(r["outer"]))
    self.assertTrue(self.conforms(r["callee"]))

  def test_a_window_of_more_than_one_instruction(self):
    r = self.window(frm="m", to="s")
    self.assertEqual(self.body(r["outer"]), ["%0 = call i32 @r(i32 %x, i32 %y)", "ret i32 %0"])
    self.assertEqual(
      self.body(r["callee"]), ["%m = mul i32 %p0, %p1", "%s = add i32 %m, %p0", "ret i32 %s"]
    )

  def test_a_window_inlines_back_to_what_it_came_from(self):
    # This is what a checker reruns, so it is the property the whole move
    # rests on: the outer and the callee are the body, taken apart.
    for frm, to in (("m", "m"), ("m", "s"), ("s", "s")):
      r = self.window(frm=frm, to=to)
      back = self.good(
        run("inline", {"outer": r["outer"], "callee": r["callee"], "callee_name": "r"})
      )
      self.assertEqual(self.canon(back["module"]), self.canon(F_SIMPLE), f"{frm}..{to}")

  def test_two_bodies_that_differ_in_one_window_share_an_outer(self):
    # Neither the instruction count nor the names line up, so what says the
    # difference is confined to the window is the outer coming out the
    # same, which is what makes the two small pairs the whole question.
    before = self.window(module=self.BEFORE, frm="a", to="b")
    after = self.window(module=self.AFTER, frm="b", to="b")
    self.assertEqual(self.canon(before["outer"]), self.canon(after["outer"]))
    self.assertEqual(before["params"], after["params"])
    self.assertEqual(before["result"]["type"], after["result"]["type"])
    for r, whole in ((before, self.BEFORE), (after, self.AFTER)):
      back = self.good(
        run("inline", {"outer": r["outer"], "callee": r["callee"], "callee_name": "r"})
      )
      self.assertEqual(self.canon(back["module"]), self.canon(whole))

  def test_a_window_nothing_uses_answers_with_nothing(self):
    r = self.window(module=F_TWO_ADDS, frm="b", to="b")
    self.assertEqual(
      self.body(r["outer"]),
      ["%a = add i32 %x, %y", "call void @r(i32 %x, i32 %y)", "ret i32 %a"],
    )
    # The signature is in definition order, which is the argument order
    # here, whatever order the window happens to read them in.
    self.assertEqual(self.body(r["callee"]), ["%b = add i32 %p1, %p0", "ret void"])
    self.assertNotIn("result", r)
    back = self.good(
      run("inline", {"outer": r["outer"], "callee": r["callee"], "callee_name": "r"})
    )
    self.assertEqual(self.canon(back["module"]), self.canon(F_TWO_ADDS))

  def test_a_window_may_hold_memory(self):
    # The store defines nothing, so it is named by its position.
    r = self.window(module=F_MEMORY, frm="#0", to="#0")
    self.assertEqual(self.body(r["callee"]), ["store i32 %p1, ptr %p0, align 4", "ret void"])
    back = self.good(
      run("inline", {"outer": r["outer"], "callee": r["callee"], "callee_name": "r"})
    )
    self.assertEqual(self.canon(back["module"]), self.canon(F_MEMORY))

  def test_a_window_that_hands_out_two_values_answers_with_both(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %b = add i32 %x, 2
  %c = mul i32 %a, %b
  ret i32 %c
}
"""
    r = self.good(run("outline", {"module": module, "cut": "a", "to": "b", "callee": "r"}))
    self.assertEqual(r["result"], {"type": "{ i32, i32 }", "live": ["%a", "%b"]})
    self.assertIn("extractvalue { i32, i32 }", r["outer"])
    request = {"outer": r["outer"], "callee": r["callee"], "callee_name": "r"}
    back = self.good(run("inline", request))["module"]
    self.assertEqual(self.canon(back), self.canon(module))

  def test_a_window_cannot_take_the_terminator(self):
    self.bad(run("outline", {"module": F_SIMPLE, "cut": "s", "to": "#2", "callee": "r"}), "invalid")

  def test_a_window_takes_no_side_and_no_map(self):
    # What says two windows line up is their outers coming out the same, so
    # the fields that make two cuts agree on one signature mean nothing
    # here, and are refused rather than quietly ignored.
    for extra in (
      {"side": "src"},
      {"side": "tgt", "params": [], "value_map": {}},
      {"value_map": {"%x": "%x"}},
    ):
      self.bad(
        run("outline", {"module": F_SIMPLE, "cut": "m", "to": "m", "callee": "r", **extra}),
        "bad_request",
      )

  def test_a_cut_still_needs_its_side(self):
    self.bad(run("outline", {"module": F_SIMPLE, "cut": "m", "callee": "r"}), "bad_request")

  def test_the_window_has_to_run_forwards(self):
    self.bad(run("outline", {"module": F_SIMPLE, "cut": "s", "to": "m", "callee": "r"}), "invalid")

  def test_a_window_edge_that_is_not_there(self):
    self.bad(
      run("outline", {"module": F_SIMPLE, "cut": "m", "to": "nope", "callee": "r"}),
      "not_found",
    )

  def test_the_callee_name_must_be_free(self):
    self.bad(run("outline", {"module": F_SIMPLE, "cut": "m", "to": "m", "callee": "f"}), "invalid")


class TestInline(Case):
  def roundtrip(self, module, cut, callee="g"):
    out = self.good(run("outline", {"module": module, "side": "src", "cut": cut, "callee": callee}))
    back = self.good(
      run("inline", {"outer": out["outer"], "callee": out["callee"], "callee_name": callee})
    )
    return out, back

  def test_roundtrip_reproduces_the_original(self):
    for cut in ("m", "s", "#2"):
      with self.subTest(cut=cut):
        _, back = self.roundtrip(F_SIMPLE, cut)
        self.assertEqual(self.canon(back["module"]), self.canon(F_SIMPLE))

  def test_a_call_with_anything_on_it_is_not_inlined(self):
    out, _ = self.roundtrip(F_SIMPLE, "s")
    plain = "call i32 @g(i32 %"
    for marked in (
      "call i32 @g(i32 noundef %",
      "call noundef i32 @g(i32 %",
      "tail call i32 @g(i32 %",
      "call fastcc i32 @g(i32 %",
    ):
      with self.subTest(marked=marked):
        self.assertIn(plain, out["outer"])
        outer = out["outer"].replace(plain, marked)
        request = {"outer": outer, "callee": out["callee"], "callee_name": "g"}
        self.bad(run("inline", request), "invalid")

  def test_roundtrip_with_memory(self):
    _, back = self.roundtrip(F_MEMORY, "l")
    self.assertEqual(self.canon(back["module"]), self.canon(F_MEMORY))

  def test_roundtrip_keeps_allocas_in_place(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %p = alloca i32, align 4
  store i32 %a, ptr %p, align 4
  %l = load i32, ptr %p, align 4
  ret i32 %l
}
"""
    _, back = self.roundtrip(module, "p")
    self.assertEqual(self.canon(back["module"]), self.canon(module))

  def test_roundtrip_through_a_declared_function(self):
    module = """declare i32 @h(i32)

define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %c = call i32 @h(i32 %a)
  ret i32 %c
}
"""
    _, back = self.roundtrip(module, "c")
    self.assertEqual(self.canon(back["module"]), self.canon(module))

  def test_roundtrip_with_a_global(self):
    module = """@g_data = global i32 7

define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %l = load i32, ptr @g_data, align 4
  %s = add i32 %a, %l
  ret i32 %s
}
"""
    _, back = self.roundtrip(module, "l")
    self.assertEqual(self.canon(back["module"]), self.canon(module))

  def test_roundtrip_at_every_cut_point(self):
    module = """declare i32 @h(i32)

@table = global [4 x i32] zeroinitializer

define i32 @f(ptr %p, i32 %n) {
entry:
  %slot = alloca i32, align 4
  %n1 = add nsw i32 %n, 1
  store i32 %n1, ptr %slot, align 4
  %l = load i32, ptr %p, align 4
  %c = icmp sgt i32 %l, %n1
  %z = zext i1 %c to i32
  %call = call i32 @h(i32 %z)
  %g = getelementptr inbounds [4 x i32], ptr @table, i64 0, i64 2
  %t = load i32, ptr %g, align 4
  %s = add i32 %call, %t
  ret i32 %s
}
"""
    canonical = self.canon(module)
    for cut in range(len(self.body(module))):
      with self.subTest(cut=cut):
        _, back = self.roundtrip(module, f"#{cut}")
        self.assertEqual(self.canon(back["module"]), canonical)

  def test_the_declaration_is_dropped(self):
    _, back = self.roundtrip(F_SIMPLE, "s")
    self.assertNotIn("declare", back["module"])

  def test_missing_call(self):
    out = self.good(run("outline", {"module": F_SIMPLE, "side": "src", "cut": "s", "callee": "g"}))
    self.bad(
      run("inline", {"outer": out["callee"], "callee": out["callee"], "callee_name": "g"}),
      "not_found",
    )

  def test_callee_must_be_defined(self):
    out = self.good(run("outline", {"module": F_SIMPLE, "side": "src", "cut": "s", "callee": "g"}))
    self.bad(
      run("inline", {"outer": out["outer"], "callee": out["outer"], "callee_name": "g"}),
      "not_found",
    )

  def test_the_outer_must_declare_the_callee_as_it_is_defined(self):
    out = self.good(run("outline", {"module": F_SIMPLE, "side": "src", "cut": "s", "callee": "g"}))
    # Varargs keeps the call well formed, so only the signatures disagree.
    callee = out["callee"].replace(
      "define i32 @g(i32 %p0, i32 %p1) {", "define i32 @g(i32 %p0, i32 %p1, ...) {"
    )
    self.assertNotEqual(callee, out["callee"])
    self.bad(
      run("inline", {"outer": out["outer"], "callee": callee, "callee_name": "g"}), "type_mismatch"
    )

  def test_an_auxiliary_the_halves_disagree_about_is_refused(self):
    module = """declare i32 @h(i32)

define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %c = call i32 @h(i32 %a)
  ret i32 %c
}
"""
    out = self.good(run("outline", {"module": module, "side": "src", "cut": "c", "callee": "g"}))
    for callee in (
      out["callee"].replace("declare i32 @h(i32)", "declare i32 @h(i32) memory(none)"),
      out["callee"].replace("declare i32 @h(i32)", "declare i64 @h(i32)"),
    ):
      with self.subTest(callee=callee):
        self.assertNotEqual(callee, out["callee"])
        r = self.bad(
          run("inline", {"outer": out["outer"], "callee": callee, "callee_name": "g"}), "invalid"
        )
        self.assertIn("disagree about a symbol", r["error"]["message"])

  def test_parse_errors_name_the_side(self):
    r = self.bad(
      run("inline", {"outer": "nope", "callee": F_SIMPLE, "callee_name": "g"}), "parse_error"
    )
    self.assertIn("outer", r["error"]["message"])


class TestHarness(Case):
  F = """define i32 @f(i32 %x, ptr %p) {
entry:
  %v = load i32, ptr %p, align 4
  %s = add i32 %v, %x
  store i32 %s, ptr %p, align 4
  ret i32 %s
}
"""

  def harness(self, module=None, entry="f", args=None):
    return run(
      "harness",
      {"module": module or self.F, "entry": entry, "args": args if args is not None else []},
    )

  def two_args(self):
    return [
      {"kind": "int", "value": "7"},
      {"kind": "bytes", "bytes": [35, 0, 0, 0], "align": 4},
    ]

  def test_wraps_the_entry_in_the_main_llubi_wants(self):
    r = self.good(self.harness(args=self.two_args()))
    # llubi refuses any other signature.
    self.assertIn("define i32 @main(i32 %0, ptr %1)", r["module"])
    self.assertIn("call i32 @f(i32 7, ptr %buf1)", r["module"])
    # The function under test is carried along unchanged.
    self.assertIn("define i32 @f(i32 %x, ptr %p)", r["module"])

  def test_names_everything_worth_observing(self):
    r = self.good(self.harness(args=self.two_args()))
    self.assertEqual(
      r["observations"],
      ["%obs.result", "%obs.mem.1.0", "%obs.mem.1.1", "%obs.mem.1.2", "%obs.mem.1.3"],
    )
    for name in r["observations"]:
      self.assertIn(f"{name} = load", r["module"])

  def test_the_initial_bytes_are_stored_before_the_call(self):
    r = self.good(self.harness(args=self.two_args()))
    body = self.body(r["module"].split("define i32 @main")[1])
    self.assertTrue(body[0].startswith("%buf1 = alloca [4 x i8]"))
    self.assertIn("store [4 x i8]", body[1])
    self.assertIn("call i32 @f", body[2])

  def test_a_null_pointer_argument(self):
    r = self.good(self.harness(args=[{"kind": "int", "value": "1"}, {"kind": "null"}]))
    self.assertIn("call i32 @f(i32 1, ptr null)", r["module"])
    # Nothing was allocated, so there are no bytes to read back.
    self.assertEqual(r["observations"], ["%obs.result"])

  def test_an_integer_wider_than_json_carries(self):
    module = """define i64 @f(i64 %x) {
entry:
  ret i64 %x
}
"""
    r = self.good(self.harness(module=module, args=[{"kind": "int", "value": "9007199254740993"}]))
    self.assertIn("call i64 @f(i64 9007199254740993)", r["module"])

  def test_a_negative_integer(self):
    # A counterexample is as often negative as not, and its own notation is
    # what a caller has in hand.
    module = """define i32 @f(i32 %x) {
entry:
  ret i32 %x
}
"""
    r = self.good(self.harness(module=module, args=[{"kind": "int", "value": "-3"}]))
    self.assertIn("call i32 @f(i32 -3)", r["module"])

  def test_an_integer_the_parameter_cannot_hold(self):
    module = """define i32 @f(i32 %x) {
entry:
  ret i32 %x
}
"""
    self.bad(self.harness(module=module, args=[{"kind": "int", "value": "-2147483649"}]), "invalid")
    self.bad(self.harness(module=module, args=[{"kind": "int", "value": "4294967296"}]), "invalid")

  def test_a_void_function_has_no_result_to_observe(self):
    module = """define void @f(ptr %p) {
entry:
  store i8 1, ptr %p, align 1
  ret void
}
"""
    r = self.good(self.harness(module=module, args=[{"kind": "bytes", "bytes": [0]}]))
    self.assertEqual(r["observations"], ["%obs.mem.0.0"])

  def test_the_result_parses(self):
    r = self.good(self.harness(args=self.two_args()))
    self.good(run("canon", {"module": r["module"]}))

  def test_the_wrong_number_of_arguments(self):
    self.bad(self.harness(args=[{"kind": "int", "value": "1"}]), "bad_request")

  def test_an_argument_of_the_wrong_kind(self):
    self.bad(
      self.harness(args=[{"kind": "null"}, {"kind": "null"}]),
      "type_mismatch",
    )
    self.bad(
      self.harness(args=[{"kind": "int", "value": "1"}, {"kind": "int", "value": "2"}]),
      "type_mismatch",
    )

  def test_a_byte_that_is_not_one(self):
    self.bad(
      self.harness(args=[{"kind": "int", "value": "1"}, {"kind": "bytes", "bytes": [256]}]),
      "invalid",
    )

  def test_an_alignment_that_is_not_a_power_of_two(self):
    self.bad(
      self.harness(
        args=[{"kind": "int", "value": "1"}, {"kind": "bytes", "bytes": [1], "align": 3}]
      ),
      "invalid",
    )

  def test_an_entry_that_is_not_there(self):
    self.bad(self.harness(entry="nope", args=[]), "not_found")

  def test_a_module_that_already_has_a_main(self):
    module = (
      self.F
      + """
define i32 @main(i32 %argc, ptr %argv) {
entry:
  ret i32 0
}
"""
    )
    self.bad(self.harness(module=module, args=self.two_args()), "invalid")


# A loop's callee after a cut at its header: the back edge is a call of the
# hypothesis, so the body branches and does not loop.
CALLEE = """declare i32 @k.ih(i32, i32, i32)

define i32 @k(i32 %i, i32 %j, i32 %n) {
head:
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  %inc = zext i1 %even to i32
  %j.next = add i32 %j, %inc
  %i.next = add i32 %i, 1
  %r = call i32 @k.ih(i32 %i.next, i32 %j.next, i32 %n)
  ret i32 %r

exit:
  %d = sub i32 %i, %j
  ret i32 %d
}
"""


class TestSeveralBlocks(Case):
  ORDER = [{"op": "ule", "lhs": {"arg": 1}, "rhs": {"arg": 0}}]

  def assumed(self, anchor, assertions=ORDER):
    r = self.good(run("assume", {"module": CALLEE, "anchor": anchor, "assertions": assertions}))
    self.assertTrue(self.conforms(r["module"]), r["module"])
    return r["module"]

  def test_an_assume_at_the_start_of_a_callee_that_branches(self):
    own = [{"op": "ule", "lhs": {"val": "%j"}, "rhs": {"val": "%i"}}]
    module = self.assumed({"at": "start", "fn": "k"}, own)
    head = module[module.index("head:") : module.index("body:")]
    self.assertIn("icmp ule i32 %j, %i", head)
    self.assertIn("@llvm.assume", head)

  def test_an_assume_before_a_call_in_a_later_block(self):
    module = self.assumed({"at": "before_calls", "fn": "k.ih"})
    body = module[module.index("body:") : module.index("exit:")]
    self.assertIn("icmp ule i32 %j.next, %i.next", body)
    self.assertLess(body.index("@llvm.assume"), body.index("call i32 @k.ih"))

  def test_a_reference_reaches_into_a_later_block(self):
    fact = [{"fact": {"range": {"min": 0, "max": 256}}, "val": "%j.next"}]
    module = self.assumed({"at": "before_inst", "inst": "%r"}, fact)
    self.assertIn("icmp sge i32 %j.next, 0", module)

  def test_attributes_on_a_module_that_branches(self):
    request = {"op": "attrs", "fn": "k.ih", "param": 0, "attrs": {"noundef": True}}
    r = self.good(run("edit", {"module": CALLEE, **request}))
    self.assertIn("declare i32 @k.ih(i32 noundef, i32, i32)", r["module"])

  def test_each_edit_works_in_the_block_of_its_instruction(self):
    edits = [
      {"op": "commute", "v": "%j.next"},
      {"op": "swap", "a": "%j.next", "b": "%i.next"},
      {"op": "move", "v": "%i.next", "where": "before", "w": "%c"},
      {"op": "replace", "v": "%d", "insts": ["%d = add i32 %i, %j"]},
      {"op": "insert", "where": "after", "w": "%odd", "insts": ["%two = shl i32 %odd, 1"]},
      {"op": "erase", "v": "%inc", "cascade": False},
      {"op": "flags", "v": "%i.next", "flags": {"nuw": True}},
    ]
    for request in edits:
      with self.subTest(op=request["op"]):
        r = run("edit", {"module": CALLEE, **request})
        if request["op"] == "erase":
          self.bad(r, "used")
        else:
          self.assertTrue(self.conforms(self.good(r)["module"]))

  def windowed(self, module, frm, to):
    r = self.good(run("outline", {"module": module, "cut": frm, "to": to, "callee": "w"}))
    request = {"outer": r["outer"], "callee": r["callee"], "callee_name": "w"}
    back = self.good(run("inline", request))["module"]
    self.assertEqual(self.canon(back), self.canon(module))
    return r

  def test_a_window_in_the_arm_of_a_branch_goes_out_and_back(self):
    r = self.windowed(CALLEE, "%odd", "%even")
    self.assertIn("call i1 @w(i32 %i)", r["outer"])

  def test_a_window_in_the_body_of_a_loop_goes_out_and_back(self):
    r = self.windowed(ROTATED, "%acc.next", "%acc.next")
    self.assertFalse(self.conforms(r["outer"]))
    self.assertTrue(self.conforms(r["callee"]))

  def test_a_window_hands_back_both_values_a_loop_header_reads(self):
    r = self.windowed(ROTATED, "%acc.next", "%i.next")
    self.assertIn("{ i32, i32 }", r["outer"])

  def cut(self, module, at, **tgt):
    side = "tgt" if tgt else "src"
    request = {"module": module, "side": side, "cut": at, "callee": "rest", **tgt}
    return run("outline", request)

  def test_the_rest_of_a_body_that_branches_goes_out_and_back(self):
    r = self.good(self.cut(CALLEE, "%c"))
    self.assertEqual([p["live"] for p in r["params"]], ["%i", "%j", "%n"])
    self.assertIn("call i32 @rest(i32 %i, i32 %j, i32 %n)", r["outer"])
    self.assertTrue(self.conforms(r["outer"]))
    request = {"outer": r["outer"], "callee": r["callee"], "callee_name": "rest"}
    back = self.good(run("inline", request))["module"]
    self.assertEqual(self.canon(back), self.canon(CALLEE))

  def test_the_tgt_side_cuts_against_the_src_signature(self):
    s = self.good(self.cut(CALLEE, "%odd"))
    live = {p["live"]: p["live"] for p in s["params"]}
    self.good(self.cut(CALLEE, "%odd", params=s["params"], value_map=live))

  def test_a_cut_before_a_join_inside_a_loop_or_at_a_phi_is_refused(self):
    join = """define i32 @f(i32 %x) {
entry:
  %c = icmp slt i32 %x, 0
  br i1 %c, label %neg, label %join

neg:
  %m = sub i32 0, %x
  br label %join

join:
  %a = phi i32 [ %m, %neg ], [ %x, %entry ]
  ret i32 %a
}
"""
    self.bad(self.cut(join, "%m"), "not_single_entry")
    self.bad(self.cut(ROTATED, "%acc.next"), "not_single_entry")
    self.bad(self.cut(join, "%a"), "invalid")

  def test_a_window_does_not_take_a_phi(self):
    request = {"module": ROTATED, "cut": "%i", "to": "%acc", "callee": "w"}
    self.bad(run("outline", request), "invalid")

  def test_a_window_stays_in_one_block(self):
    request = {"module": CALLEE, "cut": "%c", "to": "%odd", "callee": "w"}
    self.bad(run("outline", request), "invalid")

  def facts(self, module, kind, point):
    r = self.good(run("analyze", {"module": module, "kind": kind, "point": point}))
    return {fact["value"]: fact for fact in r["facts"]}

  def test_analyze_answers_for_what_dominates_its_point(self):
    facts = self.facts(CALLEE, "knownbits", "%r")
    self.assertEqual(facts["%odd"]["zero_bits"], "0xFFFFFFFE")
    self.assertIn("%c", facts)
    self.assertNotIn("%d", facts)

  def test_analyze_inside_the_body_of_a_loop(self):
    facts = self.facts(ROTATED, "defined", "%c")
    self.assertTrue(facts["%n"]["noundef"])
    self.assertIn("%acc.next", facts)
    self.assertNotIn("%r", facts)

  def test_analyze_needs_a_point_in_a_body_of_several_blocks(self):
    self.bad(run("analyze", {"module": CALLEE, "kind": "ranges"}), "bad_request")

  def test_a_value_reaches_uses_in_other_blocks_or_does_not(self):
    good = run("edit", {"module": CALLEE, "op": "substitute", "a": "%j.next", "b": "%j"})
    self.assertIn("call i32 @k.ih(i32 %i.next, i32 %j, i32 %n)", self.good(good)["module"])
    bad = run("edit", {"module": CALLEE, "op": "substitute", "a": "%i", "b": "%i.next"})
    self.bad(bad, "dominance")

  def test_a_swap_stays_in_one_block(self):
    r = run("edit", {"module": CALLEE, "op": "swap", "a": "%c", "b": "%odd"})
    self.bad(r, "invalid")

  def test_an_edit_may_leave_a_loop(self):
    r = self.good(run("edit", {"module": ROTATED, "op": "retype", "v": "%i.next", "ty": "i64"}))
    self.assertIn("phi i32 [ 0, %entry ], [ %", r["module"])
    self.assertFalse(self.conforms(r["module"]))
    self.good(run("opt", {"module": ROTATED, "what": "instcombine"}))


class TestAssume(Case):
  F = """define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %s = mul i32 %m, 2
  ret i32 %s
}
"""
  P = """define i32 @f(ptr %p) {
entry:
  %v = load i32, ptr %p, align 4
  ret i32 %v
}
"""

  def assume(self, module=None, before="%s", value="%m", fact=None):
    return run(
      "assume",
      {
        "module": module or self.F,
        "anchor": {"at": "before_inst", "inst": before},
        "assertions": [
          {"fact": fact if fact is not None else {"range": {"min": 0, "max": 256}}, "val": value}
        ],
      },
    )

  def test_a_range_becomes_a_pair_of_comparisons(self):
    r = self.good(self.assume())
    body = self.body(r["module"])
    self.assertEqual(body[1], "%0 = icmp sge i32 %m, 0")
    self.assertEqual(body[2], "%1 = icmp slt i32 %m, 256")
    self.assertEqual(body[3], "%2 = and i1 %0, %1")
    self.assertEqual(body[4], "call void @llvm.assume(i1 %2)")
    # Before the instruction it was told, not at the end.
    self.assertEqual(body[5], "%s = mul i32 %m, 2")

  def test_a_range_that_wraps_becomes_a_disjunction(self):
    module = """define i8 @f(i8 %x) {
entry:
  %y = add i8 %x, 1
  ret i8 %y
}
"""
    # The attribute's interval is half-open and wraps when min is above
    # max, so the predicate has to admit the two runs it describes.
    r = self.good(
      self.assume(module=module, before="%y", value="%x", fact={"range": {"min": 10, "max": -56}})
    )
    self.assertIn("%2 = or i1 %0, %1", r["module"])

  def test_pointer_facts_become_operand_bundles(self):
    r = self.good(
      self.assume(
        module=self.P,
        before="%v",
        value="%p",
        fact={"nonnull": True, "align": 8, "dereferenceable": 16},
      )
    )
    self.assertIn('"nonnull"(ptr %p)', r["module"])
    self.assertIn('"align"(ptr %p, i64 8)', r["module"])
    self.assertIn('"dereferenceable"(ptr %p, i64 16)', r["module"])
    self.assertIn("call void @llvm.assume(i1 true)", r["module"])

  def test_noundef_is_an_operand_bundle(self):
    # UB exactly when the value is undef or poison, which is what makes
    # the check of the insertion a proof of the fact, and a form LLVM's
    # own analyses read back.
    r = self.good(self.assume(fact={"noundef": True}))
    self.assertIn('call void @llvm.assume(i1 true) [ "noundef"(i32 %m) ]', r["module"])

  def test_a_condition_and_a_bundle_are_two_assumes(self):
    # An assume that carries bundles must have `true` as its condition, so
    # the two kinds of fact cannot share one call.
    r = self.good(self.assume(fact={"noundef": True, "range": {"min": 0, "max": 8}}))
    body = self.body(r["module"])
    self.assertEqual(body[4], "call void @llvm.assume(i1 %2)")
    self.assertEqual(body[5], 'call void @llvm.assume(i1 true) [ "noundef"(i32 %m) ]')

  def test_the_result_is_still_a_v1_program(self):
    r = self.good(self.assume())
    self.assertTrue(self.conforms(r["module"]))

  def test_noalias_has_no_assume_form(self):
    r = self.bad(
      self.assume(module=self.P, before="%v", value="%p", fact={"noalias": True}), "invalid"
    )
    self.assertIn("noalias", r["error"]["message"])

  def test_a_range_on_a_pointer(self):
    self.bad(self.assume(module=self.P, before="%v", value="%p"), "invalid")

  def test_a_pointer_fact_on_an_integer(self):
    self.bad(self.assume(fact={"align": 8}), "invalid")

  def test_an_alignment_that_is_not_a_power_of_two(self):
    self.bad(self.assume(module=self.P, before="%v", value="%p", fact={"align": 3}), "invalid")

  def test_an_unknown_fact(self):
    r = self.bad(self.assume(fact={"speedy": True}), "invalid")
    self.assertIn("unknown fact 'speedy'", r["error"]["message"])
    r2 = self.bad(self.assume(fact={"not_undef": True}), "invalid")
    self.assertIn("unknown fact 'not_undef'", r2["error"]["message"])

  def test_no_facts_at_all(self):
    self.bad(self.assume(fact={}), "bad_request")

  def test_anchoring_on_the_call_finds_its_argument(self):
    module = """define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %r = call i32 @g(i32 %m)
  ret i32 %r
}

declare i32 @g(i32)
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "before_calls", "fn": "g"},
          "assertions": [{"fact": {"range": {"min": 0, "max": 256}}, "arg": 0}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertIn("icmp sge i32 %m, 0", body[1])
    # The assume goes before the call, which is what the fact is about.
    self.assertEqual(body[4], "call void @llvm.assume(i1 %2)")
    self.assertTrue(body[5].endswith("call i32 @g(i32 %m)"))

  def test_before_calls_assumes_before_each_call(self):
    module = """define i32 @f(i32 %n, i1 %c) {
entry:
  br i1 %c, label %a, label %b

a:
  %x = and i32 %n, 255
  %r = call i32 @g(i32 %x)
  ret i32 %r

b:
  %y = and i32 %n, 15
  %s = call i32 @g(i32 %y)
  ret i32 %s
}

declare i32 @g(i32)
"""
    below = {"op": "ule", "lhs": {"arg": 0}, "rhs": {"val": "%n"}}
    anchor = {"at": "before_calls", "fn": "g"}
    text = self.good(run("assume", {"module": module, "anchor": anchor, "assertions": [below]}))[
      "module"
    ]
    for block, arg, end in (("a:", "%x", "b:"), ("b:", "%y", "}")):
      body = text[text.index(block) : text.index(end, text.index(block))]
      self.assertIn(f"icmp ule i32 {arg}, %n", body)
      self.assertLess(body.index("@llvm.assume"), body.index(f"call i32 @g(i32 {arg})"))

  def test_a_call_that_is_not_there(self):
    self.bad(
      run(
        "assume",
        {
          "module": self.F,
          "anchor": {"at": "before_calls", "fn": "g"},
          "assertions": [{"fact": {"noundef": True}, "arg": 0}],
        },
      ),
      "not_found",
    )

  def test_an_argument_index_out_of_range(self):
    module = """define i32 @f(i32 %n) {
entry:
  %r = call i32 @g(i32 %n)
  ret i32 %r
}

declare i32 @g(i32)
"""
    self.bad(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "before_calls", "fn": "g"},
          "assertions": [{"fact": {"noundef": True}, "arg": 4}],
        },
      ),
      "invalid",
    )

  def test_unknown_anchor_kind(self):
    self.bad(
      run(
        "assume",
        {
          "module": self.F,
          "anchor": {"at": "nowhere"},
          "assertions": [{"fact": {"noundef": True}, "arg": 0}],
        },
      ),
      "bad_request",
    )
    self.bad(run("assume", {"module": self.F, "assertions": []}), "bad_request")

  def test_arg_names_a_call_argument_and_val_any_value(self):
    module = """define i32 @f(i32 %n, i32 %k) {
entry:
  %m = and i32 %n, 255
  %r = call i32 @g(i32 %m)
  ret i32 %r
}

declare i32 @g(i32)
"""

    def assume(anchor, assertion):
      return run("assume", {"module": module, "anchor": anchor, "assertions": [assertion]})

    start, call = {"at": "start", "fn": "f"}, {"at": "before_calls", "fn": "g"}
    below = {"op": "ult", "lhs": {"arg": 0}, "rhs": {"val": "%k"}}
    self.assertIn("icmp ult i32 %m, %k", self.good(assume(call, below))["module"])
    self.bad(assume(start, below), "bad_request")
    own = {"op": "ult", "lhs": {"val": "%n"}, "rhs": {"val": "%k"}}
    self.assertIn("icmp ult i32 %n, %k", self.good(assume(start, own))["module"])

  def test_an_anchor_or_value_that_is_not_there(self):
    self.bad(self.assume(before="%nope"), "not_found")
    self.bad(self.assume(value="%nope"), "not_found")

  def test_start_anchor_with_fact(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  ret i32 %a
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"fact": {"noundef": True}, "val": "%x"}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], 'call void @llvm.assume(i1 true) [ "noundef"(i32 %x) ]')
    self.assertEqual(body[1], "%a = add i32 %x, %y")

  def test_start_anchor_with_predicate(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  ret i32 %a
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"op": "slt", "lhs": {"val": "%x"}, "rhs": {"val": "%y"}}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], "%0 = icmp slt i32 %x, %y")
    self.assertEqual(body[1], "call void @llvm.assume(i1 %0)")

  def test_before_calls_with_predicate(self):
    module = """declare i32 @g(i32, i32)

define i32 @f(i32 %x, i32 %y) {
entry:
  %c = call i32 @g(i32 %x, i32 %y)
  ret i32 %c
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "before_calls", "fn": "g"},
          "assertions": [{"op": "ne", "lhs": {"arg": 0}, "rhs": {"const": 0}}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], "%0 = icmp ne i32 %x, 0")
    self.assertEqual(body[1], "call void @llvm.assume(i1 %0)")
    self.assertEqual(body[2], "%c = call i32 @g(i32 %x, i32 %y)")

  def test_multiple_assertions_in_single_call(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  ret i32 %a
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [
            {"fact": {"noundef": True}, "val": "%x"},
            {"fact": {"noundef": True}, "val": "%y"},
            {"op": "slt", "lhs": {"val": "%x"}, "rhs": {"val": "%y"}},
          ],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], "%0 = icmp slt i32 %x, %y")
    self.assertEqual(body[1], "call void @llvm.assume(i1 %0)")
    self.assertEqual(
      body[2], 'call void @llvm.assume(i1 true) [ "noundef"(i32 %x), "noundef"(i32 %y) ]'
    )
    self.assertEqual(body[3], "%a = add i32 %x, %y")

  def test_predicate_type_mismatch(self):
    module = """define i32 @f(i32 %x, i64 %y) {
entry:
  ret i32 %x
}
"""
    self.bad(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"op": "eq", "lhs": {"val": "%x"}, "rhs": {"val": "%y"}}],
        },
      ),
      "type_mismatch",
    )

  def test_unknown_predicate_operator(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  ret i32 %x
}
"""
    self.bad(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"op": "bogus", "lhs": {"val": "%x"}, "rhs": {"val": "%y"}}],
        },
      ),
      "invalid",
    )

  def test_before_inst_with_predicate_comparing_local_values(self):
    module = """define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, 1
  %b = add i32 %y, 2
  %c = add i32 %a, %b
  ret i32 %c
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "before_inst", "inst": "%c"},
          "assertions": [{"op": "slt", "lhs": {"val": "%a"}, "rhs": {"val": "%b"}}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[2], "%0 = icmp slt i32 %a, %b")
    self.assertEqual(body[3], "call void @llvm.assume(i1 %0)")
    self.assertEqual(body[4], "%c = add i32 %a, %b")

  def test_before_inst_with_predicate_comparing_a_local_and_a_parameter(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %b = add i32 %a, 2
  ret i32 %b
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "before_inst", "inst": "%b"},
          "assertions": [{"op": "sgt", "lhs": {"val": "%a"}, "rhs": {"val": "%x"}}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[1], "%0 = icmp sgt i32 %a, %x")
    self.assertEqual(body[2], "call void @llvm.assume(i1 %0)")
    self.assertEqual(body[3], "%b = add i32 %a, 2")

  def test_pointer_comparison_predicate(self):
    module = """define i32 @f(ptr %p, ptr %q) {
entry:
  ret i32 0
}
"""
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"op": "ne", "lhs": {"val": "%p"}, "rhs": {"val": "%q"}}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], "%0 = icmp ne ptr %p, %q")
    self.assertEqual(body[1], "call void @llvm.assume(i1 %0)")

  def test_predicate_on_unsupported_float_type(self):
    module = """define float @f(float %x, float %y) {
entry:
  ret float %x
}
"""
    self.bad(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"op": "eq", "lhs": {"val": "%x"}, "rhs": {"val": "%y"}}],
        },
      ),
      "invalid",
    )

  def test_an_index_names_the_body_as_given(self):
    # %b is printed before %a, so the assume the first assertion puts in %b
    # comes before %v in the printed order; #3 still names %v.
    module = """define i32 @f(i32 %x) {
entry:
  br label %a

b:
  %r = add i32 %x, 1
  ret i32 %r

a:
  %v = and i32 %x, 255
  br label %b
}
"""
    below = {"op": "ult", "lhs": {"val": "#3"}, "rhs": {"const": 256}}
    request = {"at": "before_inst", "inst": "%r"}
    r = self.good(
      run("assume", {"module": module, "anchor": request, "assertions": [below, below]})
    )
    self.assertEqual(r["module"].count("icmp ult i32 %v, 256"), 2)

  def test_a_point_names_a_parameter_as_a_value(self):
    module = """define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  ret i32 %a
}
"""
    anchor = {"at": "before_inst", "inst": "%a"}
    for assertion in (
      {"fact": {"noundef": True}, "arg": 0},
      {"op": "ne", "lhs": {"arg": 0}, "rhs": {"const": 0}},
    ):
      with self.subTest(assertion=assertion):
        r = run("assume", {"module": module, "anchor": anchor, "assertions": [assertion]})
        self.bad(r, "bad_request")
    r = self.good(
      run(
        "assume",
        {
          "module": module,
          "anchor": anchor,
          "assertions": [{"fact": {"noundef": True}, "val": "%x"}],
        },
      )
    )
    body = self.body(r["module"])
    self.assertEqual(body[0], 'call void @llvm.assume(i1 true) [ "noundef"(i32 %x) ]')
    self.assertEqual(body[1], "%a = add i32 %x, 1")

  def test_assertion_missing_fact_and_op_is_bad_request(self):
    module = """define i32 @f(i32 %x) {
entry:
  ret i32 %x
}
"""
    self.bad(
      run(
        "assume",
        {
          "module": module,
          "anchor": {"at": "start", "fn": "f"},
          "assertions": [{"invalid_key": True}],
        },
      ),
      "bad_request",
    )


class TestAnalyze(Case):
  MASKED = """define i32 @f(i32 %x) {
entry:
  %a = and i32 %x, 255
  %b = add i32 %a, 1
  ret i32 %b
}
"""

  def facts(self, module, kind, **kw):
    r = self.good(run("analyze", {"module": module, "kind": kind, **kw}))
    return {f["value"]: f for f in r["facts"]}, r

  def test_knownbits(self):
    facts, r = self.facts(self.MASKED, "knownbits", point="b")
    self.assertEqual(r["point"], "%b")
    self.assertEqual(facts["%a"]["unknown_bits"], "0xFF")
    self.assertEqual(facts["%a"]["zero_bits"], "0xFFFFFF00")
    self.assertEqual(facts["%x"]["unknown_bits"], "0xFFFFFFFF")

  def test_facts_stop_at_the_point(self):
    facts, _ = self.facts(self.MASKED, "knownbits", point="b")
    self.assertNotIn("%b", facts)

  def test_the_point_defaults_to_the_end(self):
    facts, r = self.facts(self.MASKED, "knownbits")
    self.assertEqual(r["point"], "#2")
    self.assertIn("%b", facts)

  def test_assumptions_are_used(self):
    module = """declare void @llvm.assume(i1)

define i32 @f(i32 %x) {
entry:
  %c = icmp ult i32 %x, 4
  call void @llvm.assume(i1 %c)
  %d = add i32 %x, 0
  ret i32 %d
}
"""
    facts, _ = self.facts(module, "knownbits", point="d")
    self.assertEqual(facts["%x"]["unknown_bits"], "0x3")

  def test_an_assumption_counts_only_before_the_point(self):
    module = """declare void @llvm.assume(i1)

define i32 @f(i32 %x) {
entry:
  %c = icmp sge i32 %x, 0
  call void @llvm.assume(i1 %c)
  %d = add i32 %x, 0
  ret i32 %d
}
"""
    after, _ = self.facts(module, "ranges", point="d")
    self.assertEqual(after["%x"]["signed_min"], "0")
    # At the assume itself the fact is not established yet.
    at, _ = self.facts(module, "ranges", point="#1")
    self.assertEqual(at["%x"]["signed_min"], "-2147483648")

  def test_ranges(self):
    facts, _ = self.facts(self.MASKED, "ranges", point="b")
    self.assertEqual(facts["%a"]["unsigned_min"], "0")
    self.assertEqual(facts["%a"]["unsigned_max"], "255")

  def test_ranges_of_a_signed_parameter(self):
    module = """define i32 @f(i32 range(i32 -8, 9) %x) {
entry:
  ret i32 %x
}
"""
    facts, _ = self.facts(module, "ranges")
    self.assertEqual(facts["%x"]["signed_min"], "-8")
    self.assertEqual(facts["%x"]["signed_max"], "8")

  def test_pointer(self):
    module = """define i32 @f(ptr align 8 dereferenceable(16) %p) {
entry:
  %l = load i32, ptr %p, align 4
  ret i32 %l
}
"""
    facts, _ = self.facts(module, "pointer")
    self.assertEqual(facts["%p"]["align"], 8)
    self.assertEqual(facts["%p"]["dereferenceable"], 16)
    self.assertTrue(facts["%p"]["nonnull"])

  def test_defined(self):
    module = """define i32 @f(i32 noundef %n, i32 %m) {
entry:
  %a = and i32 %n, 255
  %b = add nsw i32 %n, 1
  %c = freeze i32 %m
  ret i32 %a
}
"""
    facts, _ = self.facts(module, "defined")
    # A noundef parameter is defined, and so is anything computed from one
    # by an instruction that cannot make poison.
    self.assertTrue(facts["%n"]["noundef"])
    self.assertTrue(facts["%a"]["noundef"])
    # A plain parameter is neither, and a freeze of one is both.
    self.assertFalse(facts["%m"]["noundef"])
    self.assertFalse(facts["%m"]["not_undef"])
    self.assertTrue(facts["%c"]["noundef"])
    # The halves are separate because they call for different fixes: this
    # one only needs the flag dropped.
    self.assertFalse(facts["%b"]["noundef"])
    self.assertTrue(facts["%b"]["not_undef"])
    self.assertFalse(facts["%b"]["not_poison"])

  def test_defined_reads_a_load_as_undef(self):
    # Uninitialized memory is where undef comes from inside a function,
    # which is why a flag that only speaks about arguments is not enough.
    module = """define i32 @f(ptr %p) {
entry:
  %l = load i32, ptr %p, align 4
  ret i32 %l
}
"""
    facts, _ = self.facts(module, "defined")
    self.assertFalse(facts["%l"]["noundef"])

  def test_defined_applies_to_every_type(self):
    facts, _ = self.facts(F_MEMORY, "defined")
    self.assertEqual(sorted(facts), ["%l", "%p", "%v"])

  def test_defined_reads_the_assume_bundle(self):
    module = """declare void @llvm.assume(i1)

define i32 @f(i32 %x) {
entry:
  call void @llvm.assume(i1 true) ["noundef"(i32 %x)]
  %d = add i32 %x, 0
  ret i32 %d
}
"""
    # The form `assume` writes a proved noundef fact in, which is why it
    # writes it that way: the analysis after the step sees the fact.
    facts, _ = self.facts(module, "defined", point="d")
    self.assertTrue(facts["%x"]["noundef"])
    # And it holds only after the assume has run.
    at, _ = self.facts(module, "defined", point="#0")
    self.assertFalse(at["%x"]["noundef"])

  def test_only_the_relevant_values_are_reported(self):
    facts, _ = self.facts(F_MEMORY, "pointer")
    self.assertEqual(list(facts), ["%p"])

  def test_unknown_kind(self):
    self.bad(run("analyze", {"module": F_SIMPLE, "kind": "bogus"}), "bad_request")

  def test_unknown_point(self):
    self.bad(run("analyze", {"module": F_SIMPLE, "kind": "ranges", "point": "%zz"}), "not_found")


if __name__ == "__main__":
  unittest.main(verbosity=2)
