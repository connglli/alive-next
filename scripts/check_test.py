#!/usr/bin/env python3
"""Tests for check.py.

    python3 scripts/check_test.py

A golden package has to pass and every bent one has to fail, which is the half
that matters: a checker that accepts a certificate nobody could have earned is
worse than no checker.

Packages are built here rather than recorded, so what is under test is the
rule check.py applies and not a run that happened to go well.
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
CHECK = ROOT / "scripts" / "check.py"


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
HAVE = Path(ALIVE_TV).exists() and Path(LLOPS).exists()
HAVE_LLUBI = Path(LLUBI).exists() and Path(LLOPS).exists()

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


def llops(subcommand: str, request: dict) -> dict:
    done = subprocess.run(
        [LLOPS, subcommand], input=json.dumps(request), capture_output=True, text=True
    )
    answer = json.loads(done.stdout)
    assert answer.get("ok"), answer
    return answer


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
        assumed: dict | None = None,
    ) -> Path:
        manifest = {
            "version": version,
            "verdict": verdict,
            "root": root,
            "toolchain": {},
            "assumed": assumed or {},
            "goals": self.goals,
        }
        (self.root / "manifest.json").write_text(json.dumps(manifest, indent=2))
        return self.root

    def refutation(self, src: str, tgt: str, input: list[dict]) -> Path:
        """A counterexample package: the pair, and the input it is run on."""
        manifest = {
            "version": 1,
            "verdict": "counterexample",
            "root": "g1",
            "toolchain": {},
            "pair": {"src": self.program(src), "tgt": self.program(tgt)},
            "input": input,
            "divergence": "whatever the run said",
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
        self.built.goal("g1", pair, pair, [], {"kind": "checked"})
        return self.built.write()

    def windowed(self, tail: str = "  %2 = add i32 %1, 1\n  ret i32 %2\n") -> dict:
        """A goal whose one step was narrowed to the window it changed.

        The body is longer than the window on purpose: what the step claims is
        that everything outside those lines came through untouched, and what
        says so is the two halves inlining back into one outer.
        """
        head = "define i32 @f(i32 %0) {\nentry:\n"
        was = llops("canon", {"module": f"{head}  %1 = mul i32 %0, 2\n{tail}}}\n"})["module"]
        now = llops("canon", {"module": f"{head}  %1 = shl i32 %0, 1\n{tail}}}\n"})["module"]
        cut = [
            llops("outline", {"module": module, "cut": "#0", "to": "#0", "callee": "w"})
            for module in (was, now)
        ]
        outer = llops("canon", {"module": cut[0]["outer"]})["module"]
        step = {
            "kind": "window",
            "side": "src",
            "from": self.built.program(was),
            "to": self.built.program(now),
            "flags": [],
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
            {"kind": "checked"},
        )
        return step

    def verified(self, package: Path) -> subprocess.CompletedProcess:
        done = named(package)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("verified", done.stdout)
        return done

    def refused(self, package: Path, saying: str) -> None:
        done = named(package)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn(saying, done.stdout + done.stderr)


class TestGolden(Case):
    def test_a_leaf_verifies(self):
        self.verified(self.leaf())

    def test_a_chain_verifies(self):
        # One certified step, then the pair it was left with.
        nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
        self.built.goal(
            "g1",
            {"src": nsw, "tgt": wraps},
            {"src": wraps, "tgt": wraps},
            [{"kind": "checked", "side": "src", "from": nsw, "to": wraps, "flags": []}],
            {"kind": "checked"},
        )
        self.verified(self.built.write())

    def test_a_cut_verifies(self):
        self.verified(self.cut())

    def test_a_narrowed_step_verifies(self):
        self.windowed()
        done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("verified", done.stdout)
        # Both halves go back into the outer before the small pair is asked:
        # what the step claims about the rest of the body is checked first.
        self.assertEqual(done.stdout.count("inlines back"), 2)

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
            "flags": [],
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
            {"kind": "checked"},
        )
        done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("verified", done.stdout)
        self.assertEqual(done.stdout.count("inlines back"), 2)

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
                    "define i32 @f(i32 noundef %0) {\n"
                    "entry:\n"
                    "  %1 = add i32 %0, 1\n"
                    "  ret i32 %1\n"
                    "}\n"
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
            "flags": [],
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
            {"kind": "checked"},
        )
        done = run(self.built.write(), "--alive-tv", ALIVE_TV, "--llops", LLOPS, "-v")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("verified", done.stdout)
        self.assertEqual(done.stdout.count("inlines back"), 2)

    def test_a_proof_is_replayed_under_the_assumption_it_names(self):
        # The same package settles either way depending on what it says the run
        # was allowed to assume, which is how a replay shows the assumption
        # reached alive-tv rather than having been written down and forgotten.
        pair = {"src": self.built.program(FROZEN), "tgt": self.built.program(RAW)}
        self.built.goal("g1", pair, pair, [], {"kind": "checked"})
        done = self.verified(self.built.write(assumed={"noUndef": True, "noPoison": True}))
        self.assertIn("assuming no argument is undef and no argument is poison", done.stdout)
        self.refused(self.built.write(assumed={"noUndef": True}), "not correct")

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
        self.assertIn("verified", done.stdout)

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

    def cut(self) -> Path:
        """A package whose root is discharged by a cut, built with llops."""
        canon = llops("canon", {"module": SRC})["module"]
        canon_tgt = llops("canon", {"module": TGT})["module"]
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
            "g1", whole, whole, [], {"kind": "split", "callee": "g", "outer": "g2", "inner": "g3"}
        )
        self.built.goal("g2", outer, outer, [], {"kind": "checked"})
        self.built.goal("g3", inner, inner, [], {"kind": "checked"})
        return self.built.write()


class TestTampered(Case):
    def test_a_program_that_is_not_what_its_name_says(self):
        package = self.leaf()
        (package / "programs" / f"{self.src}.ll").write_text(SRC.replace("mul", "add"))
        self.refused(package, "is not the program its name claims")

    def test_a_program_that_is_not_there(self):
        package = self.leaf()
        (package / "programs" / f"{self.tgt}.ll").unlink()
        self.refused(package, "has no program")

    def test_a_pair_that_does_not_hold(self):
        # The two programs are not a refinement, whatever the manifest says.
        wrong = self.built.program(SRC.replace("mul i32 %0, 2", "mul i32 %0, 3"))
        pair = {"src": self.src, "tgt": wrong}
        self.built.goal("g1", pair, pair, [], {"kind": "checked"})
        self.refused(self.built.write(), "NOT verified")

    def test_a_step_recorded_on_the_wrong_side(self):
        # Dropping nsw is a refinement forwards only, so the same step read as
        # a tgt step is a claim alive-tv will not make.
        nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
        self.built.goal(
            "g1",
            {"src": nsw, "tgt": wraps},
            {"src": wraps, "tgt": wraps},
            [{"kind": "checked", "side": "src", "from": nsw, "to": wraps, "flags": []}],
            {"kind": "checked"},
        )
        self.built.write()
        self.built.bend(lambda m: m["goals"]["g1"]["steps"][0].update({"side": "tgt"}))
        self.refused(self.built.root, "NOT verified")

    def test_a_chain_that_does_not_start_where_it_says(self):
        nsw, wraps = self.built.program(NSW), self.built.program(WRAPS)
        self.built.goal(
            "g1",
            {"src": nsw, "tgt": wraps},
            {"src": wraps, "tgt": wraps},
            [{"kind": "checked", "side": "src", "from": wraps, "to": wraps, "flags": []}],
            {"kind": "checked"},
        )
        self.refused(self.built.write(), "not the head")

    def test_a_cut_whose_halves_do_not_inline_back(self):
        package = TestGolden.cut(self)
        # A callee that is not the one the cut made.
        other = self.built.program(
            llops("canon", {"module": SRC.replace("@f", "@g").replace("mul", "add")})["module"]
        )
        self.built.bend(lambda m: m["goals"]["g3"]["start"].update({"src": other}))
        self.refused(package, "to a different program")

    def test_a_cut_whose_halves_disagree_about_the_callee(self):
        # An attribute on the definition that the outer was never checked
        # against is a fact nobody proved.
        package = TestGolden.cut(self)
        manifest = json.loads((package / "manifest.json").read_text())
        inner = manifest["goals"]["g3"]["end"]["src"]
        stronger = llops(
            "edit",
            {
                "module": (package / "programs" / f"{inner}.ll").read_text(),
                "op": "attrs",
                "fn": "g",
                "param": 0,
                "attrs": {"noundef": True},
            },
        )["module"]
        digest = self.built.program(stronger)
        self.built.bend(lambda m: m["goals"]["g3"]["end"].update({"src": digest}))
        self.refused(package, "says the same on both src halves")

    def test_an_attribute_on_a_goal_that_is_not_a_callee(self):
        pair = {"src": self.src, "tgt": self.tgt}
        self.built.goal(
            "g1",
            pair,
            pair,
            [{"kind": "strengthen", "from": pair, "to": pair, "by": {"gid": "g2", "hash": "x"}}],
            {"kind": "checked"},
        )
        self.refused(self.built.write(), "not a callee")

    def test_an_assumption_on_a_goal_below_a_cut(self):
        # A callee's parameters are values the program computed, so nothing the
        # run assumed about arguments reaches it, however the manifest is
        # written. The step below is otherwise sound: the options are the only
        # thing wrong with it.
        TestGolden.cut(self)
        inner = self.built.goals["g3"]["start"]
        step = {
            "kind": "checked",
            "side": "src",
            "from": inner["src"],
            "to": inner["src"],
            "flags": ["--disable-undef-input"],
        }
        self.built.goal("g3", inner, inner, [step], {"kind": "checked"})
        self.refused(
            self.built.write(assumed={"noUndef": True}),
            "are not the ones its goal is asked under",
        )

    def test_a_window_that_does_not_inline_back(self):
        # The step claims one window changed and the rest came through. A
        # window that puts the body back together differently is the claim
        # this exists to catch.
        step = self.windowed()
        other = llops("canon", {"module": "define i32 @w(i32 %0) {\nentry:\n  ret i32 %0\n}\n"})
        step["window"]["to"] = self.built.program(other["module"])
        self.refused(self.built.write(), "to a different program")

    def test_a_window_that_claims_an_assumption(self):
        # A window's parameters are values the program computed, so nothing the
        # run assumed about arguments reaches it.
        step = self.windowed()
        step["flags"] = ["--disable-undef-input"]
        self.refused(
            self.built.write(assumed={"noUndef": True}),
            "are not none, which is what it is asked under",
        )

    def test_an_assumption_the_checker_does_not_know(self):
        self.leaf()
        self.built.bend(lambda m: m.update({"assumed": {"noWrapping": True}}))
        self.refused(self.built.root, "does not know")

    def test_a_step_of_a_kind_the_checker_does_not_know(self):
        pair = {"src": self.src, "tgt": self.tgt}
        self.built.goal("g1", pair, pair, [{"kind": "trust-me"}], {"kind": "checked"})
        self.refused(self.built.write(), "does not know")

    def test_a_manifest_from_another_version(self):
        self.leaf()
        self.built.write(version=2)
        self.refused(self.built.root, "manifest version 2")

    def test_a_certificate_for_something_that_is_not_a_proof(self):
        self.leaf()
        self.built.write(verdict="unknown")
        self.refused(self.built.root, "is not a proof")


@unittest.skipUnless(HAVE_LLUBI, "needs llubi and llops")
class TestCounterexample(unittest.TestCase):
    """A refutation is confirmed by running the pair, not by being asserted."""

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.built = Built(self.dir / "package")

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def replay(self, package: Path) -> subprocess.CompletedProcess:
        return run(package, "--llops", LLOPS, "--llubi", LLUBI)

    def test_a_divergence_is_confirmed(self):
        package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
        done = self.replay(package)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("i32 -1 in the src and i32 -2 in the tgt", done.stdout)
        self.assertIn("counterexample", done.stdout)

    def test_it_says_what_was_run_and_what_each_side_did(self):
        package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
        said = self.replay(package).stdout
        self.assertIn("ERROR: Value mismatch", said)
        self.assertIn("Example:\ni32 noundef %0 = -3", said)
        self.assertIn("Source:\n  %obs.result = i32 -1", said)
        self.assertIn("Target:\n  %obs.result = i32 -2", said)

    def test_a_tgt_that_returns_poison_is_the_more_poisonous_one(self):
        # The harness stores what the entry returns and storing poison is UB,
        # so a tgt that returns poison stops in the harness, which is what
        # tells it from a tgt with UB of its own.
        wraps = HALVE.replace("%1 = sdiv i32 %0, 2", "%1 = add i32 %0, 1")
        nsw = HALVE.replace("%1 = sdiv i32 %0, 2", "%1 = add nsw i32 %0, 1")
        package = self.built.refutation(wraps, nsw, [{"kind": "int", "value": "2147483647"}])
        done = self.replay(package)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("ERROR: Target is more poisonous than source", done.stdout)
        self.assertIn("Source:\n  %obs.result = i32 -2147483648", done.stdout)
        self.assertIn("Target:\n  %obs.result = poison", done.stdout)

    def test_a_tgt_with_ub_of_its_own_leaves_the_src_more_defined(self):
        # Widening a load past the object it reads from, on an object of one
        # byte. The pointer argument also shows what the harness does with
        # memory: the bytes go in before the call and are read back after.
        package = self.built.refutation(BYTE, WIDE, [{"kind": "bytes", "bytes": [7]}])
        done = self.replay(package)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("ERROR: Source is more defined than target", done.stdout)
        self.assertIn("ptr noundef %0 = [7]", done.stdout)
        self.assertIn("%obs.mem.0.0 = i8 7", done.stdout)
        self.assertIn("Target:\n  UB triggered: Out of bound mem op", done.stdout)

    def test_an_input_they_agree_on_is_refused(self):
        # Rounding parts company below zero only, so 4 halves the same way in
        # both, whatever the manifest claims about it.
        package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "4"}])
        done = self.replay(package)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("the two runs agree", done.stdout)
        self.assertIn("NOT a counterexample", done.stdout)

    def test_an_input_the_src_has_ub_on_is_refused(self):
        # Dividing by zero is UB, and a src with UB allows every target.
        package = self.built.refutation(
            DIVIDE, SHIFT2, [{"kind": "int", "value": "6"}, {"kind": "int", "value": "0"}]
        )
        done = self.replay(package)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("the src has UB on this input", done.stdout)

    def test_a_src_that_is_free_to_choose_is_refused(self):
        # A freeze takes an arbitrary value, so one run of this src is one of
        # its behaviours and the tgt is allowed any of them.
        chooses = HALVE.replace("  %1 = sdiv", "  %f = freeze i32 %0\n  %1 = sdiv")
        package = self.built.refutation(chooses, SHIFT, [{"kind": "int", "value": "-3"}])
        done = self.replay(package)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("free to choose (freeze)", done.stdout + done.stderr)

    def test_a_program_that_is_not_what_its_name_says(self):
        package = self.built.refutation(HALVE, SHIFT, [{"kind": "int", "value": "-3"}])
        digest = json.loads((package / "manifest.json").read_text())["pair"]["tgt"]
        (package / "programs" / f"{digest}.ll").write_text(SHIFT.replace("ashr", "lshr"))
        done = self.replay(package)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("is not the program its name claims", done.stdout + done.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
