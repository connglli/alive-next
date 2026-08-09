#!/usr/bin/env python3
"""Replay a certificate and say whether it holds.

    python3 check.py [<package>] [--alive-tv PATH] [--llops PATH] [--smt-to MS]

The package is the directory this script sits in unless one is named. What is
needed besides Python: alive-tv, and llops for the two subcommands a cut is
checked with. Both are taken from the manifest, which records where the run
found them and which LLVM each one carried; a path that is not there falls
back to the name on PATH, and either option overrides both.

Nothing here believes the manifest. It says which pairs a proof moved through
and this reruns every claim about them: the direction of a check comes from the
side the step moved, the composition rule for a cut is applied here, and a
program is read only from a file whose name is its hash.
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

VERSION = 1


class Refused(Exception):
    """The certificate does not hold, saying where."""


# --- the package -------------------------------------------------------------


class Package:
    def __init__(self, root: Path, alive_tv: str | None, llops: str | None, smt_to: int):
        self.root = root
        self.smt_to = smt_to
        self.manifest = json.loads((root / "manifest.json").read_text())
        if self.manifest.get("version") != VERSION:
            raise Refused(f"manifest version {self.manifest.get('version')}, expected {VERSION}")
        if self.manifest.get("verdict") != "verified":
            raise Refused(f"a certificate for {self.manifest.get('verdict')} is not a proof")
        self.alive_tv = self.tool("alive-tv", alive_tv)
        self.llops = self.tool("llops", llops)
        self.queries = 0
        self.seconds = 0.0

    def tool(self, name: str, chosen: str | None) -> str:
        """Where to find a binary: the option, then the manifest, then PATH."""
        if chosen:
            return chosen
        recorded = self.recorded(name).get("path")
        return recorded if recorded and Path(recorded).exists() else name

    def recorded(self, name: str) -> dict:
        """What the manifest says about a binary the run used."""
        toolchain = self.manifest.get("toolchain") or {}
        tools = toolchain.get("tools") or {}
        found = tools.get(name)
        return found if isinstance(found, dict) else {}

    def say_toolchain(self) -> None:
        """Name the binaries in use, and say when they are not the recorded ones."""
        for name, path in (("alive-tv", self.alive_tv), ("llops", self.llops)):
            here = llvm_version(path)
            recorded = self.recorded(name).get("llvm")
            said = f"  {name:<9} {path}"
            if here:
                said += f" (LLVM {here})"
            if recorded and here and recorded != here:
                said += f", but the run used LLVM {recorded}"
            elif recorded and not here:
                said += f", which did not say; the run used LLVM {recorded}"
            print(said)

    def program(self, digest: str) -> str:
        """A program, read from the file whose name says what it must hash to."""
        path = self.root / "programs" / f"{digest}.ll"
        if not path.exists():
            raise Refused(f"the package has no program {digest}")
        text = path.read_text()
        if hashlib.sha256(text.encode()).hexdigest() != digest:
            raise Refused(f"{path.name} is not the program its name claims")
        return text

    def goal(self, gid: str) -> dict:
        found = self.manifest["goals"].get(gid)
        if found is None:
            raise Refused(f"the manifest has no goal {gid}")
        return found

    def refines(self, src: str, tgt: str, flags: list[str]) -> bool:
        """Ask alive-tv whether the second program refines the first."""
        with tempfile.TemporaryDirectory() as scratch:
            paths = []
            for name, digest in (("src.ll", src), ("tgt.ll", tgt)):
                path = Path(scratch) / name
                path.write_text(self.program(digest))
                paths.append(str(path))
            started = time.monotonic()
            done = subprocess.run(
                [self.alive_tv, *paths, f"--smt-to={self.smt_to}", *flags],
                capture_output=True,
                text=True,
            )
            self.seconds += time.monotonic() - started
            self.queries += 1
        return summary(done.stdout) == "correct"

    def run_llops(self, subcommand: str, request: dict) -> dict:
        done = subprocess.run(
            [self.llops, subcommand],
            input=json.dumps(request),
            capture_output=True,
            text=True,
        )
        try:
            answer = json.loads(done.stdout)
        except json.JSONDecodeError as error:
            raise Refused(f"llops {subcommand} answered with no JSON: {done.stderr.strip()}") from (
                error
            )
        if not answer.get("ok"):
            raise Refused(f"llops {subcommand}: {answer.get('error', {}).get('message')}")
        return answer


def llvm_version(path: str) -> str | None:
    """The LLVM a binary reports, however it words its version banner."""
    # llops reads its request from stdin, so a binary that does not know the
    # argument is not left waiting for one.
    for arguments in (["--version"], ["version"]):
        try:
            done = subprocess.run(
                [path, *arguments],
                capture_output=True,
                text=True,
                timeout=30,
                stdin=subprocess.DEVNULL,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        found = re.search(r"LLVM (?:version )?(\d+(?:\.\d+)+)", done.stdout + done.stderr)
        if found:
            return found.group(1)
    return None


def summary(stdout: str) -> str:
    """What alive-tv said, out of its summary block rather than its exit code."""
    counts = {}
    for what in ("correct", "incorrect", "failed-to-prove"):
        found = re.search(rf"^\s*(\d+) {what} transformations$", stdout, re.M)
        counts[what] = int(found.group(1)) if found else None
    errors = re.search(r"^\s*(\d+) Alive2 errors$", stdout, re.M)
    if None in counts.values() or errors is None:
        return "no answer"
    if counts["incorrect"]:
        return "incorrect"
    if int(errors.group(1)):
        return "errors"
    if counts["failed-to-prove"]:
        return "failed to prove"
    return "correct" if counts["correct"] else "nothing compared"


# --- signatures --------------------------------------------------------------


def signature(module: str, name: str) -> str:
    """The parameter list a function is declared or defined with, names aside.

    A cut leaves the callee declared in one program and defined in another, and
    they have to say the same thing about the arguments: what the outer was
    checked against is what the callee has to be.
    """
    pattern = rf"^(?:declare|define)\b(?P<head>[^@]*)@{re.escape(name)}\((?P<params>.*)\)"
    found = re.search(pattern, module, re.M)
    if not found:
        raise Refused(f"@{name} is neither declared nor defined where it has to be")
    types = found.group("head").split()
    types = [word for word in types if word not in ("dso_local", "local_unnamed_addr")]
    return f"{' '.join(types)}({', '.join(parameters(found.group('params')))})"


def parameters(text: str) -> list[str]:
    """Each parameter as its type and attributes, with any name dropped."""
    out, depth, current = [], 0, ""
    for char in text:
        if char == "," and depth == 0:
            out.append(current)
            current = ""
            continue
        depth += {"(": 1, ")": -1}.get(char, 0)
        current += char
    if current.strip():
        out.append(current)
    return [" ".join(word for word in one.split() if not word.startswith("%")) for one in out]


# --- the proof ---------------------------------------------------------------


class Check:
    """Every claim the manifest makes, rerun."""

    def __init__(self, package: Package, verbose: bool):
        self.package = package
        self.verbose = verbose
        self.failures: list[str] = []

    def say(self, gid: str, what: str, outcome: str) -> None:
        mark = "ok " if outcome in ("correct", "faithful", "matches") else "BAD"
        if mark != "ok " or self.verbose:
            print(f"  {mark} {gid:<4} {what:<44} {outcome}", flush=True)

    def fail(self, gid: str, what: str, outcome: str) -> None:
        self.say(gid, what, outcome)
        self.failures.append(f"{gid}: {what}: {outcome}")

    def goal(self, gid: str, role: str | None = None) -> None:
        """Check one goal: its chain, then how it was discharged."""
        goal = self.package.goal(gid)
        head = self.chain(gid, goal, role)
        for side in ("src", "tgt"):
            if head[side] != goal["end"][side]:
                self.fail(gid, f"the {side} chain ends", f"at {head[side][:12]}, not the end pair")

        discharge = goal["discharge"]
        if discharge["kind"] == "checked":
            outcome = self.refines(goal["end"]["src"], goal["end"]["tgt"], [])
            self.say(gid, "the pair it was left with", outcome) if outcome == "correct" else (
                self.fail(gid, "the pair it was left with", outcome)
            )
        elif discharge["kind"] == "split":
            self.split(gid, goal, discharge)
        else:
            self.fail(gid, "discharged by", f"{discharge['kind']}, which this does not know")

    def chain(self, gid: str, goal: dict, role: str | None) -> dict:
        """Walk the steps, checking each one in the direction its side implies."""
        head = dict(goal["start"])
        for step in goal["steps"]:
            if step["kind"] == "checked":
                side = step["side"]
                if step["from"] != head[side]:
                    self.fail(gid, f"a {side} step starts", f"at {step['from'][:12]}, not the head")
                # A src step optimises forward, so the new program has to refine
                # the old; a tgt step deoptimises backward, so the old refines
                # the new.
                before, after = step["from"], step["to"]
                pair = (before, after) if side == "src" else (after, before)
                outcome = self.refines(*pair, step.get("flags", []))
                what = f"{side} step to {after[:12]}"
                self.say(gid, what, outcome) if outcome == "correct" else self.fail(
                    gid, what, outcome
                )
                head[side] = after
            elif step["kind"] == "strengthen":
                # Nothing certifies this on its own. What does is the outer's
                # chain, every step of which is checked here, and the signature
                # the two halves have to share, which the cut checks below.
                if role != "callee":
                    self.fail(gid, "an attribute", "on a goal that is not a callee")
                for side in ("src", "tgt"):
                    if step["from"][side] != head[side]:
                        self.fail(gid, f"an attribute on {side} starts", "away from the head")
                    head[side] = step["to"][side]
            else:
                self.fail(gid, "a step of kind", f"{step['kind']}, which this does not know")
        return head

    def split(self, gid: str, goal: dict, discharge: dict) -> None:
        """A cut holds when it inlines back to the pair it was made on."""
        outer = self.package.goal(discharge["outer"])
        inner = self.package.goal(discharge["inner"])
        name = discharge["callee"]

        for side in ("src", "tgt"):
            back = self.package.run_llops(
                "inline",
                {
                    "outer": self.package.program(outer["start"][side]),
                    "callee": self.package.program(inner["start"][side]),
                    "callee_name": name,
                },
            )["module"]
            same = self.package.run_llops("canon", {"module": back})["module"]
            whole = self.package.program(goal["end"][side])
            what = f"the {side} halves inline back"
            if same == whole:
                self.say(gid, what, "faithful")
            else:
                self.fail(gid, what, "to a different program")

        # The outer was checked against a declaration; the callee proves a
        # definition. An attribute on one and not the other is a claim nobody
        # made, so the two have to say the same thing.
        for side in ("src", "tgt"):
            declared = signature(self.package.program(outer["end"][side]), name)
            defined = signature(self.package.program(inner["end"][side]), name)
            what = f"@{name} says the same on both {side} halves"
            if declared == defined:
                self.say(gid, what, "matches")
            else:
                self.fail(gid, what, f"{declared} against {defined}")

        self.goal(discharge["outer"], "outer")
        self.goal(discharge["inner"], "callee")

    def refines(self, src: str, tgt: str, flags: list[str]) -> str:
        return "correct" if self.package.refines(src, tgt, flags) else "not correct"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("package", nargs="?", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--alive-tv", help="default: where the manifest says, else PATH")
    parser.add_argument("--llops", help="default: where the manifest says, else PATH")
    parser.add_argument("--smt-to", type=int, default=600_000, help="ms per query, default 600000")
    parser.add_argument("-v", "--verbose", action="store_true", help="say what passes too")
    args = parser.parse_args()

    try:
        package = Package(args.package, args.alive_tv, args.llops, args.smt_to)
        check = Check(package, args.verbose)
        print(f"checking {args.package}")
        package.say_toolchain()
        check.goal(package.manifest["root"])
    except (Refused, OSError) as error:
        print(f"refused: {error}", file=sys.stderr)
        return 1

    print(f"{package.queries} solver queries in {package.seconds:.1f}s")
    if check.failures:
        print(f"NOT verified: {len(check.failures)} of them did not hold")
        return 1
    print("verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
