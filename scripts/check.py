#!/usr/bin/env python3
"""Replay a certificate and say whether it holds.

    python3 check.py [<package>] [--alive-tv PATH] [--llops PATH] [--llubi PATH] [--llrwt PATH] [--mlir-translate PATH] [--mlir-opt PATH] [--smt-to MS]

The package is the directory this script sits in unless one is named. What is
needed besides Python: alive-tv for a proof, llubi for a counterexample, llrwt
for a proof that rewrites with pre-proved rules, and llops for the subcommands
each of them needs. All are taken from the manifest, which records where the
run found them and which LLVM each one carried; a path that is not there falls
back to the name on PATH, and an option overrides both.

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
    self.alive_tv = self.tool("alive-tv", tools.get("alive-tv"))
    self.llops = self.tool("llops", tools.get("llops"))
    self.llubi = self.tool("llubi", tools.get("llubi"))
    self.llrwt = self.tool("llrwt", tools.get("llrwt"))
    self.mlir_translate = tools.get("mlir-translate")
    self.mlir_opt = tools.get("mlir-opt")
    self.queries = 0
    self.seconds = 0.0
    # Programs are read more than once, and each read pays for a hash and
    # a model check; the files are immutable, so one answer lasts.
    self.read: dict[str, str] = {}

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
    checker = ("alive-tv", self.alive_tv) if self.verdict == "verified" else ("llubi", self.llubi)
    names = [checker, ("llops", self.llops)]
    if self.verdict == "verified":
      names.append(("llrwt", self.llrwt))
    for name, path in names:
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
    found = self.read.get(digest)
    if found is not None:
      return found
    path = self.root / "programs" / f"{digest}.ll"
    if not path.exists():
      raise Refused(f"the package has no program {digest}")
    text = path.read_text()
    if hashlib.sha256(text.encode()).hexdigest() != digest:
      raise Refused(f"{path.name} is not the program its name claims")
    # The no-undef model: a program holding an `undef` value has states
    # the model does not cover, and a certificate replay asks about none
    # of them, so one is refused rather than replayed under the wrong
    # model. The gate is `llops canon`, the checker a program passed when
    # the run stored it, applied here to the bytes the package carries.
    self.model_gate(text, f"{path.name} holds an undef value, which the no-undef model excludes")
    self.read[digest] = text
    return text

  def model_gate(self, module: str, said: str) -> str:
    """The module, unless it holds an `undef` value, which the model excludes."""
    answer = self.ask_llops("canon", {"module": module})
    if not answer.get("ok"):
      error = answer.get("error", {})
      if error.get("code") == "undef":
        raise Refused(said)
      raise Refused(f"llops canon: {error.get('message')}")
    return module

  def goal(self, gid: str) -> dict:
    found = self.manifest["goals"].get(gid)
    if found is None:
      raise Refused(f"the manifest has no goal {gid}")
    return found

  def refines(self, src: str, tgt: str) -> bool:
    """Ask alive-tv whether the second program refines the first."""
    with tempfile.TemporaryDirectory() as scratch:
      paths = []
      for name, item in (("src.ll", src), ("tgt.ll", tgt)):
        path = Path(scratch) / name
        # A digest is exactly a sha256 name; anything else is the
        # program itself, which is what a replayed window carries,
        # and it passes the model gate like any stored program.
        text = (
          self.program(item)
          if re.fullmatch(r"[0-9a-f]{64}", item)
          else self.model_gate(
            item,
            "a program carried in the manifest holds an undef value,"
            " which the no-undef model excludes",
          )
        )
        path.write_text(text)
        paths.append(str(path))
      started = time.monotonic()
      done = subprocess.run(
        [self.alive_tv, *paths, f"--smt-to={self.smt_to}", "--disable-undef-input"],
        capture_output=True,
        text=True,
      )
      self.seconds += time.monotonic() - started
      self.queries += 1
    return summary(done.stdout) == "correct"

  def ask_llops(self, subcommand: str, request: dict) -> dict:
    done = subprocess.run(
      [self.llops, subcommand],
      input=json.dumps(request),
      capture_output=True,
      text=True,
    )
    try:
      answer = json.loads(done.stdout)
    except json.JSONDecodeError as error:
      raise Refused(f"llops {subcommand} answered with no JSON: {done.stderr.strip()}") from (error)
    return answer

  def run_llops(self, subcommand: str, request: dict) -> dict:
    answer = self.ask_llops(subcommand, request)
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

  def run_llrwt(self, rules: list, module: str, invocation: dict) -> str:
    """Rewrite a program with llrwt under the recorded rules, and answer with what it printed."""
    if not rules:
      raise Refused("a rule step names no rules")
    with tempfile.TemporaryDirectory() as scratch:
      path = Path(scratch) / "in.ll"
      path.write_text(module)
      args = [self.llrwt, "--rules", ",".join(rules)]
      # The translators the run used, when this machine has them; an option
      # says where they are when it does not, and PATH otherwise.
      translators = (
        ("mlirTranslate", "--mlir-translate", self.mlir_translate),
        ("mlirOpt", "--mlir-opt", self.mlir_opt),
      )
      for key, flag, chosen in translators:
        recorded = chosen or invocation.get(key)
        if recorded and Path(recorded).exists():
          args += [flag, recorded]
      args += ["--allow-unregistered-dialect", str(path)]
      timeout_ms = invocation.get("timeoutMs") or 30000
      try:
        done = subprocess.run(
          args,
          capture_output=True,
          text=True,
          timeout=max(60, timeout_ms / 1000 + 30),
        )
      except subprocess.SubprocessError as error:
        raise Refused(f"llrwt did not finish: {error}") from error
      if done.returncode != 0:
        raise Refused(f"llrwt refused the replay: {done.stderr.strip() or done.stdout.strip()}")
      self.queries += 1
      return done.stdout


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


def signature(package: Package, module: str, name: str) -> str:
  """The parameter list and function attributes a function is declared or defined with.

  A cut leaves the callee declared in one program and defined in another, and
  they have to say the same thing about the arguments and semantic attributes:
  what the outer was checked against is what the callee has to be.
  """
  res = package.run_llops("validate", {"module": module})
  funcs = res.get("functions", {})
  fn = funcs.get(name)
  if not fn:
    raise Refused(f"@{name} is neither declared nor defined where it has to be")
  return fn["signature"]


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
    """Check one goal: its chain, then how it was discharged.

    `role` identifies the goal's role in a split: None means neither caller
    nor callee, "outer" means the caller, and any other value is the
    callee's name.
    """
    goal = self.package.goal(gid)
    head = self.chain(gid, goal, role)
    for side in ("src", "tgt"):
      if head[side] != goal["end"][side]:
        self.fail(gid, f"the {side} chain ends", f"at {head[side][:12]}, not the end pair")

    discharge = goal["discharge"]
    if discharge["kind"] == "checked":
      outcome = self.refines(goal["end"]["src"], goal["end"]["tgt"])
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
        outcome = self.refines(*pair)
        what = f"{side} step to {after[:12]}"
        self.say(gid, what, outcome) if outcome == "correct" else self.fail(gid, what, outcome)
        head[side] = after
      elif step["kind"] == "window":
        head[step["side"]] = self.window(gid, step, head)
      elif step["kind"] == "rule":
        head[step["side"]] = self.rule(gid, step, head)
      elif step["kind"] == "strengthen":
        self.strengthen(gid, step, head, role)
      else:
        self.fail(gid, "a step of kind", f"{step['kind']}, which this does not know")
    return head

  def strengthen(self, gid: str, step: dict, head: dict, role: str | None) -> None:
    """Replay the exact parameter attributes, function attributes, and entry predicates a callee claims to have gained."""
    if role is None or role == "outer":
      self.fail(gid, "an attribute", "on a goal that is not a callee")
      return

    param_attrs = step.get("param_attrs") or {}
    fn_attrs = step.get("fn_attrs") or {}
    predicates = step.get("predicates") or []

    if not param_attrs and not fn_attrs and not predicates:
      raise Refused(
        "a strengthen step has no parameter attributes, function attributes, or predicates"
      )

    replayable: list[tuple[int, dict]] = []
    for key, fact in param_attrs.items():
      # JSON object keys are always strings; require the exact format the engine emits.
      if not isinstance(key, (str, int)) or not re.fullmatch(r"(?:0|[1-9]\d*)", str(key)):
        raise Refused(f"a strengthen parameter is not a non-negative integer index: {key!r}")
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
      if fn_attrs:
        attributed = self.package.run_llops(
          "edit",
          {
            "module": attributed,
            "op": "attrs",
            "fn": role,
            "attrs": fn_attrs,
          },
        )["module"]
      if predicates:
        attributed = self.package.run_llops(
          "assume",
          {
            "module": attributed,
            "anchor": {"at": "entry", "fn": role},
            "assertions": predicates,
          },
        )["module"]
      same = self.package.run_llops("canon", {"module": attributed})["module"]
      what = f"the attributes on {side} replay"
      if same == self.package.program(step["to"][side]):
        self.say(gid, what, "matches")
      else:
        self.fail(gid, what, "to a different program")
      head[side] = step["to"][side]

  def window(self, gid: str, step: dict, head: dict) -> str:
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
      assertions = []
      for arg_str, fact in preconditions.items():
        try:
          arg = int(arg_str)
        except ValueError:
          self.fail(gid, "precondition arg", f"invalid integer {arg_str}")
          return step["to"]
        assertions.append({"fact": fact, "arg": arg})

      res = self.package.run_llops(
        "assume",
        {
          "module": self.package.program(window["outer"]),
          "anchor": {"at": "before_call", "fn": window["callee"]},
          "assertions": assertions,
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
      assume_outcome = self.refines(self.package.program(whole), inlined_assumed)
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
      pair = (window["from"], window["to"]) if side == "src" else (window["to"], window["from"])

    outcome = self.refines(*pair)
    what = f"{side} window to {step['to'][:12]}"
    self.say(gid, what, outcome) if outcome == "correct" else self.fail(gid, what, outcome)
    return step["to"]

  def rule(self, gid: str, step: dict, head: dict) -> str:
    """A step the verified rewriter certified: rerun the same invocation.

    No solver is asked anything. What says the step holds is that llrwt, run
    again under the recorded rules, prints the recorded program back.
    """
    side = step["side"]
    if step["from"] != head[side]:
      self.fail(gid, f"a {side} step starts", f"at {step['from'][:12]}, not the head")
      return step["to"]

    replayed = self.package.run_llrwt(
      step.get("rules") or [], self.package.program(step["from"]), step.get("invocation") or {}
    )
    same = self.package.run_llops("canon", {"module": replayed})["module"]
    what = f"{side} rule to {step['to'][:12]}"
    if same == self.package.program(step["to"]):
      self.say(gid, what, "matches")
    else:
      self.fail(gid, what, "to a different program")
    return step["to"]

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
      declared = signature(self.package, self.package.program(outer["end"][side]), name)
      defined = signature(self.package, self.package.program(inner["end"][side]), name)
      what = f"@{name} says the same on both {side} halves"
      if declared == defined:
        self.say(gid, what, "matches")
      else:
        self.fail(gid, what, f"{declared} against {defined}")

    # The outer half keeps the entry the cut was made in; the callee's
    # parameters are values computed before it, so it is asked about them
    # under no assumption at all.
    self.goal(discharge["outer"], "outer")
    self.goal(discharge["inner"], name)

  def refines(self, src: str, tgt: str) -> str:
    return "correct" if self.package.refines(src, tgt) else "not correct"


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
  program the one construct that does not is `freeze`, which takes an arbitrary
  defined value. The tgt is under no such condition: whatever it was seen to do
  is something it does.
  """
  found = re.search(r"\bfreeze\b", module)
  return found.group(0) if found else None


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


def declared(package: Package, module: str, entry: str) -> list[str]:
  """Each parameter of the entry function, as the program declares it."""
  res = package.run_llops("validate", {"module": module})
  funcs = res.get("functions", {})
  fn = funcs.get(entry)
  if not fn:
    return []
  out = []
  for p in fn.get("params", []):
    parts = [p["type"]]
    attrs = p.get("attrs", {})
    if attrs.get("noundef"):
      parts.append("noundef")
    if attrs.get("nonnull"):
      parts.append("nonnull")
    if "align" in attrs:
      parts.append(f"align {attrs['align']}")
    if "dereferenceable" in attrs:
      parts.append(f"dereferenceable({attrs['dereferenceable']})")
    if "range" in attrs:
      parts.append(f"range({p['type']} {attrs['range']['min']}, {attrs['range']['max']})")
    parts.append(f"%{p['index']}")
    out.append(" ".join(parts))
  return out


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
      declared(self.package, module, entry), self.package.manifest["input"], strict=False
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


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  parser.add_argument("package", nargs="?", type=Path, default=Path(__file__).resolve().parent)
  parser.add_argument("--alive-tv", help="default: where the manifest says, else PATH")
  parser.add_argument("--llops", help="default: where the manifest says, else PATH")
  parser.add_argument("--llubi", help="default: where the manifest says, else PATH")
  parser.add_argument("--llrwt", help="default: where the manifest says, else PATH")
  parser.add_argument("--mlir-translate", help="default: where the manifest says, else PATH")
  parser.add_argument("--mlir-opt", help="default: where the manifest says, else PATH")
  parser.add_argument("--smt-to", type=int, default=600_000, help="ms per query, default 600000")
  parser.add_argument("-v", "--verbose", action="store_true", help="say what passes too")
  args = parser.parse_args()

  named = {
    "alive-tv": args.alive_tv,
    "llops": args.llops,
    "llubi": args.llubi,
    "llrwt": args.llrwt,
    "mlir-translate": args.mlir_translate,
    "mlir-opt": args.mlir_opt,
  }
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
  print("verified")
  return 0


if __name__ == "__main__":
  sys.exit(main())
