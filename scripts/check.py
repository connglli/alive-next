#!/usr/bin/env python3
"""Replay a certificate and say whether it holds.

    python3 check.py [<package>] [--alive-tv PATH] [--llops PATH] [--llubi PATH] [--smt-to MS]

The package is the directory this script sits in unless one is named. What is
needed besides Python: alive-tv for a proof, llubi for a counterexample, and
llops for the subcommands each of them needs. All are taken from the manifest,
which records where the run found them and which LLVM each one carried; a path
that is not there falls back to the name on PATH, and an option overrides both.

Nothing here believes the manifest. For a proof it says which pairs the run
moved through and this reruns every claim about them: the direction of a check
comes from the side the step moved, the composition rule for a cut is applied
here, and a program is read only from a file whose name is its hash. For a
counterexample it names one input, and this runs both programs on it and
decides for itself whether they diverge.
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

# What an input assumption is stated to alive-tv as, and the only options this
# knows. An option it does not know could weaken what alive-tv was asked, so a
# step that recorded one is refused rather than replayed with it.
ASSUMPTION_FLAGS = {
    "noUndef": "--disable-undef-input",
    "noPoison": "--disable-poison-input",
}


class Refused(Exception):
    """The certificate does not hold, saying where."""


# --- the package -------------------------------------------------------------


class Package:
    def __init__(self, root: Path, tools: dict[str, str | None], smt_to: int):
        self.root = root
        self.smt_to = smt_to
        self.manifest = json.loads((root / "manifest.json").read_text())
        if self.manifest.get("version") != VERSION:
            raise Refused(f"manifest version {self.manifest.get('version')}, expected {VERSION}")
        self.verdict = self.manifest.get("verdict")
        if self.verdict not in ("verified", "counterexample"):
            raise Refused(f"a certificate for {self.verdict} is not a proof or a counterexample")
        self.assumed = self.assumption()
        self.alive_tv = self.tool("alive-tv", tools.get("alive-tv"))
        self.llops = self.tool("llops", tools.get("llops"))
        self.llubi = self.tool("llubi", tools.get("llubi"))
        self.queries = 0
        self.seconds = 0.0

    def assumption(self) -> list[str]:
        """The options the run's assumption about the pair's arguments is made of.

        A proof holds only under what the run was allowed to take for granted,
        so this is read from the manifest and stated with the verdict. A
        manifest naming an assumption this does not know is refused: replaying
        it would prove something other than what it says.
        """
        stated = self.manifest.get("assumed") or {}
        unknown = set(stated) - set(ASSUMPTION_FLAGS)
        if unknown:
            raise Refused(
                f"the manifest assumes {', '.join(sorted(unknown))}, which this does not know"
            )
        return [flag for name, flag in ASSUMPTION_FLAGS.items() if stated.get(name)]

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
        checker = (
            ("alive-tv", self.alive_tv) if self.verdict == "verified" else ("llubi", self.llubi)
        )
        for name, path in (checker, ("llops", self.llops)):
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
            for name, item in (("src.ll", src), ("tgt.ll", tgt)):
                path = Path(scratch) / name
                # A digest is exactly a sha256 name; anything else is the
                # program itself, which is what a replayed window carries.
                text = self.program(item) if re.fullmatch(r"[0-9a-f]{64}", item) else item
                path.write_text(text)
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

    def interpret(self, module: str) -> str:
        """Run a harness under llubi, and answer with everything it said."""
        started = time.monotonic()
        try:
            done = subprocess.run(
                [self.llubi, "-", "--verbose", "--fill-uninitialized-mem-with-poison"],
                input=module,
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.SubprocessError as error:
            raise Refused(f"llubi did not finish: {error}") from error
        self.seconds += time.monotonic() - started
        self.queries += 1
        # llubi says everything on stderr: the trace, the UB, and its own
        # complaints. The exit code carries the return value, not the outcome.
        return done.stderr


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
    return [
        " ".join(word for word in one.split() if not word.startswith("%"))
        for one in split_parameters(text)
    ]


def split_parameters(text: str) -> list[str]:
    """A parameter list, split on the commas that separate parameters."""
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
    return [" ".join(one.split()) for one in out]


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

    def goal(self, gid: str, role: str | None = None, entry: bool = True) -> None:
        """Check one goal: its chain, then how it was discharged.

        `entry` is whether the goal still has the pair's own entry, which is
        what decides the options its checks are replayed with. The root has it
        and an outer half keeps it, since outlining a suffix leaves the entry
        where it was; everything under a callee loses it, because a callee's
        parameters are values the program computed and the run's assumption
        about arguments says nothing about them. This is worked out here rather
        than read from the manifest, which is free to claim anything.

        `role` identifies the goal's role in a split: None means neither caller
        nor callee, "outer" means the caller, and any other value is the
        callee's name.
        """
        goal = self.package.goal(gid)
        flags = self.package.assumed if entry else []
        head = self.chain(gid, goal, role, flags)
        for side in ("src", "tgt"):
            if head[side] != goal["end"][side]:
                self.fail(gid, f"the {side} chain ends", f"at {head[side][:12]}, not the end pair")

        discharge = goal["discharge"]
        if discharge["kind"] == "checked":
            outcome = self.refines(goal["end"]["src"], goal["end"]["tgt"], flags)
            self.say(gid, "the pair it was left with", outcome) if outcome == "correct" else (
                self.fail(gid, "the pair it was left with", outcome)
            )
        elif discharge["kind"] == "split":
            self.split(gid, goal, discharge, entry)
        else:
            self.fail(gid, "discharged by", f"{discharge['kind']}, which this does not know")

    def chain(self, gid: str, goal: dict, role: str | None, flags: list[str]) -> dict:
        """Walk the steps, checking each one in the direction its side implies."""
        head = dict(goal["start"])
        for step in goal["steps"]:
            if step["kind"] == "checked":
                side = step["side"]
                if step["from"] != head[side]:
                    self.fail(gid, f"a {side} step starts", f"at {step['from'][:12]}, not the head")
                # A step is rerun under what its goal is asked under, whatever
                # it recorded. Recording anything else is a claim about the
                # question rather than about the step, so it is refused.
                if sorted(step.get("flags", [])) != sorted(flags):
                    self.fail(
                        gid, f"a {side} step's options", "are not the ones its goal is asked under"
                    )
                # A src step optimises forward, so the new program has to refine
                # the old; a tgt step deoptimises backward, so the old refines
                # the new.
                before, after = step["from"], step["to"]
                pair = (before, after) if side == "src" else (after, before)
                outcome = self.refines(*pair, flags)
                what = f"{side} step to {after[:12]}"
                self.say(gid, what, outcome) if outcome == "correct" else self.fail(
                    gid, what, outcome
                )
                head[side] = after
            elif step["kind"] == "window":
                head[step["side"]] = self.window(gid, step, head, flags)
            elif step["kind"] == "strengthen":
                self.strengthen(gid, step, head, role)
            else:
                self.fail(gid, "a step of kind", f"{step['kind']}, which this does not know")
        return head

    def strengthen(self, gid: str, step: dict, head: dict, role: str | None) -> None:
        """Replay the exact parameter attributes a callee claims to have gained."""
        if role is None or role == "outer":
            self.fail(gid, "an attribute", "on a goal that is not a callee")
            return

        facts = step.get("facts")
        if not isinstance(facts, dict) or not facts:
            raise Refused("a strengthen step has no facts")

        replayable: list[tuple[int, dict]] = []
        for key, fact in facts.items():
            # JSON object keys are always strings; require the exact format the engine emits.
            if not isinstance(key, str) or not re.fullmatch(r"(?:0|[1-9]\d*)", key):
                raise Refused(
                    f"a strengthen parameter is not a non-negative integer index: {key!r}"
                )
            if not isinstance(fact, dict):
                raise Refused(f"a strengthen fact for parameter {key} is not an object")
            replayable.append((int(key), fact))
        replayable.sort(key=lambda item: item[0])

        for side in ("src", "tgt"):
            if step["from"][side] != head[side]:
                self.fail(gid, f"an attribute on {side} starts", "away from the head")
            attributed = self.package.program(step["from"][side])
            for param, fact in replayable:
                attributed = self.package.run_llops(
                    "edit",
                    {
                        "module": attributed,
                        "op": "attrs",
                        "fn": role,
                        "param": param,
                        "attrs": fact,
                    },
                )["module"]
            same = self.package.run_llops("canon", {"module": attributed})["module"]
            what = f"the attributes on {side} replay"
            if same == self.package.program(step["to"][side]):
                self.say(gid, what, "matches")
            else:
                self.fail(gid, what, "to a different program")
            head[side] = step["to"][side]

    def window(self, gid: str, step: dict, head: dict, flags: list[str] = None) -> str:
        """A step narrowed to a window, optionally with proved preconditions.

        Both halves are inlined back into the outer program to verify faithfulness.
        If preconditions are present:
        Phase 1: Prove whole-function that outer + llvm.assume refines the whole
        being replaced, which is the before whole for a src step and the after
        whole for a tgt step. That is the side whose definedness the step's
        obligation starts from, so it is the one the facts must hold on.
        Phase 2: Add attributes to parameters of both window halves and check small pair.
        """
        side = step["side"]
        if step["from"] != head[side]:
            self.fail(gid, f"a {side} step starts", f"at {step['from'][:12]}, not the head")
        if step.get("flags"):
            self.fail(
                gid, f"a {side} window's options", "are not none, which is what it is asked under"
            )

        window = step["window"]
        preconditions = window.get("preconditions", {})

        for whole, half, which in (
            (step["from"], window["from"], "from"),
            (step["to"], window["to"], "to"),
        ):
            back = self.package.run_llops(
                "inline",
                {
                    "outer": self.package.program(window["outer"]),
                    "callee": self.package.program(half),
                    "callee_name": window["callee"],
                },
            )["module"]
            same = self.package.run_llops("canon", {"module": back})["module"]
            what = f"the {which} half of a {side} window inlines back"
            if same == self.package.program(whole):
                self.say(gid, what, "faithful")
            else:
                self.fail(gid, what, "to a different program")

        if preconditions:
            # Phase 1: Insert assumes before call in outer and verify whole-function
            outer_assumed = self.package.program(window["outer"])
            for arg_str, fact in preconditions.items():
                try:
                    arg = int(arg_str)
                except ValueError:
                    self.fail(gid, "precondition arg", f"invalid integer {arg_str}")
                    return step["to"]
                res = self.package.run_llops(
                    "assume",
                    {
                        "module": outer_assumed,
                        "before_call": window["callee"],
                        "arg": arg,
                        "fact": fact,
                    },
                )
                outer_assumed = res["module"]

            # Phase 1: which whole the step replaces decides which half is
            # asked about it: a src step's obligation starts at the before
            # whole and a tgt step's at the after whole, and the facts are what
            # must hold there.
            half = window["from"] if side == "src" else window["to"]
            whole = step["from"] if side == "src" else step["to"]
            inlined_assumed = self.package.run_llops(
                "inline",
                {
                    "outer": outer_assumed,
                    "callee": self.package.program(half),
                    "callee_name": window["callee"],
                },
            )["module"]

            # Asking the assumed program to refine the whole it was cut from is
            # what says the facts hold wherever that whole is defined: where the
            # assume is false the assumed program is UB, so any defined execution
            # of the whole forces the facts true.
            assume_outcome = self.refines(self.package.program(whole), inlined_assumed, flags or [])
            if assume_outcome != "correct":
                self.fail(gid, "conditioned window precondition", f"failed: {assume_outcome}")

            # Phase 2: Add attrs to both callee halves and check small pair
            c_from = self.package.program(window["from"])
            c_to = self.package.program(window["to"])
            for arg_str, fact in preconditions.items():
                arg = int(arg_str)
                res_from = self.package.run_llops(
                    "edit",
                    {
                        "module": c_from,
                        "op": "attrs",
                        "fn": window["callee"],
                        "param": arg,
                        "attrs": fact,
                    },
                )
                res_to = self.package.run_llops(
                    "edit",
                    {
                        "module": c_to,
                        "op": "attrs",
                        "fn": window["callee"],
                        "param": arg,
                        "attrs": fact,
                    },
                )
                c_from = res_from["module"]
                c_to = res_to["module"]

            pair = (c_from, c_to) if side == "src" else (c_to, c_from)
        else:
            pair = (
                (window["from"], window["to"]) if side == "src" else (window["to"], window["from"])
            )

        outcome = self.refines(*pair, [])
        what = f"{side} window to {step['to'][:12]}"
        self.say(gid, what, outcome) if outcome == "correct" else self.fail(gid, what, outcome)
        return step["to"]

    def split(self, gid: str, goal: dict, discharge: dict, entry: bool) -> None:
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

        # The outer half keeps the entry the cut was made in; the callee's
        # parameters are values computed before it, so it is asked about them
        # under no assumption at all.
        self.goal(discharge["outer"], "outer", entry)
        self.goal(discharge["inner"], name, False)

    def refines(self, src: str, tgt: str, flags: list[str]) -> str:
        return "correct" if self.package.refines(src, tgt, flags) else "not correct"


# --- the counterexample ------------------------------------------------------


def entry_of(module: str) -> str:
    """The one function a program defines, which is what a harness wraps."""
    found = re.search(r"^define\b[^@]*@([\w.$]+)\s*\(", module, re.M)
    if not found:
        raise Refused("a program of the pair defines no function")
    return found.group(1)


def poison_return(run: dict) -> bool:
    """Whether a run stopped in the harness rather than in the program.

    `llops harness` stores what the entry returned so that it can be observed,
    and storing poison is UB, so that store is the only UB the harness itself
    can have. Stopping there says the program had no UB: it returned poison,
    which is a different thing to report and a different thing to fix.
    """
    return run["outcome"] == "ub" and run.get("at", "").endswith("at @main")


def choosing(module: str) -> str | None:
    """What lets a program behave more than one way on a fixed input, if anything.

    The comparison below reads one run of the src as everything the src allows,
    which holds only where the input settles what it does. In a straightline
    program the two constructs that do not are `undef`, which takes a fresh
    value at every use, and `freeze`, which takes an arbitrary one. The tgt is
    under no such condition: whatever it was seen to do is something it does.
    """
    found = re.search(r"\b(undef|freeze)\b", module)
    return found.group(1) if found else None


def read_run(trace: str) -> dict:
    """What llubi's trace says: how the run ended, and what it observed.

    An observation is one trace line, since llubi prints each instruction with
    its result and the exit code is only the return value truncated to eight
    bits. `llops harness` names them so they can be found.
    """
    observations = {}
    for line in trace.split("\n"):
        named = re.match(r"^\s*(%obs\.[\w.]+)\s*=\s*(.*)$", line)
        if not named:
            continue
        # The value is what follows the last arrow, since the instruction
        # itself may contain one.
        at = named.group(2).rfind(" -> ")
        if at >= 0:
            observations[named.group(1)] = named.group(2)[at + 4 :].strip()

    ub = re.search(r"^UB triggered: (.*)$", trace, re.M)
    if ub:
        # The innermost frame of the stacktrace, which says where it stopped.
        where = re.search(r"^Stacktrace:\n\s*(.*)$", trace, re.M)
        return {
            "outcome": "ub",
            "observations": observations,
            "reason": ub.group(1).strip(),
            "at": where.group(1).strip() if where else "",
        }
    if "Exiting function main" in trace:
        return {"outcome": "returned", "observations": observations, "reason": ""}
    lines = [line.strip() for line in trace.split("\n") if line.strip()]
    return {
        "outcome": "error",
        "observations": observations,
        "reason": lines[-1] if lines else "llubi said nothing",
    }


def divergence(src: dict, tgt: dict) -> tuple[bool, str]:
    """Whether the tgt run does what the src run does not allow.

    A src with UB on this input allows every target, so it settles nothing. A
    tgt with UB where the src returned is a refutation, and so is any
    observation the two disagree on. Poison needs no case of its own: the
    harness stores what the entry returns and storing poison is UB, so a poison
    result arrives as UB on the side that produced it.
    """
    for side, run in (("src", src), ("tgt", tgt)):
        if run["outcome"] == "error":
            return False, f"the {side} did not run: {run['reason']}"
    if src["outcome"] == "ub":
        return False, f"the src has UB on this input ({src['reason']}), so every target refines it"
    if tgt["outcome"] == "ub":
        if poison_return(tgt):
            return True, "the tgt returns poison where the src returns a value"
        return True, f"the tgt has UB where the src returns: {tgt['reason']}"
    if sorted(src["observations"]) != sorted(tgt["observations"]):
        return False, "the two runs do not observe the same things"
    for name, value in src["observations"].items():
        if value != tgt["observations"][name]:
            return True, f"{name} is {value} in the src and {tgt['observations'][name]} in the tgt"
    return False, "the two runs agree"


def declared(module: str, entry: str) -> list[str]:
    """Each parameter of the entry function, as the program declares it."""
    found = re.search(rf"^define\b[^@]*@{re.escape(entry)}\((?P<params>.*)\)", module, re.M)
    return split_parameters(found.group("params")) if found else []


def given(argument: dict) -> str:
    """One argument as the manifest gives it, in the notation it gives it in."""
    kind = argument.get("kind")
    if kind == "int":
        return str(argument.get("value"))
    if kind == "null":
        return "null"
    if kind == "bytes":
        align = f" align {argument['align']}" if argument.get("align") else ""
        return f"[{', '.join(str(byte) for byte in argument.get('bytes', []))}]{align}"
    return json.dumps(argument)


class Replay:
    """The pair, run on the input the manifest names."""

    def __init__(self, package: Package, verbose: bool):
        self.package = package
        self.verbose = verbose

    def say(self, entry: str, module: str, runs: dict, confirmed: bool) -> None:
        """What was run and what each side did, as alive2 reports the same thing."""
        if confirmed:
            print()
            print(f"ERROR: {self.error(runs)}")
        print()
        print("Example:")
        # Not strict: llops harness takes one argument per parameter and has
        # already refused an input of the wrong length, and a report is no
        # place to raise.
        for param, argument in zip(
            declared(module, entry), self.package.manifest["input"], strict=False
        ):
            print(f"{param} = {given(argument)}")
        for side, name in (("src", "Source"), ("tgt", "Target")):
            print()
            print(f"{name}:")
            run = runs[side]
            if poison_return(run):
                # Nothing was observed: the store the harness makes to observe
                # the result is where it stopped.
                print("  %obs.result = poison")
            elif run["outcome"] == "ub":
                print(f"  UB triggered: {run['reason']}")
            for observed, value in run["observations"].items():
                print(f"  {observed} = {value}")
        print()

    def error(self, runs: dict) -> str:
        """What went wrong, in the words alive2 reports the same thing in."""
        if poison_return(runs["tgt"]):
            return "Target is more poisonous than source"
        if runs["tgt"]["outcome"] == "ub":
            return "Source is more defined than target"
        return "Value mismatch"

    def confirm(self) -> bool:
        pair = self.package.manifest["pair"]
        programs = {side: self.package.program(pair[side]) for side in ("src", "tgt")}
        entries = {side: entry_of(text) for side, text in programs.items()}
        if entries["src"] != entries["tgt"]:
            raise Refused(
                f"the pair defines @{entries['src']} on one side and @{entries['tgt']} on the other"
            )
        choice = choosing(programs["src"])
        if choice:
            raise Refused(
                f"the src is free to choose ({choice}), so one run of it does not say what it allows"
            )

        runs = {}
        for side, text in programs.items():
            harness = self.package.run_llops(
                "harness",
                {
                    "module": text,
                    "entry": entries[side],
                    "args": self.package.manifest["input"],
                },
            )["module"]
            runs[side] = read_run(self.package.interpret(harness))

        confirmed, reason = divergence(runs["src"], runs["tgt"])
        self.say(entries["src"], programs["src"], runs, confirmed)
        print(reason)
        return confirmed


def under(flags: list[str]) -> str:
    """What the verdict was reached under, for the line that states it."""
    if not flags:
        return ""
    said = {
        "--disable-undef-input": "no argument is undef",
        "--disable-poison-input": "no argument is poison",
    }
    return f", assuming {' and '.join(said[flag] for flag in flags)}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("package", nargs="?", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--alive-tv", help="default: where the manifest says, else PATH")
    parser.add_argument("--llops", help="default: where the manifest says, else PATH")
    parser.add_argument("--llubi", help="default: where the manifest says, else PATH")
    parser.add_argument("--smt-to", type=int, default=600_000, help="ms per query, default 600000")
    parser.add_argument("-v", "--verbose", action="store_true", help="say what passes too")
    args = parser.parse_args()

    named = {"alive-tv": args.alive_tv, "llops": args.llops, "llubi": args.llubi}
    try:
        package = Package(args.package, named, args.smt_to)
        print(f"checking {args.package}")
        package.say_toolchain()
        if package.verdict == "counterexample":
            confirmed = Replay(package, args.verbose).confirm()
        else:
            check = Check(package, args.verbose)
            check.goal(package.manifest["root"])
            confirmed = not check.failures
    except (Refused, OSError) as error:
        print(f"refused: {error}", file=sys.stderr)
        return 1

    counted = "runs" if package.verdict == "counterexample" else "solver queries"
    print(f"{package.queries} {counted} in {package.seconds:.1f}s")
    if package.verdict == "counterexample":
        print("counterexample" if confirmed else "NOT a counterexample: they do not diverge")
        return 0 if confirmed else 1
    if not confirmed:
        print(f"NOT verified: {len(check.failures)} of them did not hold")
        return 1
    # A proof means what it means only under what the run was allowed to take
    # for granted, so the verdict never stands on its own.
    print(f"verified{under(package.assumed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
