#!/usr/bin/env python3
"""Tests for kernel/check.py.

    python3 kernel/check_test.py

A golden package has to pass and every bent one has to fail, which is the half
that matters: a checker that accepts a certificate nobody could have earned is
worse than no checker.

Packages are built here rather than recorded, so what is under test is the
rule kernel/check.py applies and not a run that happened to go well.
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHECK = ROOT / "kernel" / "check.py"


def toolchain() -> Path:
  where = subprocess.run(
    [str(ROOT / "scripts" / "depman.sh"), "toolchain"],
    capture_output=True,
    text=True,
    check=True,
  )
  return Path(where.stdout.strip())


ALIVE_TV = os.environ.get("ALIVE_TV") or str(toolchain() / "alive2" / "build" / "alive-tv")
LLOPS = os.environ.get("LLOPS") or str(toolchain() / "llops" / "build" / "llops")
LLUBI = os.environ.get("LLUBI") or str(toolchain() / "llubi-legacy" / "build" / "llubi")
LLRWT = os.environ.get("LLRWT") or str(toolchain() / "veir" / ".lake" / "build" / "bin" / "llrwt")
MLIR_TRANSLATE = str(toolchain() / "llvm-project" / "build" / "bin" / "mlir-translate")
MLIR_OPT = str(toolchain() / "llvm-project" / "build" / "bin" / "mlir-opt")
HAVE = Path(ALIVE_TV).exists() and Path(LLOPS).exists()
HAVE_LLUBI = Path(LLUBI).exists() and Path(LLOPS).exists()
HAVE_LLRWT = Path(LLRWT).exists() and Path(LLOPS).exists()

# Halving rounds toward zero and shifting rounds down, so the two part company
# on every negative odd value.
HALVE = """define i32 @f(i32 noundef %0) {
entry:
  %1 = sdiv i32 %0, 2
  ret i32 %1
}
"""
SHIFT = """define i32 @f(i32 noundef %0) {
entry:
  %1 = ashr i32 %0, 1
  ret i32 %1
}
"""
# Reading one byte, and reading four to get it, which is only sound where the
# object is known to hold four.
BYTE = """define i32 @f(ptr noundef %0) {
entry:
  %1 = load i8, ptr %0, align 1
  %2 = zext i8 %1 to i32
  ret i32 %2
}
"""
WIDE = """define i32 @f(ptr noundef %0) {
entry:
  %1 = load i32, ptr %0, align 1
  %2 = and i32 %1, 255
  ret i32 %2
}
"""
# A src that divides by its second argument, which has UB of its own to offer.
DIVIDE = """define i32 @f(i32 noundef %0, i32 noundef %1) {
entry:
  %2 = sdiv i32 %0, %1
  ret i32 %2
}
"""
SHIFT2 = """define i32 @f(i32 noundef %0, i32 noundef %1) {
entry:
  %2 = ashr i32 %0, %1
  ret i32 %2
}
"""

SRC = """define i32 @f(i32 noundef %0) {
entry:
  %1 = mul i32 %0, 2
  ret i32 %1
}
"""
TGT = """define i32 @f(i32 noundef %0) {
entry:
  %1 = shl i32 %0, 1
  ret i32 %1
}
"""
# Adding zero and folding it away, which is the verified rewriter's work.
ZERO_ADD = """define i32 @f(i32 noundef %0) {
entry:
  %1 = add i32 %0, 0
  ret i32 %1
}
"""
ZERO_FOLDED = """define i32 @f(i32 noundef %0) {
entry:
  ret i32 %0
}
"""
# Dropping nsw refines forwards and not backwards, which is what tells a step
# recorded on the wrong side from one recorded on the right one.
NSW = """define i32 @f(i32 noundef %0) {
entry:
  %1 = add nsw i32 %0, 1
  ret i32 %1
}
"""
WRAPS = NSW.replace(" nsw", "")

# Dropping a freeze holds only where the argument cannot be poison, which is
# what tells a replay that used the manifest's assumption from one that did not.
FROZEN = """define i32 @f(i32 %0) {
entry:
  %1 = freeze i32 %0
  ret i32 %1
}
"""
RAW = """define i32 @f(i32 %0) {
entry:
  ret i32 %0
}
"""

# True of every i32, so the outer can prove it before any call.
PREDICATE = {"insts": ["%le = icmp sle i32 !0, 2147483647"]}

# Negating through a branch and through a select, which alive-tv decides
# because neither one loops.
BRANCH = """define i32 @f(i32 noundef %0) {
entry:
  %1 = icmp slt i32 %0, 0
  br i1 %1, label %flip, label %join

flip:
  %2 = sub i32 0, %0
  br label %join

join:
  %3 = phi i32 [ %2, %flip ], [ %0, %entry ]
  ret i32 %3
}
"""
SELECT = """define i32 @f(i32 noundef %0) {
entry:
  %1 = icmp slt i32 %0, 0
  %2 = sub i32 0, %0
  %3 = select i1 %1, i32 %2, i32 %0
  ret i32 %3
}
"""

# A sum the late loop returns one iteration late. They differ from n = 2 on,
# and alive-tv without an unroll factor calls the pair correct.
LOOP = """define i32 @f(i32 noundef %0) {
entry:
  br label %loop

loop:
  %1 = phi i32 [ 0, %entry ], [ %3, %loop ]
  %2 = phi i32 [ 0, %entry ], [ %4, %loop ]
  %3 = add i32 %1, 1
  %4 = add i32 %2, %1
  %5 = icmp ult i32 %3, %0
  br i1 %5, label %loop, label %exit

exit:
  ret i32 %2
}
"""
LATE = LOOP.replace("ret i32 %2", "ret i32 %4")
# A function that frees its argument when it is not null.
FREES = """declare void @free(ptr)

define i32 @f(ptr noundef %0) {
entry:
  %1 = icmp eq ptr %0, null
  br i1 %1, label %none, label %some

none:
  ret i32 0

some:
  call void @free(ptr %0)
  ret i32 0
}
"""
# The same loop returning a sum that overflows at n = 2, and one that freezes its sum.
LOOP_POISON = LOOP.replace("ret i32 %2", "%6 = add nsw i32 %3, 2147483647\n  ret i32 %6")
LOOP_FROZEN = LOOP.replace("ret i32 %2", "%6 = freeze i32 %2\n  ret i32 %6")

# A null check the tgt drops, which holds because a null is UB at the call.
NULL_CHECKED = """define i32 @f(ptr noundef nonnull %0) {
entry:
  %1 = icmp eq ptr %0, null
  %2 = zext i1 %1 to i32
  ret i32 %2
}
"""
NULL_DROPPED = """define i32 @f(ptr noundef nonnull %0) {
entry:
  ret i32 0
}
"""
# Where the addition overflows the src may pick any value, the tgt's 7 too.
OVERFLOW_FROZEN = """define i32 @f(i32 noundef %0) {
entry:
  %1 = add nsw i32 %0, 1
  %2 = freeze i32 %1
  ret i32 %2
}
"""
OVERFLOW_PICKED = """define i32 @f(i32 noundef %0) {
entry:
  %1 = add i32 %0, 1
  %2 = icmp eq i32 %0, 2147483647
  %3 = select i1 %2, i32 7, i32 %1
  ret i32 %3
}
"""


# j counts the even numbers below n and i all of them, so j <= i on every
# iteration. The nuw on i.next holds by the branch into the body; the nuw on
# the final sub needs that invariant.
PARITY = """define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %j = phi i32 [ 0, %entry ], [ %j.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  %inc = zext i1 %even to i32
  %j.next = add i32 %j, %inc
  %i.next = add i32 %i, 1
  br label %head

exit:
  %d = sub i32 %i, %j
  ret i32 %d
}
"""
PARITY_NUW = PARITY.replace("%i.next = add i32", "%i.next = add nuw i32")

# A count kept in a stack slot, as -O0 code keeps it, and in a phi of the same
# name, as mem2reg leaves it.
SLOT_COUNT = """define i32 @f(i32 %n) {
entry:
  %i = alloca i32, align 4
  store i32 0, ptr %i, align 4
  br label %head

head:
  %0 = load i32, ptr %i, align 4
  %c = icmp ult i32 %0, %n
  br i1 %c, label %body, label %exit

body:
  %1 = load i32, ptr %i, align 4
  %2 = add i32 %1, 1
  store i32 %2, ptr %i, align 4
  br label %head

exit:
  %3 = load i32, ptr %i, align 4
  ret i32 %3
}
"""

# SLOT_COUNT with a slot its body stores into before it reads it, so that the
# slot's value at the header is never read.
DEAD_COUNT = SLOT_COUNT.replace(
  "  store i32 0, ptr %i, align 4\n", "  %t = alloca i32, align 4\n  store i32 0, ptr %i, align 4\n"
).replace(
  "  %2 = add i32 %1, 1\n",
  "  store i32 %1, ptr %t, align 4\n  %t1 = load i32, ptr %t, align 4\n  %2 = add i32 %t1, 1\n",
)

PHI_COUNT = """define i32 @f(i32 %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %i
}
"""
PARITY_SUB_NUW = PARITY_NUW.replace("%d = sub i32", "%d = sub nuw i32")
ORDER = [{"op": "ule", "lhs": "!1", "rhs": "!0"}]

# i summed m times for each i below n. The tgt's zext nneg needs i >= 0, which
# holds by induction over the outer loop, whose every iteration runs the inner one.
NESTED = """define i64 @f(i32 noundef %n, i32 noundef %m) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %latch ]
  %s = phi i64 [ 0, %entry ], [ %t, %latch ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %k = sext i32 %i to i64
  br label %inner

inner:
  %j = phi i32 [ 0, %body ], [ %j.next, %step ]
  %t = phi i64 [ %s, %body ], [ %t.next, %step ]
  %go = icmp slt i32 %j, %m
  br i1 %go, label %step, label %latch

step:
  %t.next = add i64 %t, %k
  %j.next = add nsw i32 %j, 1
  br label %inner

latch:
  %i.next = add nsw i32 %i, 1
  br label %head

exit:
  ret i64 %s
}
"""
NESTED_NNEG = NESTED.replace("sext i32 %i", "zext nneg i32 %i")
# i >= 0 over the outer loop's i, which is parameter 0 of its iteration k.
NONNEGATIVE = [{"op": "sge", "lhs": "!0", "rhs": 0}]
# A count up to n, which the tgt says returns no negative value: that holds
# because i >= 0 does, by induction.
COUNT = """define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %i.next = add nsw i32 %i, 1
  br label %head

exit:
  ret i32 %i
}
"""
COUNT_RANGE = COUNT.replace("define i32 @f", "define range(i32 0, -2147483648) i32 @f")
NATURAL = {"range": {"min": 0, "max": -2147483648}}
# What the inner loop l carries for it: i, its parameter 3, is at least 0 and
# below n, its parameter 4, so that i + 1 neither wraps nor turns negative.
CARRIED = [{"op": "sge", "lhs": "!3", "rhs": 0}, {"op": "slt", "lhs": "!3", "rhs": "!4"}]


def llops(subcommand: str, request: dict) -> dict:
  done = subprocess.run(
    [LLOPS, subcommand], input=json.dumps(request), capture_output=True, text=True
  )
  answer = json.loads(done.stdout)
  assert answer.get("ok"), answer
  return answer


def canonical(text: str) -> str:
  """The text as the run stores a program, which is what a package carries."""
  return llops("canon", {"module": text})["module"]


def llrwt(rules: list, module: str) -> str:
  with tempfile.TemporaryDirectory() as scratch:
    path = Path(scratch) / "in.ll"
    path.write_text(module)
    # The toolchain's own translators: a system mlir-translate prints a
    # generic form llrwt does not parse, which is a build mistake rather
    # than a rewrite outcome.
    done = subprocess.run(
      [
        LLRWT,
        "--rules",
        ",".join(rules),
        "--allow-unregistered-dialect",
        "--mlir-translate",
        MLIR_TRANSLATE,
        "--mlir-opt",
        MLIR_OPT,
        str(path),
      ],
      capture_output=True,
      text=True,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout


# A loop no run enters, x being equal to itself wherever it is not poison,
# and the tgt that does not have it.
UNENTERED = """define i32 @f(i32 %x) {
entry:
  %c = icmp eq i32 %x, %x
  br i1 %c, label %exit, label %head

head:
  %i = phi i32 [ 0, %entry ], [ %n, %head ]
  %n = add i32 %i, 1
  %d = icmp ult i32 %n, 10
  br i1 %d, label %head, label %done

done:
  ret i32 0

exit:
  ret i32 %x
}
"""
UNENTERED_GONE = "define i32 @f(i32 %x) {\nentry:\n  ret i32 %x\n}\n"


class Built:
  """A package under construction."""

  def __init__(self, root: Path):
    self.root = root
    (self.root / "programs").mkdir(parents=True)
    self.goals: dict[str, dict] = {}

  def program(self, text: str) -> str:
    digest = hashlib.sha256(text.encode()).hexdigest()
    (self.root / "programs" / f"{digest}.ll").write_text(text)
    return digest

  def goal(self, gid: str, start: dict, end: dict, steps: list, discharge: dict) -> None:
    self.goals[gid] = {"start": start, "steps": steps, "end": end, "discharge": discharge}

  def write(
    self,
    root: str = "g1",
    version: int = 1,
    verdict: str = "verified",
  ) -> Path:
    manifest = {
      "version": version,
      "verdict": verdict,
      "root": root,
      "toolchain": {},
      "goals": self.goals,
    }
    (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return self.root

  def refutation(
    self, src: str, tgt: str, input: list[dict], unroll: int = 0, source: str = "alive2"
  ) -> Path:
    """A counterexample package: the pair, the input it is refuted at, and the checker."""
    manifest = {
      "version": 1,
      "verdict": "counterexample",
      "root": "g1",
      "source": source,
      "toolchain": {},
      "pair": {"src": self.program(src), "tgt": self.program(tgt)},
      "input": input,
      **({"unroll": unroll} if unroll else {}),
      "divergence": "whatever the run said",
    }
    (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return self.root

  def refuted(self, src: str, tgt: str, unroll: int = 0) -> Path:
    """A counterexample package the checker itself refuted: the pair, and no input."""
    manifest = {
      "version": 1,
      "verdict": "counterexample",
      "root": "g1",
      "source": "alive2",
      "toolchain": {},
      "pair": {"src": self.program(src), "tgt": self.program(tgt)},
      **({"unroll": unroll} if unroll else {}),
    }
    (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return self.root

  def bend(self, change) -> None:
    """Rewrite the manifest, which is what a tampered package looks like."""
    path = self.root / "manifest.json"
    manifest = json.loads(path.read_text())
    change(manifest)
    path.write_text(json.dumps(manifest, indent=2))


def run(package: Path, *options: str) -> subprocess.CompletedProcess:
  return subprocess.run(
    [sys.executable, str(CHECK), str(package), *options],
    capture_output=True,
    text=True,
  )


def named(package: Path) -> subprocess.CompletedProcess:
  """Run with the binaries named, which is what most of these need."""
  return run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS)


# A loop that tests at its top, and the same loop rotated, which only
# reshapes its control flow.
LOOP_TOP = """define i32 @f(i32 %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp slt i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
"""

LOOP_ROTATED = """define i32 @f(i32 %n) {
entry:
  %c0 = icmp slt i32 0, %n
  br i1 %c0, label %body, label %exit

body:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %s.next = add i32 %s, %i
  %i.next = add i32 %i, 1
  %c = icmp slt i32 %i.next, %n
  br i1 %c, label %body, label %exit

exit:
  %r = phi i32 [ 0, %entry ], [ %s.next, %body ]
  ret i32 %r
}
"""

# A load through a pointer argument, which -O3 marks readonly and argmem-only.
READ = """define i32 @f(ptr %p) {
entry:
  %v = load i32, ptr %p, align 4
  ret i32 %v
}
"""


@unittest.skipUnless(HAVE, "needs alive-tv and llops")
class Case(unittest.TestCase):
  def setUp(self) -> None:
    self.dir = Path(tempfile.mkdtemp())
    self.built = Built(self.dir / "package")
    self.src = self.built.program(SRC)
    self.tgt = self.built.program(TGT)

  def tearDown(self) -> None:
    shutil.rmtree(self.dir, ignore_errors=True)

  def leaf(self) -> Path:
    """The smallest certificate: one goal, discharged by one check."""
    pair = {"src": self.src, "tgt": self.tgt}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    return self.built.write()

  def interposed(self, rhs_src: str = "") -> Path:
    """A root proved through a program between its two: a multiply by two
    becomes a sum with itself, which becomes the shift."""
    middle = self.built.program(SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
    pair = {"src": self.src, "tgt": self.tgt}
    discharge = {"kind": "interpose", "program": middle, "lhs": "g2", "rhs": "g3"}
    self.built.goal("g1", pair, pair, [], discharge)
    lhs = {"src": self.src, "tgt": middle}
    self.built.goal("g2", lhs, lhs, [], {"kind": "check"})
    rhs = {"src": rhs_src or middle, "tgt": self.tgt}
    self.built.goal("g3", rhs, rhs, [], {"kind": "check"})
    return self.built.write()

  def cased(self, src: str = SRC, tgt: str = TGT, fails: str = "sge", recorded=None) -> Path:
    """A root split by cases on its parameter's sign, each case checked by
    alive2: g2 assumes `!0 slt 0`, and g3 assumes `fails` in its place."""
    predicate = {"op": "slt", "lhs": "!0", "rhs": 0}
    pair = {"src": self.built.program(canonical(src)), "tgt": self.built.program(canonical(tgt))}
    discharge = {"kind": "case", "on": recorded or predicate, "holds": "g2", "fails": "g3"}
    self.built.goal("g1", pair, pair, [], discharge)
    for gid, op in (("g2", "slt"), ("g3", fails)):
      anchor = {"at": "start", "fn": "f"}
      assumed = [{**predicate, "op": op}]
      case = {
        side: self.built.program(
          canonical(
            llops("assume", {"module": text, "anchor": anchor, "assertions": assumed})["module"]
          )
        )
        for side, text in (("src", src), ("tgt", tgt))
      }
      self.built.goal(gid, case, case, [], {"kind": "check"})
    return self.built.write()

  def poison_cased(self, src: str, tgt: str, fails: str = "poison") -> Path:
    """A root whose parameter may be poison, split by cases on whether it is
    (g2 makes it noundef, g3 puts poison in its place), and g2 cut again on
    its sign, each leaf checked by alive2."""
    pair = {"src": self.built.program(canonical(src)), "tgt": self.built.program(canonical(tgt))}
    texts = {"src": canonical(src), "tgt": canonical(tgt)}
    made = {
      gid: {
        side: canonical(llops(cmd, {"module": texts[side], **request})["module"]) for side in texts
      }
      for gid, cmd, request in (
        ("g2", "attrs", {"fn": "f", "param": 0, "attrs": {"noundef": True}}),
        ("g3", "poison", {"param": 0})
        if fails == "poison"
        else ("g3", "attrs", {"fn": "f", "param": 0, "attrs": {"noundef": True}}),
      )
    }
    on = {"defined": "!0"}
    self.built.goal("g1", pair, pair, [], {"kind": "case", "on": on, "holds": "g2", "fails": "g3"})
    sign = {"op": "slt", "lhs": "!0", "rhs": 0}
    defined = {side: self.built.program(made["g2"][side]) for side in texts}
    discharge = {"kind": "case", "on": sign, "holds": "g4", "fails": "g5"}
    self.built.goal("g2", defined, defined, [], discharge)
    poisoned = {side: self.built.program(made["g3"][side]) for side in texts}
    self.built.goal("g3", poisoned, poisoned, [], {"kind": "check"})
    start = {"at": "start", "fn": "f"}
    for gid, op in (("g4", "slt"), ("g5", "sge")):
      assumed = {"anchor": start, "assertions": [{**sign, "op": op}]}
      case = {
        side: self.built.program(
          canonical(llops("assume", {"module": made["g2"][side], **assumed})["module"])
        )
        for side in texts
      }
      self.built.goal(gid, case, case, [], {"kind": "check"})
    return self.built.write()

  def windowed(self, was: str = "", now: str = "", at: str = "#0", to: str = "") -> dict:
    """A goal whose one step was narrowed to the window it changed.

    The body is longer than the window on purpose: what the step claims is
    that everything outside those lines came through untouched, and what
    says so is the two halves inlining back into one outer. Without a pair,
    a multiply becomes a shift at the head of a short body.
    """
    head = "define i32 @f(i32 %0) {\nentry:\n"
    tail = "  %2 = add i32 %1, 1\n  ret i32 %2\n}\n"
    was = llops("canon", {"module": was or f"{head}  %1 = mul i32 %0, 2\n{tail}"})["module"]
    now = llops("canon", {"module": now or f"{head}  %1 = shl i32 %0, 1\n{tail}"})["module"]
    cut = [
      llops("outline", {"module": module, "cut": at, "to": to or at, "callee": "w"})
      for module in (was, now)
    ]
    outer = llops("canon", {"module": cut[0]["outer"]})["module"]
    step = {
      "kind": "window",
      "side": "src",
      "from": self.built.program(was),
      "to": self.built.program(now),
      "window": {
        "callee": "w",
        "outer": self.built.program(outer),
        "from": self.built.program(llops("canon", {"module": cut[0]["callee"]})["module"]),
        "to": self.built.program(llops("canon", {"module": cut[1]["callee"]})["module"]),
      },
    }
    self.built.goal(
      "g1",
      {"src": step["from"], "tgt": step["to"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    return step

  def rewritten(self) -> dict:
    """A goal whose one step the verified rewriter certified.

    The `to` program is what llrwt itself prints for the rules, canonicalized
    like every stored program: what the replay reruns is the same invocation,
    and what says the step holds is byte equality with the recorded program.
    """
    was = llops("canon", {"module": ZERO_ADD})["module"]
    now = llops("canon", {"module": llrwt(["addi-zero-to-x"], ZERO_ADD)})["module"]
    step = {
      "kind": "rewrite",
      "side": "src",
      "from": self.built.program(was),
      "to": self.built.program(now),
      "rules": ["addi-zero-to-x"],
      "invocation": {
        "binary": LLRWT,
        "rules": ["addi-zero-to-x"],
        "timeoutMs": 30000,
        "mlirTranslate": MLIR_TRANSLATE,
        "mlirOpt": MLIR_OPT,
      },
    }
    self.built.goal(
      "g1",
      {"src": step["from"], "tgt": step["to"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    return step

  def detached(self, src: str, tgt: str, tgt_only: dict | None = None) -> dict:
    """A root loop cut at its header, both halves as detach leaves them."""
    request = {"module": src, "side": "src", "block": "%head", "callee": "k"}
    s = llops("detach", request)
    live = {p["live"]: p["live"] for p in s["params"]}
    tgt_request = {"module": tgt, "side": "tgt", "block": "%head", "callee": "k"}
    value_map = {**live, **(tgt_only or {})}
    t = llops("detach", {**tgt_request, "params": s["params"], "value_map": value_map})
    if tgt_only:
      s = llops("detach", {**request, "params": t["params"]})

    def stored(text: str) -> str:
      return self.built.program(llops("canon", {"module": text})["module"])

    whole = {"src": stored(src), "tgt": stored(tgt)}
    outer = {"src": stored(s["outer"]), "tgt": stored(t["outer"])}
    inner = {"src": stored(s["callee"]), "tgt": stored(t["callee"])}
    phis = {"src": s["phis"], "tgt": t["phis"]}
    cut = {"kind": "cut", "callee": "k", "detach": {"phis": phis, "hypothesis": "k.ih"}}
    slots = {"src": s.get("slots", []), "tgt": t.get("slots", [])}
    if slots["src"] or slots["tgt"]:
      cut["slots"] = slots
    self.built.goal("g1", whole, whole, [], {**cut, "outer": "g2", "inner": "g3"})
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    return {"outer": outer, "inner": inner}

  def src_alone(self, src: str = UNENTERED, tgt: str = UNENTERED_GONE) -> dict:
    """A root cut on its src alone at the loop's header."""
    s = llops("detach", {"module": src, "side": "src", "block": "%head", "callee": "k"})

    def stored(text: str) -> str:
      return self.built.program(llops("canon", {"module": text})["module"])

    whole = {"src": stored(src), "tgt": stored(tgt)}
    outer = {"src": stored(s["outer"]), "tgt": whole["tgt"]}
    inner = {"src": stored(s["callee"]), "tgt": stored(s["callee"])}
    detach = {"phis": {"src": s["phis"], "tgt": []}, "hypothesis": "k.ih"}
    cut = {"kind": "cut", "callee": "k", "detach": detach, "src_alone": True}
    self.built.goal("g1", whole, whole, [], {**cut, "outer": "g2", "inner": "g3"})
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    return {"whole": whole, "outer": outer, "inner": inner}

  def text(self, digest: str) -> str:
    return (self.built.root / "programs" / f"{digest}.ll").read_text()

  def assumed(self, digest: str, anchor: dict, assertions: list = ORDER) -> str:
    """The program with `assertions` assumed at `anchor`, stored as a run stores it."""
    request = {"module": self.text(digest), "anchor": anchor, "assertions": assertions}
    return self.built.program(canonical(llops("assume", request)["module"]))

  def unfolded(self, digest: str, callee: str | None = None) -> str:
    """The program with k's body at each call of k.ih, or of k given the
    callee, stored as a run stores it."""
    request = {"module": self.text(digest), "hypothesis": "k.ih"}
    if callee:
      request["callee"] = self.text(callee)
    return self.built.program(canonical(llops("unfold", request)["module"]))

  def declared(self, digest: str, fn: str, fact: dict | None) -> str:
    """The program with `fact` on parameter 0 of `fn`, as a strengthen states it."""
    if fact is None:
      return digest
    request = {"module": self.text(digest), "fn": fn, "param": 0, "attrs": fact}
    return self.built.program(canonical(llops("attrs", request)["module"]))

  def claimed(self, inner: dict, assertions: list = ORDER, fact: dict | None = None) -> dict:
    """The callee's pair as a strengthen of k with `assertions` and `fact` leaves it."""
    start, calls = {"at": "start", "fn": "k"}, {"at": "before_calls", "fn": "k.ih"}
    entered = {
      side: self.assumed(self.declared(inner[side], "k", fact), start, assertions)
      for side in ("src", "tgt")
    }
    tgt = self.assumed(self.declared(entered["tgt"], "k.ih", fact), calls, assertions)
    return {"src": entered["src"], "tgt": tgt}

  def returning(self, digest: str, fns: list, facts: dict) -> str:
    """The program with `facts` on the return of each of `fns`, as a strengthen states them."""
    text = self.text(digest)
    for fn in fns:
      text = llops("attrs", {"module": text, "fn": fn, "return": True, "attrs": facts})["module"]
    return self.built.program(canonical(text))

  def returned(
    self, facts: dict = NATURAL, outer_facts: dict | None = None, alone: bool = True
  ) -> Path:
    """The count proved to return what the tgt says: i >= 0 assumed at the
    iteration's entry and proved before each call, then `facts` proved of the
    iteration's src with k.ih returning them, in a strengthening of their own
    unless `alone` is false, and put on k's declaration in the outer, or
    `outer_facts` there instead."""
    halves = self.detached(COUNT, COUNT_RANGE)
    outer, inner = halves["outer"], halves["inner"]
    calls = {"at": "before_calls", "fn": "k"}
    entered = {side: self.assumed(outer[side], calls, NONNEGATIVE) for side in outer}
    steps = [
      {"kind": "check", "side": side, "from": outer[side], "to": entered[side]} for side in outer
    ]
    told = outer_facts or facts
    returns = {side: self.returning(entered[side], ["k"], told) for side in entered}
    steps.append({"kind": "strengthen", "from": entered, "to": returns, "ret_attrs": told})
    self.built.goal("g2", outer, returns, steps, {"kind": "check"})

    claim = self.claimed(inner, NONNEGATIVE)
    calls = {"at": "before_calls", "fn": "k.ih"}
    if alone:
      kept = self.assumed(claim["src"], calls, NONNEGATIVE)
      by = [{"gid": "g2", "hash": entered["src"]}, {"gid": "g3", "hash": kept}]
      after = {"src": kept, "tgt": claim["tgt"]}
      strong = {side: self.returning(after[side], ["k", "k.ih"], facts) for side in after}
      steps = [
        {"kind": "strengthen", "from": inner, "to": claim, "predicates": NONNEGATIVE, "by": by},
        {"kind": "check", "side": "src", "from": claim["src"], "to": kept},
        {"kind": "strengthen", "from": after, "to": strong, "ret_attrs": facts},
      ]
      end = strong
    else:
      strong = {side: self.returning(claim[side], ["k", "k.ih"], facts) for side in claim}
      kept = self.assumed(strong["src"], calls, NONNEGATIVE)
      by = [{"gid": "g2", "hash": entered["src"]}, {"gid": "g3", "hash": kept}]
      step = {"kind": "strengthen", "from": inner, "to": strong, "predicates": NONNEGATIVE}
      steps = [
        {**step, "ret_attrs": facts, "by": by},
        {"kind": "check", "side": "src", "from": strong["src"], "to": kept},
      ]
      end = {"src": kept, "tgt": strong["tgt"]}
    self.built.goal("g3", inner, end, steps, {"kind": "check"})
    return self.built.write()

  def invariant(self, kept: bool = True, fact: dict | None = None) -> Path:
    """The parity loop proved with j <= i, assumed at the callee's entry and
    proved before each call: the outer's (on entry) and k.ih's (each
    iteration), unless `kept` is false. A `fact` about i goes on the
    declaration of the function each call goes to, and on k's parameter."""
    halves = self.detached(PARITY, PARITY_SUB_NUW)
    outer, inner = halves["outer"], halves["inner"]
    assumed, declared = self.assumed, self.declared

    entered = assumed(declared(outer["src"], "k", fact), {"at": "before_calls", "fn": "k"})
    steps = [{"kind": "check", "side": "src", "from": outer["src"], "to": entered}]
    outer_end = {"src": entered, "tgt": declared(outer["tgt"], "k", fact)}
    if fact is not None:
      steps.append({"kind": "check", "side": "tgt", "from": outer["tgt"], "to": outer_end["tgt"]})
    self.built.goal("g2", outer, outer_end, steps, {"kind": "check"})

    strong = self.claimed(inner, ORDER, fact)
    kept_by = assumed(declared(strong["src"], "k.ih", fact), {"at": "before_calls", "fn": "k.ih"})
    by = [{"gid": "g2", "hash": entered}] + ([{"gid": "g3", "hash": kept_by}] if kept else [])
    claim = {"kind": "strengthen", "from": inner, "to": strong, "predicates": ORDER, "by": by}
    steps = [{**claim, **({"param_attrs": {"0": fact}} if fact is not None else {})}]
    if kept:
      steps.append({"kind": "check", "side": "src", "from": strong["src"], "to": kept_by})
    end = {"src": kept_by if kept else strong["src"], "tgt": strong["tgt"]}
    self.built.goal("g3", inner, end, steps, {"kind": "check"})
    return self.built.write()

  def inner_cut(self, gid: str, pair: dict, children: tuple[str, str]) -> tuple[dict, dict]:
    """Goal `gid` cut at the inner loop's header, %bb3 in its iteration, into l."""
    request = {"side": "src", "block": "%bb3", "callee": "l"}
    s = llops("detach", {**request, "module": self.text(pair["src"])})
    live = {p["live"]: p["live"] for p in s["params"]}
    request = {**request, "side": "tgt", "params": s["params"], "value_map": live}
    t = llops("detach", {**request, "module": self.text(pair["tgt"])})

    def stored(text: str) -> str:
      return self.built.program(canonical(text))

    outer = {"src": stored(s["outer"]), "tgt": stored(t["outer"])}
    inner = {"src": stored(s["callee"]), "tgt": stored(t["callee"])}
    detach = {"phis": {"src": s["phis"], "tgt": t["phis"]}, "hypothesis": "l.ih"}
    cut = {"kind": "cut", "callee": "l", "detach": detach}
    self.built.goal(gid, pair, pair, [], {**cut, "outer": children[0], "inner": children[1]})
    return outer, inner

  def nested(self, fact: dict | None = None, carried: list = CARRIED) -> dict:
    """The nested sum proved with i >= 0 through its iteration's interposed goal."""
    halves = self.detached(NESTED, NESTED_NNEG)
    outer, inner = halves["outer"], halves["inner"]
    calls = {"at": "before_calls", "fn": "k"}
    entered = {
      side: self.assumed(self.declared(outer[side], "k", fact), calls, NONNEGATIVE)
      for side in outer
    }
    steps = [
      {"kind": "check", "side": side, "from": outer[side], "to": entered[side]} for side in outer
    ]
    self.built.goal("g2", outer, entered, steps, {"kind": "check"})

    claim = self.claimed(inner, NONNEGATIVE, fact)
    calls = {"at": "before_calls", "fn": "k.ih"}
    between = self.assumed(self.declared(claim["src"], "k.ih", fact), calls, NONNEGATIVE)
    by = [{"gid": "g2", "hash": entered["src"]}, {"gid": "g3", "hash": between}]
    step = {"kind": "strengthen", "from": inner, "to": claim, "predicates": NONNEGATIVE, "by": by}
    step.update({"param_attrs": {"0": fact}} if fact is not None else {})
    interposed = {"kind": "interpose", "program": between, "lhs": "g4", "rhs": "g5"}
    self.built.goal("g3", inner, claim, [step], interposed)

    o, i = self.inner_cut("g4", {"src": claim["src"], "tgt": between}, ("g6", "g7"))
    calls = {"at": "before_calls", "fn": "l"}
    held = {side: self.assumed(o[side], calls, carried) for side in o}
    steps = [{"kind": "check", "side": side, "from": o[side], "to": held[side]} for side in o]
    self.built.goal("g6", o, held, steps, {"kind": "check"})
    start, calls = {"at": "start", "fn": "l"}, {"at": "before_calls", "fn": "l.ih"}
    entered = {side: self.assumed(i[side], start, carried) for side in i}
    strong = {"src": entered["src"], "tgt": self.assumed(entered["tgt"], calls, carried)}
    kept = self.assumed(strong["src"], calls, carried)
    by = [{"gid": "g6", "hash": held["src"]}, {"gid": "g7", "hash": kept}]
    steps = [
      {"kind": "strengthen", "from": i, "to": strong, "predicates": carried, "by": by},
      {"kind": "check", "side": "src", "from": strong["src"], "to": kept},
    ]
    self.built.goal("g7", i, {"src": kept, "tgt": strong["tgt"]}, steps, {"kind": "check"})

    o, i = self.inner_cut("g5", {"src": between, "tgt": claim["tgt"]}, ("g8", "g9"))
    self.built.goal("g8", o, o, [], {"kind": "check"})
    self.built.goal("g9", i, i, [], {"kind": "check"})
    return {"package": self.built.write(), "claim": claim, "between": between}

  def verified(self, package: Path, saying: str = "VERIFIED - root") -> subprocess.CompletedProcess:
    done = named(package)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn(saying, done.stdout)
    return done

  def refused(self, package: Path, saying: str) -> None:
    done = named(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn(saying, done.stdout + done.stderr)


class TestGolden(Case):
  def test_a_leaf_verifies(self):
    self.verified(self.leaf())

  def test_a_loop_cut_at_its_header_verifies_by_induction(self):
    self.detached(PARITY, PARITY_NUW)
    self.verified(self.built.write())

  def test_a_cut_that_passes_what_a_slot_holds_verifies(self):
    # The tgt keeps the count in a phi, or in a slot of its own too.
    pairs = ((PHI_COUNT, {"src": [0], "tgt": []}), (SLOT_COUNT, {"src": [0], "tgt": [0]}))
    for n, (tgt, slots) in enumerate(pairs):
      with self.subTest(slots=slots):
        self.built = Built(self.dir / f"package{n}")
        self.detached(SLOT_COUNT, tgt)
        self.assertEqual(self.built.goals["g1"]["discharge"]["slots"], slots)
        self.verified(self.built.write())

  def test_a_cut_that_passes_a_dead_slot_as_poison_verifies(self):
    halves = self.detached(DEAD_COUNT, PHI_COUNT, {"%t": "poison"})
    self.assertEqual(self.built.goals["g1"]["discharge"]["slots"], {"src": [0, 1], "tgt": []})
    outer = (self.built.root / "programs" / f"{halves['outer']['src']}.ll").read_text()
    self.assertIn("i32 poison", outer)
    self.verified(self.built.write())

  def test_state_only_the_tgt_carries_verifies(self):
    # The tgt keeps a countdown nothing reads, and the src passes poison for it.
    counted = PARITY.replace(
      "  %c = icmp ult i32 %i, %n\n",
      "  %k = phi i32 [ %n, %entry ], [ %k.next, %body ]\n  %c = icmp ult i32 %i, %n\n",
    ).replace(
      "  %i.next = add i32 %i, 1\n", "  %i.next = add i32 %i, 1\n  %k.next = add i32 %k, -1\n"
    )
    self.assertEqual(counted.count("%k"), 4)
    halves = self.detached(PARITY, counted, {"k": "%k"})
    self.assertIn(
      "poison", (self.built.root / "programs" / f"{halves['outer']['src']}.ll").read_text()
    )
    self.verified(self.built.write())

  def test_a_loop_invariant_proved_on_entry_and_kept_verifies(self):
    self.verified(self.invariant())

  def test_a_loop_invariant_with_a_parameter_fact_verifies(self):
    # The proof at each call declares the fact on the function called and
    # assumes the predicate, which is the step the kernel rebuilds.
    package = self.invariant(fact={"noundef": True})
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertEqual(done.stdout.count("Predicate proof"), 2, done.stdout)

  def test_a_return_fact_that_holds_by_induction_verifies(self):
    done = self.verified(self.returned())
    self.assertNotIn("FAIL", done.stdout)

  def test_an_invariant_of_a_loop_that_holds_a_loop_verifies(self):
    self.verified(self.nested()["package"])

  def test_an_invariant_of_a_loop_that_holds_a_loop_with_a_parameter_fact_verifies(self):
    # The iteration's src declares the fact on k.ih only in the program
    # between, which is where its hypothesis is held to its definition.
    self.verified(self.nested(fact={"noundef": True})["package"])

  def test_a_tgt_step_that_drops_attributes_its_body_respects_verifies(self):
    plain = self.built.program(canonical(READ))
    marked = READ.replace("(ptr %p) {", "(ptr readonly %p) memory(argmem: read) {")
    marked = self.built.program(canonical(marked))
    step = {"kind": "check", "side": "tgt", "from": marked, "to": plain, "by": "respected"}
    end = {"src": plain, "tgt": plain}
    self.built.goal("g1", {"src": plain, "tgt": marked}, end, [step], {"kind": "check"})
    self.verified(self.built.write())

  def test_a_step_that_only_reshapes_control_flow_verifies_on_either_side(self):
    top = self.built.program(canonical(LOOP_TOP))
    rotated = self.built.program(canonical(LOOP_ROTATED))
    for side in ("src", "tgt"):
      with self.subTest(side=side):
        start = {"src": top, "tgt": rotated}
        if side == "tgt":
          start = {"src": rotated, "tgt": top}
        step = {"kind": "check", "side": side, "from": top, "to": rotated, "by": "reshaped"}
        end = {"src": rotated, "tgt": rotated}
        self.built.goal("g1", start, end, [step], {"kind": "check"})
        self.verified(self.built.write())

  def test_a_goal_proved_through_an_interposed_program_verifies(self):
    self.verified(self.interposed())

  def test_a_goal_proved_by_cases_verifies(self):
    self.verified(self.cased())

  def test_cases_that_leave_inputs_out_fail(self):
    # Both cases assume `!0 slt 0`, so an input where it fails lies in neither.
    done = run(self.cased(fails="slt"), "--alive-tv", ALIVE_TV, "--llops", LLOPS)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("Case reconstruction", done.stdout)

  def test_cases_on_a_parameter_that_may_be_poison_fail(self):
    # The tgt's x - x is poison where x is, and the src's 0 is not, so the pair
    # is refuted at x = poison; each case assumes a comparison of x, which a
    # poison x makes undefined, so both cases verify and only coverage fails.
    head = "define i32 @f(i32 %0) {\nentry:\n"
    zero = f"{head}  ret i32 0\n}}\n"
    cancelled = f"{head}  %1 = sub i32 %0, %0\n  ret i32 %1\n}}\n"
    done = run(self.cased(zero, cancelled), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("!0 may be poison, which lies in no case", done.stdout)
    rows = done.stdout.splitlines()
    proved = [row for row in rows if row.startswith("OK") and "Final refinement" in row]
    self.assertEqual(len(proved), 2, done.stdout)

  def test_cases_on_poison_and_then_a_comparison_verify(self):
    # Doubling and shifting agree on a poison x too, so all three leaves hold.
    loose = [text.replace("i32 noundef %0", "i32 %0") for text in (SRC, TGT)]
    done = run(self.poison_cased(*loose), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("!0 is poison or not", done.stdout)
    self.assertIn("VERIFIED - root", done.stdout)

  def test_the_case_where_a_parameter_is_poison_is_checked(self):
    # 0 against x - x holds wherever x is not poison, and the poison case refutes it.
    head = "define i32 @f(i32 %0) {\nentry:\n"
    zero = f"{head}  ret i32 0\n}}\n"
    cancelled = f"{head}  %1 = sub i32 %0, %0\n  ret i32 %1\n}}\n"
    done = run(self.poison_cased(zero, cancelled), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertNotEqual(done.returncode, 0, done.stdout)
    rows = done.stdout.splitlines()
    self.assertTrue(any(row.startswith("FAIL") and " g3 " in row for row in rows), done.stdout)

  def test_a_poison_case_that_is_not_the_parameter_poison_fails(self):
    # Both cases make %0 noundef, so a poison argument lies in neither.
    loose = [text.replace("i32 noundef %0", "i32 %0") for text in (SRC, TGT)]
    done = run(
      self.poison_cased(*loose, fails="noundef"), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v"
    )
    self.assertNotEqual(done.returncode, 0, done.stdout)
    rows = done.stdout.splitlines()
    failed = [row for row in rows if row.startswith("FAIL") and "Case reconstruction" in row]
    self.assertTrue(failed and all(" g3 " in row for row in failed), done.stdout)

  def test_cases_on_no_comparison_of_parameters_are_refused(self):
    package = self.cased(recorded={"op": "eq", "lhs": 0, "rhs": 0})
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("split by cases on no comparison", done.stdout + done.stderr)

  def test_a_goal_whose_tgt_only_adds_attributes_its_body_respects_verifies(self):
    marked = READ.replace("(ptr %p) {", "(ptr readonly %p) memory(argmem: read) {")
    pair = {
      "src": self.built.program(canonical(READ)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.verified(self.built.write())

  def test_a_goal_whose_tgt_only_reshapes_its_src_verifies(self):
    pair = {
      "src": self.built.program(canonical(LOOP_TOP)),
      "tgt": self.built.program(canonical(LOOP_ROTATED)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "reshaped"})
    self.verified(self.built.write())

  def test_a_loop_unfolded_on_both_sides_verifies(self):
    inner = self.detached(PARITY, PARITY_NUW)["inner"]
    end = {side: self.unfolded(inner[side]) for side in ("src", "tgt")}
    steps = [
      {"kind": "unfold", "side": side, "from": inner[side], "to": end[side]}
      for side in ("src", "tgt")
    ]
    self.built.goal("g3", inner, end, steps, {"kind": "check"})
    self.verified(self.built.write())

  def test_an_outer_unfolded_on_both_sides_verifies(self):
    halves = self.detached(PARITY, PARITY_NUW)
    outer, inner = halves["outer"], halves["inner"]
    end = {side: self.unfolded(outer[side], inner[side]) for side in ("src", "tgt")}
    steps = [
      {"kind": "unfold", "side": side, "from": outer[side], "to": end[side]}
      for side in ("src", "tgt")
    ]
    self.built.goal("g2", outer, end, steps, {"kind": "check"})
    self.verified(self.built.write())

  def test_a_loop_against_itself_verifies_with_no_solver(self):
    pair = {"src": self.built.program(canonical(LOOP)), "tgt": self.built.program(canonical(LOOP))}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    done = self.verified(self.built.write())
    self.assertIn("0 solver queries", done.stdout)

  def test_a_pair_that_branches_without_looping_verifies(self):
    pair = {"src": self.built.program(canonical(BRANCH)), "tgt": self.built.program(SELECT)}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.verified(self.built.write())

  def test_a_chain_verifies(self):
    # One certified step, then the pair it was left with.
    nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
    self.built.goal(
      "g1",
      {"src": nsw, "tgt": wraps},
      {"src": wraps, "tgt": wraps},
      [{"kind": "check", "side": "src", "from": nsw, "to": wraps}],
      {"kind": "check"},
    )
    self.verified(self.built.write())

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_verifies(self):
    self.rewritten()
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    # No solver is asked about the step itself: the rewrite is replayed.
    self.assertIn("Rewriter replay", done.stdout)

  def test_a_cut_verifies(self):
    self.verified(self.cut())

  def test_a_cut_of_the_src_alone_at_an_instruction_verifies(self):
    # The suffix runs only where x is not x, which no defined x is.
    src = """define i32 @f(i32 %x) {
entry:
  %c = icmp eq i32 %x, %x
  br i1 %c, label %exit, label %dead

dead:
  %y = mul i32 %x, 3
  %z = add i32 %y, 1
  ret i32 %z

exit:
  ret i32 %x
}
"""
    s = llops("outline", {"module": canonical(src), "side": "src", "cut": "%3", "callee": "g"})
    whole = {
      "src": self.built.program(canonical(src)),
      "tgt": self.built.program(canonical(UNENTERED_GONE)),
    }
    outer = {"src": self.built.program(canonical(s["outer"])), "tgt": whole["tgt"]}
    callee = self.built.program(canonical(s["callee"]))
    inner = {"src": callee, "tgt": callee}
    cut = {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3", "src_alone": True}
    self.built.goal("g1", whole, whole, [], cut)
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    self.verified(self.built.write())

  def test_a_cut_of_the_src_alone_verifies(self):
    # The tgt never calls the loop, and the outer shows the src never does.
    self.src_alone()
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertIn("starts from the parent's tgt", done.stdout)

  def test_a_cut_at_an_instruction_of_a_body_that_branches_verifies(self):
    # The src's callee is the rest of its entry block and both blocks after
    # it; the kernel puts it back with inline, at the call its block returns.
    src = llops("canon", {"module": BRANCH})["module"]
    tgt = llops("canon", {"module": SELECT})["module"]
    s = llops("outline", {"module": src, "side": "src", "cut": "%1", "callee": "g"})
    request = {"module": tgt, "side": "tgt", "cut": "%1", "callee": "g", "params": s["params"]}
    t = llops("outline", {**request, "value_map": {"%0": "%0"}})

    def stored(text: str) -> str:
      return self.built.program(llops("canon", {"module": text})["module"])

    whole = {"src": stored(src), "tgt": stored(tgt)}
    outer = {"src": stored(s["outer"]), "tgt": stored(t["outer"])}
    inner = {"src": stored(s["callee"]), "tgt": stored(t["callee"])}
    cut = {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
    self.built.goal("g1", whole, whole, [], cut)
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    self.verified(self.built.write())

  def test_a_narrowed_step_verifies(self):
    self.windowed()
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    # Both halves go back into the outer before the small pair is asked:
    # what the step claims about the rest of the body is checked first.
    self.assertEqual(
      done.stdout.count("inline the from half") + done.stdout.count("inline the to half"), 2
    )

  def test_a_window_step_inside_a_loop_verifies(self):
    # The outer loops and is only compared; alive-tv is asked about the two
    # windows, which do not.
    self.windowed(LOOP, LOOP.replace("add i32 %2, %1", "add i32 %1, %2"), "#4")
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertIn("1 solver query ", done.stdout)

  def test_a_window_that_hands_back_both_values_a_loop_reads_verifies(self):
    now = LOOP.replace("add i32 %1, 1", "add i32 1, %1").replace("add i32 %2, %1", "add i32 %1, %2")
    self.windowed(LOOP, now, "#3", "#4")
    self.verified(self.built.write())

  def test_a_window_step_that_swaps_two_values_a_loop_reads_verifies(self):
    named = LOOP.replace("%3", "%a").replace("%4", "%b")
    now = named.replace(
      "  %a = add i32 %1, 1\n  %b = add i32 %2, %1\n",
      "  %b = add i32 %2, %1\n  %a = add i32 %1, 1\n",
    )
    self.assertNotEqual(now, named)
    self.windowed(LOOP, now, "#3", "#4")
    self.verified(self.built.write())

  def test_a_conditioned_window_step_verifies(self):
    head = "define i32 @f(i32 noundef %0) {\nentry:\n  %1 = and i32 %0, 255\n"
    tail = "  ret i32 %2\n"
    was = llops("canon", {"module": f"{head}  %2 = add nuw i32 %1, 1\n{tail}}}\n"})["module"]
    now = llops("canon", {"module": f"{head}  %2 = add i32 %1, 1\n{tail}}}\n"})["module"]
    cut = [
      llops("outline", {"module": module, "cut": "#1", "to": "#1", "callee": "w"})
      for module in (was, now)
    ]
    outer = llops("canon", {"module": cut[0]["outer"]})["module"]
    step = {
      "kind": "window",
      "side": "src",
      "from": self.built.program(was),
      "to": self.built.program(now),
      "window": {
        "callee": "w",
        "outer": self.built.program(outer),
        "from": self.built.program(llops("canon", {"module": cut[0]["callee"]})["module"]),
        "to": self.built.program(llops("canon", {"module": cut[1]["callee"]})["module"]),
        "preconditions": {0: {"noundef": True, "range": {"min": 0, "max": 256}}},
      },
    }
    self.built.goal(
      "g1",
      {"src": step["from"], "tgt": step["to"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertEqual(
      done.stdout.count("inline the from half") + done.stdout.count("inline the to half"), 2
    )

  def predicated(self, predicates: list) -> Path:
    """A src step that adds `nuw` to an add of the masked input, under `predicates`."""
    head = "define i32 @f(i32 noundef %0) {\nentry:\n  %1 = and i32 %0, 255\n"
    tail = "  ret i32 %2\n"
    was, now = (
      llops("canon", {"module": f"{head}  %2 = add{flag} i32 %1, 1\n{tail}}}\n"})["module"]
      for flag in ("", " nuw")
    )
    cut = [
      llops("outline", {"module": module, "cut": "#1", "to": "#1", "callee": "w"})
      for module in (was, now)
    ]
    outer = llops("canon", {"module": cut[0]["outer"]})["module"]
    window = {
      "callee": "w",
      "outer": self.built.program(outer),
      "from": self.built.program(llops("canon", {"module": cut[0]["callee"]})["module"]),
      "to": self.built.program(llops("canon", {"module": cut[1]["callee"]})["module"]),
    }
    if predicates:
      window["predicates"] = predicates
    step = {
      "kind": "window",
      "side": "src",
      "from": self.built.program(was),
      "to": self.built.program(now),
      "window": window,
    }
    self.built.goal(
      "g1",
      {"src": step["from"], "tgt": step["to"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    return self.built.write()

  def test_a_window_step_under_a_predicate_verifies(self):
    package = self.predicated([{"op": "ult", "lhs": "!0", "rhs": 256}])
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertIn("Window precondition", done.stdout)

  def test_a_window_predicate_that_does_not_hold_where_it_is_called_fails(self):
    # The masked input reaches 255, so `ult 128` is false at some call.
    package = self.predicated([{"op": "ult", "lhs": "!0", "rhs": 128}])
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("Window precondition", done.stdout)

  def test_a_window_predicate_that_names_an_outer_value_fails(self):
    # Before the call, %1 is the masked input, so the outer proves it; inside
    # a half only arguments can be named, so the same text cannot be assumed there.
    package = self.predicated([{"op": "ult", "lhs": "%1", "rhs": 256}])
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("only arguments may be named", done.stdout + done.stderr)

  def test_a_window_step_that_needs_its_predicate_fails_without_it(self):
    done = run(self.predicated([]), "--alive-tv", ALIVE_TV, "--llops", LLOPS)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("Window refinement", done.stdout)

  def test_a_conditioned_window_step_is_asked_about_the_side_it_replaces(self):
    # A tgt step's obligation runs backward (before refines after), so the
    # facts only have to hold where the AFTER whole is defined. Here the
    # after window drops into a division by zero outside the range, so it
    # is defined exactly where the facts hold, and the before window is
    # defined everywhere; asking the before whole instead would refuse the
    # step, and asking it is the mistake this pins.
    was = llops(
      "canon",
      {
        "module": (
          "define i32 @f(i32 noundef %0) {\nentry:\n  %1 = add i32 %0, 1\n  ret i32 %1\n}\n"
        )
      },
    )["module"]
    now = llops(
      "canon",
      {
        "module": (
          "define i32 @f(i32 noundef %0) {\n"
          "entry:\n"
          "  %1 = icmp ult i32 %0, 50\n"
          "  %2 = udiv i32 %0, 0\n"
          "  %3 = add i32 %0, 1\n"
          "  %4 = select i1 %1, i32 %3, i32 %2\n"
          "  ret i32 %4\n"
          "}\n"
        )
      },
    )["module"]
    cut = [
      llops("outline", {"module": module, "cut": "#0", "to": to, "callee": "w"})
      for module, to in ((was, "#0"), (now, "#3"))
    ]
    outer = llops("canon", {"module": cut[0]["outer"]})["module"]
    step = {
      "kind": "window",
      "side": "tgt",
      "from": self.built.program(was),
      "to": self.built.program(now),
      "window": {
        "callee": "w",
        "outer": self.built.program(outer),
        "from": self.built.program(llops("canon", {"module": cut[0]["callee"]})["module"]),
        "to": self.built.program(llops("canon", {"module": cut[1]["callee"]})["module"]),
        "preconditions": {0: {"noundef": True, "range": {"min": 0, "max": 50}}},
      },
    }
    self.built.goal(
      "g1",
      {"src": step["to"], "tgt": step["from"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertEqual(
      done.stdout.count("inline the from half") + done.stdout.count("inline the to half"), 2
    )

  def test_the_binaries_come_from_the_manifest(self):
    # A package is replayed by someone who was not there, so where the run
    # found its tools is part of what it records.
    self.leaf()
    self.built.bend(
      lambda m: m.update(
        {
          "toolchain": {
            "tools": {
              "alive-tv": {"path": ALIVE_TV, "llvm": "22.1.0"},
              "llops": {"path": LLOPS, "llvm": "22.1.0"},
            }
          }
        }
      )
    )
    done = run(self.built.root)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn(ALIVE_TV, done.stdout)
    self.assertIn("VERIFIED - root", done.stdout)

  def test_a_toolchain_that_is_not_the_recorded_one_is_said_so(self):
    self.leaf()
    self.built.bend(
      lambda m: m.update(
        {"toolchain": {"tools": {"alive-tv": {"path": ALIVE_TV, "llvm": "19.1.0"}}}}
      )
    )
    done = run(self.built.root, "--llops", LLOPS)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("the run used LLVM 19.1.0", done.stdout)

  def cut(self, tgt: str = TGT) -> Path:
    """A package whose root is discharged by a cut, built with llops."""
    canon = llops("canon", {"module": SRC})["module"]
    canon_tgt = llops("canon", {"module": tgt})["module"]
    src = llops("outline", {"module": canon, "side": "src", "cut": "%1", "callee": "g"})
    tgt = llops(
      "outline",
      {
        "module": canon_tgt,
        "side": "tgt",
        "cut": "%1",
        "callee": "g",
        "params": src["params"],
        "value_map": {"%0": "%0"},
      },
    )
    whole = {"src": self.built.program(canon), "tgt": self.built.program(canon_tgt)}
    outer = {
      "src": self.built.program(llops("canon", {"module": src["outer"]})["module"]),
      "tgt": self.built.program(llops("canon", {"module": tgt["outer"]})["module"]),
    }
    inner = {
      "src": self.built.program(llops("canon", {"module": src["callee"]})["module"]),
      "tgt": self.built.program(llops("canon", {"module": tgt["callee"]})["module"]),
    }
    self.built.goal(
      "g1", whole, whole, [], {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
    )
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    return self.built.write()

  def strengthened(self, proved: bool = True) -> Path:
    """A cut whose callee gained a parameter fact, a function attribute and a predicate."""
    package = TestGolden.cut(self)
    inner = self.built.goals["g3"]["start"]
    outer = self.built.goals["g2"]["start"]
    src_mod = (package / "programs" / f"{inner['src']}.ll").read_text()
    tgt_mod = (package / "programs" / f"{inner['tgt']}.ll").read_text()
    outer_src_mod = (package / "programs" / f"{outer['src']}.ll").read_text()
    outer_tgt_mod = (package / "programs" / f"{outer['tgt']}.ll").read_text()

    def transform_callee(mod):
      m = llops(
        "attrs",
        {"module": mod, "fn": "g", "param": 0, "attrs": {"noundef": True}},
      )["module"]
      m = llops("attrs", {"module": m, "fn": "g", "attrs": {"nounwind": True}})["module"]
      m = llops(
        "assume",
        {
          "module": m,
          "anchor": {"at": "start", "fn": "g"},
          "assertions": [PREDICATE],
        },
      )["module"]
      return llops("canon", {"module": m})["module"]

    def transform_outer(mod):
      m = llops(
        "attrs",
        {"module": mod, "fn": "g", "param": 0, "attrs": {"noundef": True}},
      )["module"]
      m = llops("attrs", {"module": m, "fn": "g", "attrs": {"nounwind": True}})["module"]
      return llops("canon", {"module": m})["module"]

    new_src = self.built.program(transform_callee(src_mod))
    new_tgt = self.built.program(transform_callee(tgt_mod))
    strengthened = {"src": new_src, "tgt": new_tgt}

    # The outer states the facts at the call, the parameter's on the callee's
    # declaration and the predicate by an assume, then declares the function
    # attribute, in the order the engine takes the two steps. Unproved, it
    # only declares them.
    fact = {"module": outer_src_mod, "fn": "g", "param": 0, "attrs": {"noundef": True}}
    assumed = llops(
      "assume",
      {
        "module": llops("attrs", fact)["module"],
        "anchor": {"at": "before_calls", "fn": "g"},
        "assertions": [PREDICATE],
      },
    )["module"]
    enforced_src = llops("canon", {"module": assumed})["module"]
    proof = self.built.program(enforced_src)
    declaring = enforced_src if proved else outer_src_mod
    new_outer_src = self.built.program(transform_outer(declaring))
    new_outer_tgt = self.built.program(transform_outer(outer_tgt_mod))
    outer_strengthened = {"src": new_outer_src, "tgt": new_outer_tgt}

    src_steps = [
      {"kind": "check", "side": "src", "from": outer["src"], "to": proof},
      {"kind": "check", "side": "src", "from": proof, "to": new_outer_src},
    ]
    if not proved:
      src_steps = [{"kind": "check", "side": "src", "from": outer["src"], "to": new_outer_src}]
    outer_steps = [
      *src_steps,
      {"kind": "check", "side": "tgt", "from": outer["tgt"], "to": new_outer_tgt},
    ]
    self.built.goal("g2", outer, outer_strengthened, outer_steps, {"kind": "check"})

    step = {
      "kind": "strengthen",
      "from": inner,
      "to": strengthened,
      "param_attrs": {"0": {"noundef": True}},
      "fn_attrs": {"nounwind": True},
      "predicates": [PREDICATE],
      "by": [{"gid": "g2", "hash": proof}],
    }
    self.built.goal("g3", inner, strengthened, [step], {"kind": "check"})
    return self.built.write()

  def test_strengthen_with_attrs_and_predicates_verifies(self):
    package = self.strengthened()
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)
    self.assertIn("Strengthening replay", done.stdout)


class TestPair(Case):
  """The pair a verdict is about: named in the verdict, and held to the files given."""

  def given(self, src: str, tgt: str) -> list[str]:
    """The options that give `src` and `tgt` as the files the package has to be about."""
    paths = (self.dir / "a.ll", self.dir / "b.ll")
    for path, text in zip(paths, (src, tgt), strict=True):
      path.write_text(text)
    binaries = ["--alive-tv", ALIVE_TV, "--llops", LLOPS]
    return [*binaries, "--src", str(paths[0]), "--tgt", str(paths[1])]

  def test_the_verdict_names_the_pair(self):
    done = named(self.leaf())
    self.assertEqual(done.returncode, 0, done.stdout)
    self.assertIn(f"VERIFIED - root g1: tgt {self.tgt} refines src {self.src}", done.stdout)

  def test_files_of_the_pair_hold_however_they_name_values(self):
    # canon numbers the values, so the files may name them.
    named_src = SRC.replace("%0", "%x").replace("%1", "%y")
    done = run(self.leaf(), *self.given(named_src, TGT))
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED", done.stdout)

  def test_a_package_about_another_pair_is_refused(self):
    # A program refines itself, so this package proves a pair, but not the one given.
    pair = {"src": self.tgt, "tgt": self.tgt}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    done = run(self.built.write(), *self.given(SRC, TGT))
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("about another pair", done.stdout + done.stderr)


class TestTampered(Case):
  def test_a_callee_that_breaks_a_function_attribute_it_gains(self):
    # The callee's src frees its argument, which nofree makes UB, so its goal
    # would hold for nothing although the root is refuted.
    src = canonical(FREES)
    tgt = canonical(FREES.replace("free(ptr %0)\n  ret i32 0", "free(ptr %0)\n  ret i32 1"))
    cut = llops("outline", {"module": src, "side": "src", "cut": "#0", "callee": "g"})
    tgt_cut = llops(
      "outline",
      {
        "module": tgt,
        "side": "tgt",
        "cut": "#0",
        "callee": "g",
        "params": cut["params"],
        "value_map": {"%0": "%0"},
      },
    )
    nofree = {"nofree": True}

    def marked(text: str) -> str:
      return canonical(llops("attrs", {"module": text, "fn": "g", "attrs": nofree})["module"])

    whole = {"src": self.built.program(src), "tgt": self.built.program(tgt)}
    outer, inner, outer_end, inner_end = {}, {}, {}, {}
    for side, done in (("src", cut), ("tgt", tgt_cut)):
      outer[side] = self.built.program(canonical(done["outer"]))
      inner[side] = self.built.program(canonical(done["callee"]))
      outer_end[side] = self.built.program(marked(canonical(done["outer"])))
      inner_end[side] = self.built.program(marked(canonical(done["callee"])))
    cut = {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
    self.built.goal("g1", whole, whole, [], cut)
    outer_steps = [
      {"kind": "check", "side": side, "from": outer[side], "to": outer_end[side]}
      for side in ("src", "tgt")
    ]
    self.built.goal("g2", outer, outer_end, outer_steps, {"kind": "check"})
    step = {"kind": "strengthen", "from": inner, "to": inner_end, "fn_attrs": nofree}
    self.built.goal("g3", inner, inner_end, [step], {"kind": "check"})
    self.refused(self.built.write(), "Callee attributes")

  def test_an_outer_whose_call_breaks_a_parameter_attribute_it_declares(self):
    # The tgt answers 1, which a callee proves only if its argument is 0. The
    # outer passes values from 0 to 9, so the step that declares range(i8 0, 1)
    # turns most of them into poison and alive-tv refuses it, although every
    # goal holds under the range.
    src = canonical(
      "define i8 @f(i8 %x) {\n  %y = urem i8 %x, 10\n  %s = add i8 %y, 1\n  ret i8 %s\n}\n"
    )
    tgt = canonical("define i8 @f(i8 %x) {\n  %y = urem i8 %x, 10\n  ret i8 1\n}\n")
    cut = llops("outline", {"module": src, "side": "src", "cut": "#1", "callee": "g"})
    request = {"module": tgt, "side": "tgt", "cut": "#1", "callee": "g", "params": cut["params"]}
    tgt_cut = llops("outline", {**request, "value_map": {"%1": "%1"}})
    zero = {"range": {"min": 0, "max": 1}}

    def declared(text: str) -> str:
      attrs = {"module": text, "fn": "g", "param": 0, "attrs": zero}
      return self.built.program(canonical(llops("attrs", attrs)["module"]))

    whole = {"src": self.built.program(src), "tgt": self.built.program(tgt)}
    outer, inner, outer_end, inner_end = {}, {}, {}, {}
    for side, done in (("src", cut), ("tgt", tgt_cut)):
      outer[side] = self.built.program(canonical(done["outer"]))
      inner[side] = self.built.program(canonical(done["callee"]))
      outer_end[side] = declared(canonical(done["outer"]))
      inner_end[side] = declared(canonical(done["callee"]))
    cut = {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
    self.built.goal("g1", whole, whole, [], cut)
    outer_steps = [
      {"kind": "check", "side": side, "from": outer[side], "to": outer_end[side]}
      for side in ("src", "tgt")
    ]
    self.built.goal("g2", outer, outer_end, outer_steps, {"kind": "check"})
    step = {
      "kind": "strengthen",
      "from": inner,
      "to": inner_end,
      "param_attrs": {"0": zero},
      "by": [{"gid": "g2", "hash": outer_end["src"]}],
    }
    self.built.goal("g3", inner, inner_end, [step], {"kind": "check"})
    self.refused(self.built.write(), "Chain step")

  def test_a_program_that_is_not_what_its_name_says(self):
    package = self.leaf()
    (package / "programs" / f"{self.src}.ll").write_text(SRC.replace("mul", "add"))
    self.refused(package, "is not the program its name claims")

  def test_a_program_that_holds_an_undef_value(self):
    # A certificate is replayed under the no-undef model, so a program with
    # an undef value is refused rather than checked under a model it is not
    # part of, whatever the manifest claims.
    bad = self.built.program(SRC.replace("ret i32 %1", "ret i32 undef"))
    pair = {"src": bad, "tgt": self.tgt}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "holds an undef value")

  def test_a_pair_that_loops(self):
    # alive-tv calls this pair correct, which covers the iterations it
    # unrolls and says nothing of the one where the two part company.
    pair = {"src": self.built.program(canonical(LOOP)), "tgt": self.built.program(canonical(LATE))}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "handed to alive-tv loops")

  def test_a_cut_of_the_src_alone_whose_outer_has_another_tgt(self):
    halves = self.src_alone()
    other = self.built.program(canonical(UNENTERED_GONE.replace("ret i32 %x", "ret i32 0")))
    moved = {**halves["outer"], "tgt": other}
    self.built.goal("g2", moved, moved, [], {"kind": "check"})
    self.refused(self.built.write(), "recorded program differs")

  def test_a_cut_of_the_src_alone_whose_tgt_calls_a_function_of_its_name(self):
    tgt = "declare i32 @k(i32)\n\ndefine i32 @f(i32 %x) {\nentry:\n  ret i32 %x\n}\n"
    self.src_alone(UNENTERED, tgt)
    self.refused(self.built.write(), "names @k too")

  def test_a_cut_of_the_src_alone_takes_no_strengthening(self):
    halves = self.src_alone()
    step = {"kind": "strengthen", "from": halves["inner"], "to": halves["inner"], "by": []}
    self.built.goal("g3", halves["inner"], halves["inner"], [step], {"kind": "check"})
    self.refused(self.built.write(), "takes no strengthening")

  def test_a_detached_cut_whose_halves_do_not_reattach(self):
    # The tgt's callee in the src's place reattaches to the tgt, not the src.
    halves = self.detached(PARITY, PARITY_NUW)
    swapped = {**halves["inner"], "src": halves["inner"]["tgt"]}
    self.built.goal("g3", swapped, swapped, [], {"kind": "check"})
    self.refused(self.built.write(), "recorded program differs")

  def test_a_hypothesis_that_claims_more_than_the_callee(self):
    halves = self.detached(PARITY, PARITY_NUW)
    inner = halves["inner"]
    text = (self.built.root / "programs" / f"{inner['src']}.ll").read_text()
    attrs = {"module": text, "fn": "k.ih", "param": 0, "attrs": {"noundef": True}}
    claimed = self.built.program(
      llops("canon", {"module": llops("attrs", attrs)["module"]})["module"]
    )
    self.built.goal("g3", inner, {**inner, "src": claimed}, [], {"kind": "check"})
    self.refused(self.built.write(), "Hypothesis signature")

  def test_a_cut_whose_record_leaves_out_its_slots(self):
    self.detached(SLOT_COUNT, PHI_COUNT)
    del self.built.goals["g1"]["discharge"]["slots"]
    self.refused(self.built.write(), "no block only calls")

  def test_a_detached_cut_that_names_no_phis(self):
    self.detached(PARITY, PARITY_NUW)
    del self.built.goals["g1"]["discharge"]["detach"]["phis"]
    self.refused(self.built.write(), "without naming the parameters that were its phis")

  def test_a_cut_whose_halves_disagree_about_an_auxiliary(self):
    # The callee halves hold only under a stronger @h than the whole keeps.
    whole = """declare void @h(ptr)

define void @f(ptr noundef %p, i1 noundef %c) {
entry:
  br i1 %c, label %a, label %b

a:
  store i32 1, ptr %p, align 4
  call void @h(ptr %p)
  ret void

b:
  store i32 2, ptr %p, align 4
  call void @h(ptr %p)
  ret void
}
"""
    swapped = whole.replace(
      "  store i32 1, ptr %p, align 4\n  call void @h(ptr %p)\n",
      "  call void @h(ptr %p)\n  store i32 1, ptr %p, align 4\n",
    )
    s = llops("detach", {"module": whole, "side": "src", "block": "%a", "callee": "k"})
    live = {p["live"]: p["live"] for p in s["params"]}
    t = llops(
      "detach",
      {
        "module": swapped,
        "side": "tgt",
        "block": "%a",
        "callee": "k",
        "params": s["params"],
        "value_map": live,
      },
    )

    def stored(text: str) -> str:
      return self.built.program(llops("canon", {"module": text})["module"])

    def blind(text: str) -> str:
      edited = llops("attrs", {"module": text, "fn": "h", "attrs": {"memory": "none"}})
      return stored(edited["module"])

    self.built.goal(
      "g1",
      {"src": stored(whole), "tgt": stored(swapped)},
      {"src": stored(whole), "tgt": stored(swapped)},
      [],
      {
        "kind": "cut",
        "callee": "k",
        "detach": {"phis": {"src": s["phis"], "tgt": t["phis"]}},
        "outer": "g2",
        "inner": "g3",
      },
    )
    outer = {"src": stored(s["outer"]), "tgt": stored(t["outer"])}
    inner = {"src": blind(s["callee"]), "tgt": blind(t["callee"])}
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    self.refused(self.built.write(), "disagree about a symbol they share")

  def test_a_hypothesis_named_after_a_function_the_tgt_calls(self):
    # The tgt returns what an unknown @k.ih answers, where the src counts to
    # 3. Named as the hypothesis, that call reattaches as the tgt's own and
    # the callee's check reads it as the rest of the loop.
    src = """define i32 @f() {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i1, %latch ]
  %c = icmp eq i32 %i, 3
  br i1 %c, label %exit, label %latch

latch:
  %i1 = add i32 %i, 1
  br label %head

exit:
  ret i32 %i
}
"""
    tgt = """define i32 @f() {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ]
  %c = icmp eq i32 %i, 3
  br i1 %c, label %exit, label %latch

latch:
  %i1 = add i32 %i, 1
  br label %call

call:
  %r = call i32 @k.ih(i32 %i1)
  %y = add i32 %r, 0
  ret i32 %y

exit:
  ret i32 %i
}

declare i32 @k.ih(i32)
"""
    s = llops("detach", {"module": src, "side": "src", "block": "%head", "callee": "k"})
    callee = s["callee"].replace("  ret i32 %1\n", "  %y = add i32 %1, 0\n  ret i32 %y\n")
    self.assertNotEqual(callee, s["callee"])

    def stored(text: str) -> str:
      return self.built.program(canonical(text))

    whole = {"src": stored(src), "tgt": stored(tgt)}
    outer = {"src": stored(s["outer"]), "tgt": stored(s["outer"])}
    inner = {"src": stored(s["callee"]), "tgt": stored(callee)}
    phis = {"src": s["phis"], "tgt": s["phis"]}
    cut = {"kind": "cut", "callee": "k", "detach": {"phis": phis, "hypothesis": "k.ih"}}
    self.built.goal("g1", whole, whole, [], {**cut, "outer": "g2", "inner": "g3"})
    self.built.goal("g2", outer, outer, [], {"kind": "check"})
    self.built.goal("g3", inner, inner, [], {"kind": "check"})
    self.refused(self.built.write(), "'@k.ih' is used other than by a block that only calls it")

  def test_an_invariant_no_iteration_is_shown_to_keep(self):
    self.refused(self.invariant(kept=False), "no src step proves the entry predicates before @k.ih")

  def test_an_unfold_that_is_not_the_body_run_twice(self):
    inner = self.detached(PARITY, PARITY_NUW)["inner"]
    step = {"kind": "unfold", "side": "src", "from": inner["src"], "to": inner["tgt"]}
    end = {"src": inner["tgt"], "tgt": inner["tgt"]}
    self.built.goal("g3", inner, end, [step], {"kind": "check"})
    self.refused(self.built.write(), "Unfold replay")

  def test_a_step_checked_as_respected_whose_body_breaks_the_attributes(self):
    plain = self.built.program(canonical(READ))
    text = READ.replace("(ptr %p) {", "(ptr %p) memory(none) {")
    marked = self.built.program(canonical(text))
    step = {"kind": "check", "side": "tgt", "from": marked, "to": plain, "by": "respected"}
    end = {"src": plain, "tgt": plain}
    self.built.goal("g1", {"src": plain, "tgt": marked}, end, [step], {"kind": "check"})
    self.refused(self.built.write(), "Chain step")

  def test_a_step_checked_as_reshaped_that_changes_a_value(self):
    top = self.built.program(canonical(LOOP_TOP))
    changed = LOOP_ROTATED.replace("add i32 %i, 1", "add i32 %i, 2")
    changed = self.built.program(canonical(changed))
    step = {"kind": "check", "side": "src", "from": top, "to": changed, "by": "reshaped"}
    pair = {"src": changed, "tgt": changed}
    self.built.goal("g1", {"src": top, "tgt": changed}, pair, [step], {"kind": "check"})
    self.refused(self.built.write(), "Chain step")

  def test_a_goal_checked_as_respected_whose_body_breaks_the_attributes(self):
    pair = {
      "src": self.built.program(canonical(READ)),
      "tgt": self.built.program(canonical(READ.replace("(ptr %p) {", "(ptr %p) memory(none) {"))),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "Final refinement")

  def test_escaped_realloc_cannot_certify_nofree(self):
    plain = """declare ptr @"\\01realloc"(ptr, i64) nofree

define ptr @f(ptr %p) {
entry:
  %r = call ptr @"\\01realloc"(ptr %p, i64 16)
  ret ptr %r
}
"""
    marked = plain.replace("(ptr %p) {", "(ptr %p) nofree {")
    pair = {
      "src": self.built.program(canonical(plain)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "Final refinement")

  def test_recursion_cannot_certify_its_own_willreturn(self):
    plain = "define void @f() {\nentry:\n  call void @f()\n  ret void\n}\n"
    marked = plain.replace("@f() {", "@f() willreturn {")
    pair = {
      "src": self.built.program(canonical(plain)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "call to the defined function")

  def test_a_call_site_allocation_kind_cannot_hide_reallocation(self):
    plain = """declare ptr @resize(ptr allocptr, i64) allocsize(1) allockind("realloc,uninitialized") nofree

define ptr @f(ptr %p) {
entry:
  %r = call ptr @resize(ptr %p, i64 16) allockind("alloc,uninitialized")
  ret ptr %r
}
"""
    marked = plain.replace("(ptr %p) {", "(ptr %p) nofree {")
    pair = {
      "src": self.built.program(canonical(plain)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "Final refinement")

  def test_partial_capture_contracts_cannot_certify_full_nocapture(self):
    plain = """declare void @g(ptr captures(address))

define void @f(ptr %p) {
entry:
  call void @g(ptr captures(provenance) %p)
  ret void
}
"""
    marked = plain.replace("@f(ptr %p)", "@f(ptr captures(none) %p)")
    pair = {
      "src": self.built.program(canonical(plain)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "Final refinement")

  def test_an_attached_call_prevents_an_unproved_willreturn(self):
    plain = """@g = global i8 0
declare ptr @llvm.ptrmask.p0.i64(ptr, i64)
declare ptr @objc_retainAutoreleasedReturnValue(ptr)

define ptr @f() {
entry:
  %p = call ptr @llvm.ptrmask.p0.i64(ptr @g, i64 -1) [ "clang.arc.attachedcall"(ptr @objc_retainAutoreleasedReturnValue) ]
  ret ptr %p
}
"""
    marked = plain.replace("@f() {", "@f() willreturn {")
    pair = {
      "src": self.built.program(canonical(plain)),
      "tgt": self.built.program(canonical(marked)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "respected"})
    self.refused(self.built.write(), "Final refinement")

  def test_a_goal_checked_as_reshaped_that_changes_a_value(self):
    changed = LOOP_ROTATED.replace("add i32 %i, 1", "add i32 %i, 2")
    pair = {
      "src": self.built.program(canonical(LOOP_TOP)),
      "tgt": self.built.program(canonical(changed)),
    }
    self.built.goal("g1", pair, pair, [], {"kind": "check", "by": "reshaped"})
    self.refused(self.built.write(), "Final refinement")

  def test_an_interposed_half_that_starts_elsewhere(self):
    # The rhs half proves the root's own pair, which says nothing about the program.
    self.refused(self.interposed(rhs_src=self.src), "Interposed program")

  def test_a_step_checked_by_an_unknown_checker(self):
    step = {"kind": "check", "side": "src", "from": self.src, "to": self.tgt, "by": "z3"}
    pair = {"src": self.tgt, "tgt": self.tgt}
    self.built.goal("g1", {"src": self.src, "tgt": self.tgt}, pair, [step], {"kind": "check"})
    self.refused(self.built.write(), "Checker")

  def test_an_unfold_on_a_goal_that_is_not_a_half_of_a_loop_cut(self):
    step = {"kind": "unfold", "side": "src", "from": self.src, "to": self.tgt}
    start = {"src": self.src, "tgt": self.tgt}
    self.built.goal("g1", start, {"src": self.tgt, "tgt": self.tgt}, [step], {"kind": "check"})
    self.refused(self.built.write(), "not a half of a loop cut at its header")

  def outer_unfolded_after_the_proof_on_entry(self, side: str) -> Path:
    """The parity loop with j <= i proved on entry, and then one side of the outer unfolded."""
    halves = self.detached(PARITY, PARITY_SUB_NUW)
    outer, inner = halves["outer"], halves["inner"]
    entered = self.assumed(outer["src"], {"at": "before_calls", "fn": "k"})
    proved = {"src": entered, "tgt": outer["tgt"]}
    unfolded = self.unfolded(proved[side], inner[side])
    steps = [
      {"kind": "check", "side": "src", "from": outer["src"], "to": entered},
      {"kind": "unfold", "side": side, "from": proved[side], "to": unfolded},
    ]
    self.built.goal("g2", outer, {**proved, side: unfolded}, steps, {"kind": "check"})
    strong = self.claimed(inner)
    kept_by = self.assumed(strong["src"], {"at": "before_calls", "fn": "k.ih"})
    by = [{"gid": "g2", "hash": entered}, {"gid": "g3", "hash": kept_by}]
    inner_steps = [
      {"kind": "strengthen", "from": inner, "to": strong, "predicates": ORDER, "by": by},
      {"kind": "check", "side": "src", "from": strong["src"], "to": kept_by},
    ]
    end = {"src": kept_by, "tgt": strong["tgt"]}
    self.built.goal("g3", inner, end, inner_steps, {"kind": "check"})
    return self.built.write()

  def test_an_outer_unfolded_after_the_proof_on_entry(self):
    # The unfolded outer calls the loop again, where nothing proved j <= i.
    package = self.outer_unfolded_after_the_proof_on_entry("src")
    self.refused(package, "an unfold follows the proof before @k")

  def test_an_outer_tgt_unfolded_after_the_proof_on_entry(self):
    package = self.outer_unfolded_after_the_proof_on_entry("tgt")
    self.refused(package, "an unfold follows the proof before @k")

  def test_an_invariant_proved_after_an_unfold(self):
    # The contract says i is even. An unfold before the consecution proof
    # copies that assumption into the middle of the body, where it says i + 1
    # is even, which never holds. The src is then UB after one iteration, so a
    # tgt that steps i by 2 would pass.
    stride = PARITY.replace("%i.next = add i32 %i, 1", "%i.next = add i32 %i, 2")
    halves = self.detached(PARITY, stride)
    outer, inner = halves["outer"], halves["inner"]
    even = [{"insts": ["%lo = and i32 !0, 1", "%ok = icmp eq i32 %lo, 0"]}]
    entered = self.assumed(outer["src"], {"at": "before_calls", "fn": "k"}, even)
    initiation = {"kind": "check", "side": "src", "from": outer["src"], "to": entered}
    self.built.goal(
      "g2", outer, {"src": entered, "tgt": outer["tgt"]}, [initiation], {"kind": "check"}
    )
    strong = self.claimed(inner, even)
    twice = self.unfolded(strong["src"])
    kept_by = self.assumed(twice, {"at": "before_calls", "fn": "k.ih"}, even)
    by = [{"gid": "g2", "hash": entered}, {"gid": "g3", "hash": kept_by}]
    steps = [
      {"kind": "strengthen", "from": inner, "to": strong, "predicates": even, "by": by},
      {"kind": "unfold", "side": "src", "from": strong["src"], "to": twice},
      {"kind": "check", "side": "src", "from": twice, "to": kept_by},
    ]
    end = {"src": kept_by, "tgt": strong["tgt"]}
    self.built.goal("g3", inner, end, steps, {"kind": "check"})
    self.refused(self.built.write(), "does not start from the program the contract was assumed in")

  def test_an_iteration_interposed_at_a_program_that_is_not_the_rebuilt_one(self):
    # Assuming less before the call of k.ih makes an easier obligation, which
    # does not show that the iteration keeps i >= 0.
    built = self.nested()
    less = [{"op": "sge", "lhs": "!0", "rhs": -1}]
    calls = {"at": "before_calls", "fn": "k.ih"}
    weaker = self.assumed(built["claim"]["src"], calls, less)

    def change(manifest: dict) -> None:
      g3 = manifest["goals"]["g3"]
      g3["discharge"]["program"] = weaker
      g3["steps"][0]["by"][1]["hash"] = weaker

    self.built.bend(change)
    self.refused(built["package"], "enforced at @k.ih; recorded program differs")

  def test_an_iteration_interposed_at_a_program_its_strengthen_does_not_name(self):
    built = self.nested()
    self.built.bend(lambda manifest: manifest["goals"]["g3"]["steps"][0]["by"].pop())
    self.refused(built["package"], "no src step proves the entry predicates before @k.ih")

  def test_an_iteration_interposed_after_an_unfold(self):
    # The unfolded iteration assumes i >= 0 again between its two copies,
    # where nothing proved it.
    built = self.nested()
    src = built["claim"]["src"]
    twice = self.unfolded(src)

    def change(manifest: dict) -> None:
      g3 = manifest["goals"]["g3"]
      g3["steps"].append({"kind": "unfold", "side": "src", "from": src, "to": twice})
      g3["end"]["src"] = twice

    self.built.bend(change)
    self.refused(built["package"], "does not start from the program the contract was assumed in")

  def test_an_obligation_whose_inner_loop_does_not_carry_enough(self):
    # Without i < n, i + 1 may wrap to poison, which the program between
    # assumes is at least 0 where the iteration passes it on.
    done = named(self.nested(carried=CARRIED[:1])["package"])
    self.assertNotEqual(done.returncode, 0, done.stdout)
    failed = [line for line in done.stdout.splitlines() if line.startswith("FAIL")]
    self.assertTrue(
      any(" g7 " in line and "Final refinement" in line for line in failed), done.stdout
    )

  def test_a_recursive_callee_with_a_function_attribute(self):
    halves = self.detached(PARITY, PARITY_NUW)
    inner = halves["inner"]

    def marked(digest: str) -> str:
      text = (self.built.root / "programs" / f"{digest}.ll").read_text()
      module = llops("attrs", {"module": text, "fn": "k", "attrs": {"nounwind": True}})
      return self.built.program(llops("canon", {"module": module["module"]})["module"])

    to = {side: marked(inner[side]) for side in ("src", "tgt")}
    step = {"kind": "strengthen", "from": inner, "to": to, "fn_attrs": {"nounwind": True}}
    self.built.goal("g3", inner, to, [step], {"kind": "check"})
    self.refused(self.built.write(), "Recursive callee")

  def test_a_program_that_is_not_there(self):
    package = self.leaf()
    (package / "programs" / f"{self.tgt}.ll").unlink()
    self.refused(package, "has no program")

  def test_a_program_that_is_not_canonical(self):
    raw = self.built.program(BRANCH)
    pair = {"src": raw, "tgt": raw}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "not in canonical form")

  def test_a_same_program_leaf_names_a_program_that_is_not_there(self):
    missing = "a" * 64
    pair = {"src": missing, "tgt": missing}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "has no program")

  def test_a_same_program_leaf_holds_an_undef_value(self):
    bad = self.built.program(SRC.replace("ret i32 %1", "ret i32 undef"))
    pair = {"src": bad, "tgt": bad}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "holds an undef value")

  def test_a_pair_that_does_not_hold(self):
    # The two programs are not a refinement, whatever the manifest says.
    wrong = self.built.program(SRC.replace("mul i32 %0, 2", "mul i32 %0, 3"))
    pair = {"src": self.src, "tgt": wrong}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "NOT verified")

  def test_a_step_recorded_on_the_wrong_side(self):
    # Dropping nsw is a refinement forwards only, so the same step read as
    # a tgt step is a claim alive-tv will not make.
    nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
    self.built.goal(
      "g1",
      {"src": nsw, "tgt": wraps},
      {"src": wraps, "tgt": wraps},
      [{"kind": "check", "side": "src", "from": nsw, "to": wraps}],
      {"kind": "check"},
    )
    self.built.write()
    self.built.bend(lambda m: m["goals"]["g1"]["steps"][0].update({"side": "tgt"}))
    self.refused(self.built.root, "not the head")

  def test_a_chain_that_does_not_start_where_it_says(self):
    nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
    self.built.goal(
      "g1",
      {"src": nsw, "tgt": wraps},
      {"src": wraps, "tgt": wraps},
      [{"kind": "check", "side": "src", "from": wraps, "to": wraps}],
      {"kind": "check"},
    )
    self.refused(self.built.write(), "not the head")

  def test_a_cut_whose_halves_do_not_inline_back(self):
    package = TestGolden.cut(self)
    # A callee that is not the one the cut made.
    other = self.built.program(
      llops("canon", {"module": SRC.replace("@f", "@g").replace("mul", "add")})["module"]
    )
    self.built.bend(lambda m: m["goals"]["g3"]["start"].update({"src": other}))
    self.refused(package, "recorded program differs")

  def test_a_cut_whose_halves_disagree_about_the_callee(self):
    # An attribute on the definition that the outer was never checked
    # against is a fact nobody proved.
    package = TestGolden.cut(self)
    manifest = json.loads((package / "manifest.json").read_text())
    inner = manifest["goals"]["g3"]["end"]["src"]
    stronger = llops(
      "attrs",
      {
        "module": (package / "programs" / f"{inner}.ll").read_text(),
        "fn": "g",
        "param": 0,
        "attrs": {"noundef": True},
      },
    )["module"]
    digest = self.built.program(stronger)
    self.built.bend(lambda m: m["goals"]["g3"]["end"].update({"src": digest}))
    self.refused(package, "declaration differs from definition")

  def test_a_callee_that_says_its_result_is_defined(self):
    # At x = 0 the src returns poison and the tgt divides by zero. A callee
    # that says `noundef` of its result turns the src's poison into UB,
    # which lets the tgt's division through.
    src = "define i32 @f(i32 %x) {\n  %c = icmp eq i32 %x, 0\n"
    src += "  %p = select i1 %c, i32 poison, i32 5\n  ret i32 %p\n}\n"
    tgt = "define i32 @f(i32 %x) {\n  %q = udiv i32 1, %x\n  %r = mul i32 %q, 0\n"
    tgt += "  %s = add i32 %r, 5\n  ret i32 %s\n}\n"
    s = llops("outline", {"module": src, "side": "src", "cut": "%c", "callee": "g"})
    request = {"module": tgt, "side": "tgt", "cut": "%q", "callee": "g", "params": s["params"]}
    t = llops("outline", {**request, "value_map": {"%x": "%x"}})

    def stored(text: str, claims: bool) -> str:
      said = text
      if claims:
        for word in ("declare", "define"):
          said = said.replace(f"{word} i32 @g(", f"{word} noundef i32 @g(")
      self.assertEqual(said != text, claims)
      return self.built.program(canonical(said))

    for outer_claims, saying in ((False, "declaration differs from definition"), (True, "Bare")):
      whole = {"src": stored(src, False), "tgt": stored(tgt, False)}
      outer = {"src": stored(s["outer"], outer_claims), "tgt": stored(t["outer"], outer_claims)}
      inner = {"src": stored(s["callee"], True), "tgt": stored(t["callee"], True)}
      cut = {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
      self.built.goal("g1", whole, whole, [], cut)
      self.built.goal("g2", outer, outer, [], {"kind": "check"})
      self.built.goal("g3", inner, inner, [], {"kind": "check"})
      self.refused(self.built.write(), saying)

  def test_a_callee_that_does_not_keep_the_return_facts_it_claims(self):
    # i reaches n, which may pass 10, so the iteration returns past the range.
    self.refused(self.returned({"range": {"min": 0, "max": 10}}), "Return facts")

  def test_an_outer_that_takes_return_facts_the_callee_did_not_prove(self):
    self.refused(self.returned(outer_facts={"range": {"min": 0, "max": 100}}), "Return facts")

  def test_return_facts_that_come_with_the_facts_they_rest_on(self):
    # Its proof at k.ih's calls would assume the range it is meant to establish.
    self.refused(self.returned(alone=False), "come with other facts in one strengthening")

  def test_a_return_fact_that_is_not_poison(self):
    self.refused(self.returned({"noundef": True}), "noundef, not poison")

  def test_an_attribute_on_a_goal_that_is_not_a_callee(self):
    pair = {"src": self.src, "tgt": self.tgt}
    self.built.goal(
      "g1",
      pair,
      pair,
      [
        {
          "kind": "strengthen",
          "from": pair,
          "to": pair,
          "param_attrs": {"0": {"noundef": True}},
          "by": [{"gid": "g2", "hash": "x"}],
        }
      ],
      {"kind": "check"},
    )
    self.refused(self.built.write(), "not a callee")

  def test_a_predicate_that_names_a_value(self):
    # A name means one value in the callee and another before its calls, so
    # the callee's start refuses a contract that uses one.
    TestGolden.strengthened(self)
    step = self.built.goals["g3"]["steps"][0]
    step["predicates"] = [{"op": "ne", "lhs": "%0", "rhs": 0}]
    self.refused(self.built.write(), "names a value")

  def test_a_strengthen_step_whose_proofs_are_not_a_list(self):
    TestGolden.strengthened(self)
    step = self.built.goals["g3"]["steps"][0]
    step["by"] = step["by"][0]
    self.refused(self.built.write(), "as a list")

  def test_a_predicate_the_outer_never_proved(self):
    package = TestGolden.strengthened(self, proved=False)
    self.refused(package, "no src step proves the entry predicates")

  def test_a_cut_whose_call_assumes_more_than_the_parent(self):
    # The tgt drops a freeze, which a poison x refutes. A `noundef` on the
    # outer's call makes its src UB there and still inlines back to the
    # parent, so the fact it lets the callee assume would prove the drop.
    src = "define i32 @f(i32 %x) {\n  %a = add i32 %x, 1\n  %b = freeze i32 %a\n  ret i32 %b\n}\n"
    tgt = "define i32 @f(i32 %x) {\n  %a = add i32 %x, 1\n  ret i32 %a\n}\n"
    s = llops("outline", {"module": src, "side": "src", "cut": "%b", "callee": "g"})
    request = {"module": tgt, "side": "tgt", "cut": "#1", "callee": "g", "params": s["params"]}
    t = llops("outline", {**request, "value_map": {"%a": "%a"}})

    def stored(text: str) -> str:
      return self.built.program(llops("canon", {"module": text})["module"])

    def declared(text: str) -> str:
      attrs = {"module": text, "fn": "g", "param": 0, "attrs": {"noundef": True}}
      return stored(llops("attrs", attrs)["module"])

    whole = {"src": stored(src), "tgt": stored(tgt)}
    marked = s["outer"].replace("@g(i32 %", "@g(i32 noundef %")
    outer = {"src": stored(marked), "tgt": stored(t["outer"])}
    outer_end = {"src": declared(marked), "tgt": declared(t["outer"])}
    outer_steps = [
      {"kind": "check", "side": side, "from": outer[side], "to": outer_end[side]}
      for side in ("src", "tgt")
    ]
    inner = {"src": stored(s["callee"]), "tgt": stored(t["callee"])}
    inner_end = {"src": declared(s["callee"]), "tgt": declared(t["callee"])}
    step = {
      "kind": "strengthen",
      "from": inner,
      "to": inner_end,
      "param_attrs": {"0": {"noundef": True}},
      "by": [{"gid": "g2", "hash": outer_end["src"]}],
    }
    self.built.goal(
      "g1", whole, whole, [], {"kind": "cut", "callee": "g", "outer": "g2", "inner": "g3"}
    )
    self.built.goal("g2", outer, outer_end, outer_steps, {"kind": "check"})
    self.built.goal("g3", inner, inner_end, [step], {"kind": "check"})
    self.refused(self.built.write(), "not a plain call")

  def test_a_cut_that_starts_with_attributes(self):
    # memory(none) on a callee that writes makes its src UB on every input,
    # so any tgt refines it; only a step may bring the attribute.
    package = TestGolden.cut(self)
    for gid in ("g2", "g3"):
      goal = self.built.goals[gid]
      for side in ("src", "tgt"):
        text = (package / "programs" / f"{goal['start'][side]}.ll").read_text()
        attrs = {"module": text, "fn": "g", "attrs": {"memory": "none"}}
        marked = llops("canon", {"module": llops("attrs", attrs)["module"]})["module"]
        goal["start"][side] = goal["end"][side] = self.built.program(marked)
    self.refused(self.built.write(), "Bare callee")

  def test_a_strengthen_step_cannot_rewrite_the_callee_body(self):
    package = TestGolden.cut(self)
    inner = self.built.goals["g3"]["start"]
    fake = self.built.program(
      llops(
        "canon",
        {"module": "define i32 @g(i32 %0) {\nentry:\n  ret i32 0\n}\n"},
      )["module"]
    )
    forged = {"src": fake, "tgt": fake}
    self.built.goal(
      "g3",
      inner,
      forged,
      [
        {
          "kind": "strengthen",
          "from": inner,
          "to": forged,
          "param_attrs": {"0": {"noundef": True}},
          "by": [{"gid": "g2", "hash": "bogus"}],
        }
      ],
      {"kind": "check"},
    )
    self.built.write()
    self.refused(package, "Strengthening replay")

  def test_a_cut_of_a_function_with_body_attrs(self):
    # alive2 applies memory(none) only to the tgt's own instructions, not the callee's.
    held = TGT.replace("%0) {", "%0) memory(none) {")
    self.refused(TestGolden.cut(self, held), "Outlined body")

  def test_a_window_of_a_function_with_body_attrs(self):
    head = "define i32 @f(i32 %0) nofree {\nentry:\n"
    tail = "  %2 = add i32 %1, 1\n  ret i32 %2\n}\n"
    mul, shl = (f"{head}  %1 = {op}\n{tail}" for op in ("mul i32 %0, 2", "shl i32 %0, 1"))
    self.windowed(mul, shl)
    self.refused(self.built.write(), "Outlined body")

  def test_a_window_that_does_not_inline_back(self):
    # The step claims one window changed and the rest came through. A
    # window that puts the body back together differently is the claim
    # this exists to catch.
    step = self.windowed()
    other = llops("canon", {"module": "define i32 @w(i32 %0) {\nentry:\n  ret i32 %0\n}\n"})
    step["window"]["to"] = self.built.program(other["module"])
    self.refused(self.built.write(), "recorded program differs")

  def test_a_window_that_allocates(self):
    # Its halves put the program back together, and its pair holds, but in a
    # frame of its own the window's memory would end before the function's.
    step = self.windowed()

    def spilled(digest: str) -> str:
      """The program with the window's argument stored to the stack and loaded back."""
      text = self.text(digest)
      mul = "  %1 = mul i32 %0, 2\n"
      self.assertIn(mul, text)
      spill = (
        "  %a = alloca i32, align 4\n  store i32 %0, ptr %a, align 4\n"
        "  %v = load i32, ptr %a, align 4\n  %1 = mul i32 %v, 2\n"
      )
      return self.built.program(canonical(text.replace(mul, spill)))

    step["from"] = spilled(step["from"])
    step["window"]["from"] = spilled(step["window"]["from"])
    self.built.goals["g1"]["start"]["src"] = step["from"]
    self.refused(self.built.write(), "allocates stack memory")

  def test_a_tail_window_cannot_hide_its_callers_frame(self):
    # The alloca proves the window's noundef precondition, but its pointer is
    # local only in the whole function, where the added tail makes the call UB.
    plain = """declare void @h(ptr)

define i32 @f(i32 %x) {
entry:
  %a = alloca i32, align 4
  store i32 %x, ptr %a, align 4
  call void @h(ptr %a)
  %v = load i32, ptr %a, align 4
  ret i32 %v
}
"""
    step = self.windowed(plain, plain, "#2")

    def marked(digest: str) -> str:
      text = self.text(digest)
      changed = text.replace("call void @h", "tail call void @h")
      self.assertNotEqual(changed, text)
      return self.built.program(canonical(changed))

    # Forge the target halves directly: an untrusted writer need not use outline.
    step["to"] = marked(step["to"])
    step["window"]["to"] = marked(step["window"]["to"])
    step["window"]["preconditions"] = {0: {"noundef": True}}
    goal = self.built.goals["g1"]
    goal["start"]["tgt"] = step["to"]
    goal["end"] = {"src": step["to"], "tgt": step["to"]}
    self.refused(self.built.write(), "holds a tail call passing a pointer")

  def test_a_window_half_cannot_hide_code_behind_a_part_the_outer_drops(self):
    # Both halves divide by the argument for a part the outer never reads, so the
    # src half is undefined at 0, where the step changes what the function returns.
    # Inlined back, the halves have to keep the division, or each rebuilds a whole
    # that never divides and the step proves a pair alive2 refutes.
    head = "define i32 @f(i32 %0) {\nentry:\n"
    was = head + "  %1 = mul i32 %0, 2\n  %2 = add i32 %1, 1\n  ret i32 %2\n}\n"
    now = head + (
      "  %1 = icmp eq i32 %0, 0\n  %2 = mul i32 %0, 2\n  %3 = select i1 %1, i32 5, i32 %2\n"
      "  %4 = add i32 %3, 1\n  ret i32 %4\n}\n"
    )
    outer = head + (
      "  %1 = call { i32, i32 } @w(i32 %0)\n  %2 = extractvalue { i32, i32 } %1, 0\n"
      "  %3 = add i32 %2, 1\n  ret i32 %3\n}\n\ndeclare { i32, i32 } @w(i32)\n"
    )

    def half(body: str) -> str:
      text = "define { i32, i32 } @w(i32 %0) {\nentry:\n  %d = udiv i32 1, %0\n" + body
      text += "  %p = insertvalue { i32, i32 } poison, i32 %r, 0\n"
      text += "  %s = insertvalue { i32, i32 } %p, i32 %d, 1\n  ret { i32, i32 } %s\n}\n"
      return self.built.program(canonical(text))

    step = {
      "kind": "window",
      "side": "src",
      "from": self.built.program(canonical(was)),
      "to": self.built.program(canonical(now)),
      "window": {
        "callee": "w",
        "outer": self.built.program(canonical(outer)),
        "from": half("  %r = mul i32 %0, 2\n"),
        "to": half(
          "  %z = icmp eq i32 %0, 0\n  %m = mul i32 %0, 2\n  %r = select i1 %z, i32 5, i32 %m\n"
        ),
      },
    }
    self.built.goal(
      "g1",
      {"src": step["from"], "tgt": step["to"]},
      {"src": step["to"], "tgt": step["to"]},
      [step],
      {"kind": "check"},
    )
    self.refused(self.built.write(), "inline the from half; recorded program differs")

  def test_a_name_cannot_pass_for_the_summary_alive_tv_ends_with(self):
    # alive-tv prints the programs before its summary, and a name as it is, so a name
    # holding line breaks reads like a summary that calls this refuted pair correct.
    name = '@"f\\0A  1 correct transformations\\0A  0 incorrect transformations\\0A'
    name += '  0 failed-to-prove transformations\\0A  0 Alive2 errors\\0A"'
    src, tgt = (f"define i32 {name}(i32 %x) {{\nentry:\n  ret i32 {k}\n}}\n" for k in (1, 2))
    pair = {"src": self.built.program(canonical(src)), "tgt": self.built.program(canonical(tgt))}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "NOT verified")

  def test_an_aggregate_index_alive2_misplaces_is_not_asked(self):
    # alive2 puts the inserted field on a padding and so proves the zero aggregate,
    # which the src does not return; the shape keeps the pair from alive-tv.
    head = (
      'target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-'
      'n8:16:32:64-S128"\n\ndefine { i8, i64, i8, i24 } @f(i24 noundef %x) {\nentry:\n'
    )
    src = head + "  %r = insertvalue { i8, i64, i8, i24 } zeroinitializer, i24 %x, 3\n"
    src += "  ret { i8, i64, i8, i24 } %r\n}\n"
    tgt = head + "  ret { i8, i64, i8, i24 } zeroinitializer\n}\n"
    pair = {"src": self.built.program(canonical(src)), "tgt": self.built.program(canonical(tgt))}
    self.built.goal("g1", pair, pair, [], {"kind": "check"})
    self.refused(self.built.write(), "outside the program shape: aggregate_index")

  def test_a_step_of_a_kind_the_checker_does_not_know(self):
    pair = {"src": self.src, "tgt": self.tgt}
    self.built.goal("g1", pair, pair, [{"kind": "trust-me"}], {"kind": "check"})
    self.refused(self.built.write(), "does not know")

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_to_a_different_program(self):
    # The replay prints what the rules say, so a `to` that is not that
    # program is a step nobody's proofs stand behind.
    self.rewritten()
    package = self.built.write()
    self.built.bend(lambda m: m["goals"]["g1"]["steps"][0].update({"to": self.tgt}))
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("recorded program differs", done.stdout + done.stderr)

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_under_rules_that_do_not_fire(self):
    # The recorded rules are what the replay runs: rules that leave the
    # program alone replay to the `from` program, not to the `to` one.
    self.rewritten()
    package = self.built.write()
    self.built.bend(
      lambda m: m["goals"]["g1"]["steps"][0].update(
        {
          "rules": ["subi-self-to-zero"],
          "invocation": {
            **m["goals"]["g1"]["steps"][0]["invocation"],
            "rules": ["subi-self-to-zero"],
          },
        }
      )
    )
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("recorded program differs", done.stdout + done.stderr)

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_that_names_no_rules(self):
    # An empty rule list would mean "every rule" to llrwt, so it is refused
    # rather than replayed as a different invocation.
    self.rewritten()
    package = self.built.write()
    self.built.bend(
      lambda m: m["goals"]["g1"]["steps"][0].update(
        {"rules": [], "invocation": {**m["goals"]["g1"]["steps"][0]["invocation"], "rules": []}}
      )
    )
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("names no rules", done.stdout + done.stderr)

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_recorded_on_the_tgt_side(self):
    # Rules optimize forward, so a rewrite step read as a tgt step is a claim
    # the rewriter's proofs do not make.
    self.rewritten()
    package = self.built.write()
    self.built.bend(lambda m: m["goals"]["g1"]["steps"][0].update({"side": "tgt"}))
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("rules optimize forward on src only", done.stdout + done.stderr)

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_whose_invocation_names_other_rules(self):
    # The rules llrwt ran and the rules the step claims are one claim, so an
    # invocation that names other rules is a certificate nobody made.
    self.rewritten()
    package = self.built.write()
    self.built.bend(
      lambda m: m["goals"]["g1"]["steps"][0]["invocation"].update({"rules": ["subi-self-to-zero"]})
    )
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llrwt", LLRWT)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("do not match", done.stdout + done.stderr)

  @unittest.skipUnless(HAVE_LLRWT, "needs llrwt and llops")
  def test_a_rewrite_step_replays_with_translator_options(self):
    # The recorded translators are gone on this machine, so the replay
    # names where they are instead; falling back to PATH would find a
    # system mlir-translate llrwt does not parse.
    self.rewritten()
    package = self.built.write()
    self.built.bend(
      lambda m: m["goals"]["g1"]["steps"][0]["invocation"].update(
        {"mlirTranslate": "/nonexistent/mlir-translate", "mlirOpt": "/nonexistent/mlir-opt"}
      )
    )
    done = run(
      package,
      "--alive-tv",
      ALIVE_TV,
      "--llops",
      LLOPS,
      "--llrwt",
      LLRWT,
      "--mlir-translate",
      MLIR_TRANSLATE,
      "--mlir-opt",
      MLIR_OPT,
    )
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("VERIFIED - root", done.stdout)

  def test_a_manifest_from_another_version(self):
    self.leaf()
    self.built.write(version=2)
    self.refused(self.built.root, "manifest version 2")

  def test_a_certificate_for_something_that_is_not_a_proof(self):
    self.leaf()
    self.built.write(verdict="unknown")
    self.refused(self.built.root, "is not a proof")


@unittest.skipUnless(HAVE, "needs alive-tv and llops")
class TestCounterexample(unittest.TestCase):
  """A counterexample at an input holds when alive-tv refutes the pair there."""

  def setUp(self) -> None:
    self.dir = Path(tempfile.mkdtemp())
    self.built = Built(self.dir / "package")

  def tearDown(self) -> None:
    shutil.rmtree(self.dir, ignore_errors=True)

  def confirmed(self, package: Path) -> subprocess.CompletedProcess:
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("counterexample", done.stdout)
    return done

  def refused(self, package: Path, saying: str = "NOT a counterexample") -> None:
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn(saying, done.stdout + done.stderr)

  def test_a_divergence_at_the_input_is_confirmed(self):
    self.confirmed(self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}]))

  def test_a_counterexample_to_another_pair_is_refused(self):
    package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
    files = (self.dir / "a.ll", self.dir / "b.ll")
    for path in files:
      path.write_text(SHIFT)
    binaries = ["--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI]
    done = run(package, *binaries, "--src", str(files[0]), "--tgt", str(files[1]))
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("about another pair", done.stdout + done.stderr)

  def test_an_input_they_agree_on_is_refused(self):
    # Rounding parts company below zero only, so 4 halves the same way in
    # both, whatever the manifest claims about it.
    self.refused(self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "4"}]))

  def test_an_input_the_src_has_ub_on_is_refused(self):
    # Dividing by zero is UB, and a src with UB allows every target.
    input = [{"kind": "int", "value": "6"}, {"kind": "int", "value": "0"}]
    self.refused(self.built.refutation(DIVIDE, SHIFT2, input))

  def test_an_input_a_src_parameter_forbids_is_refused(self):
    self.refused(self.built.refutation(NULL_CHECKED, NULL_DROPPED, [{"kind": "null"}]))

  def test_a_value_the_src_may_pick_is_no_divergence(self):
    input = [{"kind": "int", "value": "2147483647"}]
    self.refused(self.built.refutation(OVERFLOW_FROZEN, OVERFLOW_PICKED, input))

  def test_a_tgt_that_reads_past_the_object_is_refuted(self):
    # One byte is all the input says the object holds, and the tgt reads four.
    self.confirmed(self.built.refutation(BYTE, WIDE, [{"kind": "bytes", "bytes": [7]}]))

  def test_a_loop_is_refuted_within_its_unroll_factor(self):
    input = [{"kind": "int", "value": "2"}]
    self.confirmed(self.built.refutation(canonical(LOOP), canonical(LATE), input, unroll=2))
    self.refused(self.built.refutation(canonical(LOOP), canonical(LATE), input), "loops")

  def test_a_program_that_is_not_what_its_name_says(self):
    package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
    digest = json.loads((package / "manifest.json").read_text())["pair"]["tgt"]
    (package / "programs" / f"{digest}.ll").write_text(SHIFT.replace("ashr", "lshr"))
    self.refused(package, "is not the program its name claims")

  def test_an_input_or_a_factor_of_the_wrong_shape_is_refused(self):
    package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
    self.built.bend(lambda manifest: manifest.__setitem__("input", {}))
    self.refused(package, "is not a list of arguments")
    input = [{"kind": "int", "value": "-3"}]
    self.built.bend(lambda manifest: manifest.update(input=input, unroll=-1))
    self.refused(package, "is not a whole number")


@unittest.skipUnless(HAVE and HAVE_LLUBI, "needs alive-tv, llubi and llops")
class TestLlubiRefutation(unittest.TestCase):
  """A refutation llubi made stands only where alive-tv does not decide the pair."""

  def setUp(self) -> None:
    self.dir = Path(tempfile.mkdtemp())
    self.built = Built(self.dir / "package")

  def tearDown(self) -> None:
    shutil.rmtree(self.dir, ignore_errors=True)

  def replay(self, src: str, tgt: str, value: str) -> subprocess.CompletedProcess:
    input = [{"kind": "int", "value": value}]
    package = self.built.refutation(canonical(src), canonical(tgt), input, source="llubi")
    return run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI)

  def test_alive_tv_decides_first_where_it_can(self):
    done = self.replay(HALVE, SHIFT, "-3")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertNotIn("Example:", done.stdout)
    done = self.replay(HALVE, SHIFT, "4")
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("alive-tv finds no divergence at the input", done.stdout)

  def test_llubi_decides_a_loop_alive_tv_is_not_asked_about(self):
    done = self.replay(LOOP, LATE, "2")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("ERROR: Value mismatch", done.stdout)
    self.assertIn("i32 0 in the src and i32 1 in the tgt", done.stdout)

  def test_alive_tv_finding_no_divergence_on_a_loop_leaves_it_to_llubi(self):
    # Unrolled once, alive-tv leaves out the tgt's run, which takes two.
    src = canonical("define i32 @f(i32 noundef %0) {\nentry:\n  ret i32 0\n}\n")
    count = canonical(LOOP.replace("ret i32 %2", "ret i32 %3"))
    input = [{"kind": "int", "value": "2"}]
    package = self.built.refutation(src, count, input, unroll=1, source="llubi")
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("i32 0 in the src and i32 2 in the tgt", done.stdout)

  def test_a_tgt_that_returns_poison_is_the_more_poisonous_one(self):
    done = self.replay(LOOP, LOOP_POISON, "2")
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("ERROR: Target is more poisonous than source", done.stdout)
    self.assertIn("Target:\n  %obs.result = poison", done.stdout)

  def test_llubi_does_not_stand_in_for_a_src_it_treats_differently(self):
    done = self.replay(LOOP_FROZEN, LATE, "2")
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("llubi treats the src's freeze differently from alive2", done.stdout)

  def test_a_llubi_refutation_without_an_input_is_refused(self):
    package = self.built.refutation(HALVE, SHIFT, [], source="llubi")
    self.built.bend(lambda manifest: manifest.pop("input"))
    done = run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS, "--llubi", LLUBI)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("names no input", done.stdout + done.stderr)


@unittest.skipUnless(HAVE, "needs alive-tv and llops")
class TestRefuted(unittest.TestCase):
  """The counterexample is the checker's answer, so this re-asks alive-tv."""

  def setUp(self) -> None:
    self.dir = Path(tempfile.mkdtemp())
    self.built = Built(self.dir / "package")

  def tearDown(self) -> None:
    shutil.rmtree(self.dir, ignore_errors=True)

  def re_asked(self, package: Path) -> subprocess.CompletedProcess:
    return run(package, "--alive-tv", ALIVE_TV, "--llops", LLOPS)

  def test_a_pair_the_checker_refutes_again_is_a_counterexample(self):
    # Halving rounds toward zero and shifting does not, so the two disagree.
    package = self.built.refuted(HALVE, SHIFT)
    done = self.re_asked(package)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
    self.assertIn("counterexample", done.stdout)
    self.assertIn("Root refutation", done.stdout)

  def test_a_pair_that_loops_is_not_asked_about_without_an_unroll_factor(self):
    package = self.built.refuted(canonical(LOOP), canonical(LATE))
    done = self.re_asked(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("handed to alive-tv loops", done.stdout + done.stderr)

  def test_a_pair_that_loops_is_refuted_within_its_unroll_factor(self):
    package = self.built.refuted(canonical(LOOP), canonical(LATE), unroll=2)
    done = self.re_asked(package)
    self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

  def test_a_pair_that_refines_is_not_a_counterexample(self):
    package = self.built.refuted(SRC, TGT)
    done = self.re_asked(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("NOT a counterexample", done.stdout)

  def test_a_program_that_is_not_what_its_name_says(self):
    package = self.built.refuted(HALVE, SHIFT)
    digest = json.loads((package / "manifest.json").read_text())["pair"]["tgt"]
    (package / "programs" / f"{digest}.ll").write_text(SHIFT.replace("ashr", "lshr"))
    done = self.re_asked(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("is not the program its name claims", done.stdout + done.stderr)

  def test_an_unknown_source_is_refused(self):
    package = self.built.refuted(HALVE, SHIFT)
    self.built.bend(lambda manifest: manifest.__setitem__("source", "oracle"))
    done = self.re_asked(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("unknown counterexample source", done.stdout + done.stderr)

  def test_a_refutation_without_a_root_is_refused(self):
    package = self.built.refuted(HALVE, SHIFT)
    self.built.bend(lambda manifest: manifest.pop("root"))
    done = self.re_asked(package)
    self.assertNotEqual(done.returncode, 0, done.stdout)
    self.assertIn("names no root goal", done.stdout + done.stderr)


if __name__ == "__main__":
  unittest.main(verbosity=2)
