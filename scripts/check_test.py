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
HAVE = Path(ALIVE_TV).exists() and Path(LLOPS).exists()

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

    def write(self, root: str = "g1", version: int = 1, verdict: str = "verified") -> Path:
        manifest = {
            "version": version,
            "verdict": verdict,
            "root": root,
            "toolchain": {},
            "goals": self.goals,
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
