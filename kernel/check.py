#!/usr/bin/env python3
"""Replay a certificate and say whether it holds.

    python3 check.py [<package>] [--alive-tv PATH] [--llops PATH] [--llubi PATH] [--llrwt PATH] [--mlir-translate PATH] [--mlir-opt PATH] [--smt-to MS]

The package is the directory this script sits in unless one is named. What is
needed besides Python: alive-tv, llubi for a counterexample alive-tv did not
decide, llrwt for a proof that rewrites with pre-proved rules, and llops for
the subcommands each of them needs. All are taken from the manifest, which records
where the run found them and which LLVM each one carried; a path that is not
there falls back to the name on PATH, and an option overrides both.

Nothing here believes the manifest. For a proof it says which pairs the run
moved through and this reruns every claim about them: the direction of a check
comes from the side the step moved, the composition rule for a cut is applied
here, and a program is read only from a file whose name is its hash. For a
counterexample it says which pair was refuted, at which input when it names
one, and by which checker. The pair, put at that input by `llops
instantiate`, is asked of alive-tv again. One llubi refuted, because alive-tv
did not decide it, is run again under llubi only where alive-tv still does
not decide, and this decides for itself whether the two runs diverge.
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


# --- reporting ---------------------------------------------------------------


def report_prefix(
  result: str,
  gid: str,
  side: str,
  tool: str,
  elapsed: str,
  check: str,
) -> str:
  """The fixed columns before a row's notes."""
  return f"{result:<7} {gid:<5} {side:<5} {tool:<14} {elapsed:<9} {check:<22} "


def report_header() -> None:
  print(
    report_prefix("RESULT", "GOAL", "SIDE", "TOOL", "ELAPSED", "CHECK") + "NOTES",
    flush=True,
  )


def report_row(
  *,
  result: str,
  gid: str,
  side: str,
  tool: str,
  check: str,
  notes: str = "",
  ms: int | None = None,
) -> None:
  """Print one obligation, aligning continuation lines with its notes."""
  elapsed = f"{ms}ms" if ms is not None else "--"
  prefix = report_prefix(result, gid, side, tool, elapsed, check)
  lines = notes.split("\n") if notes else [""]
  print(f"{prefix}{lines[0]}", flush=True)
  for line in lines[1:]:
    print(f"{' ' * len(prefix)}{line}", flush=True)


def elapsed_ms(started: float) -> int:
  return int((time.monotonic() - started) * 1000)


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
    # Reporting-only breakdown: the existing aggregate counters above retain
    # their original meaning.
    self.solver_queries = 0
    self.rewrite_runs = 0
    self.rewrite_seconds = 0.0
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
    names = [("alive-tv", self.alive_tv), ("llops", self.llops)]
    if self.verdict == "counterexample" and self.source() == "llubi":
      names.insert(1, ("llubi", self.llubi))
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
    # model. The gate is `llops canon`, and the text must also be its output,
    # which is how the run stored every program.
    said = f"{path.name} holds an undef value, which the no-undef model excludes"
    if self.model_gate(text, said) != text:
      raise Refused(f"{path.name} is not in canonical form")
    self.read[digest] = text
    return text

  def model_gate(self, module: str, said: str) -> str:
    """The module in canonical form, unless it holds an `undef` value, which the model excludes."""
    answer = self.ask_llops("canon", {"module": module})
    if not answer.get("ok"):
      error = answer.get("error", {})
      if error.get("code") == "undef":
        raise Refused(said)
      raise Refused(f"llops canon: {error.get('message')}")
    return answer["module"]

  def shape_gate(self, module: str, unroll: int = 0) -> str:
    """The module, if `llops validate` calls it a program, loop-free unless unrolled."""
    answer = self.run_llops("validate", {"module": module})
    if not answer.get("conforms"):
      codes = ", ".join(d.get("code", "?") for d in answer.get("diagnostics", []))
      raise Refused(f"a program handed to alive-tv is outside the program shape: {codes}")
    if answer.get("cyclic") is not False and not unroll:
      raise Refused(
        "a program handed to alive-tv loops, which it answers only as far as it unrolls"
      )
    return module

  def goal(self, gid: str) -> dict:
    found = self.manifest["goals"].get(gid)
    if found is None:
      raise Refused(f"the manifest has no goal {gid}")
    return found

  def refines(self, src: str, tgt: str) -> bool:
    """Ask alive-tv whether the second program refines the first."""
    return self.ask(src, tgt) == "correct"

  def loops(self, module: str) -> bool:
    """Whether `llops validate` says the program loops."""
    return self.run_llops("validate", {"module": module}).get("cyclic") is not False

  def refutes(self, src: str, tgt: str, unroll: int = 0) -> bool:
    """Ask alive-tv whether the second program fails to refine the first."""
    return self.ask(src, tgt, unroll) == "incorrect"

  def ask(self, src: str, tgt: str, unroll: int = 0) -> str:
    """Ask alive-tv about the pair, and answer with its summary."""
    with tempfile.TemporaryDirectory() as scratch:
      paths = []
      for name, item in (("src.ll", src), ("tgt.ll", tgt)):
        path = Path(scratch) / name
        # A digest is exactly a sha256 name; anything else is the
        # program itself, which is what a replayed window carries,
        # and it passes the model gate like any stored program.
        if re.fullmatch(r"[0-9a-f]{64}", item):
          text = self.program(item)
        else:
          self.model_gate(
            item,
            "a program carried in the manifest holds an undef value,"
            " which the no-undef model excludes",
          )
          text = item
        path.write_text(self.shape_gate(text, unroll))
        paths.append(str(path))
      unrolled = [f"--src-unroll={unroll}", f"--tgt-unroll={unroll}"] if unroll else []
      started = time.monotonic()
      done = subprocess.run(
        [self.alive_tv, *paths, f"--smt-to={self.smt_to}", "--disable-undef-input", *unrolled],
        capture_output=True,
        text=True,
      )
      self.seconds += time.monotonic() - started
      self.queries += 1
      self.solver_queries += 1
    return summary(done.stdout)

  def root_goal(self) -> str:
    """The goal a counterexample refutes, which has to be named."""
    found = self.manifest.get("root")
    if not isinstance(found, str):
      raise Refused("a counterexample names no root goal")
    return found

  def source(self) -> str:
    """What certifies a counterexample: the checker for the pair, or an input."""
    found = self.manifest.get("source", "llubi")
    if found not in ("llubi", "alive2"):
      raise Refused(f"unknown counterexample source {found!r}")
    return found

  def counterexample_pair(self) -> dict:
    """The pair a counterexample is of, which has to name two programs."""
    pair = self.manifest.get("pair")
    if (
      not isinstance(pair, dict)
      or not isinstance(pair.get("src"), str)
      or not isinstance(pair.get("tgt"), str)
    ):
      raise Refused("a counterexample names no pair to ask about")
    return pair

  def counterexample_input(self) -> list | None:
    """The input a counterexample names, if it names one."""
    found = self.manifest.get("input")
    if found is not None and not isinstance(found, list):
      raise Refused("a counterexample's input is not a list of arguments")
    return found

  def counterexample_unroll(self) -> int:
    """The unroll factor a counterexample names, 0 when it names none."""
    found = self.manifest.get("unroll", 0)
    if not isinstance(found, int) or isinstance(found, bool) or found < 0:
      raise Refused("a counterexample's unroll factor is not a whole number")
    return found

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
        [
          self.llubi,
          "-",
          "--verbose",
          "--fill-uninitialized-mem-with-poison",
          "--store-poison-is-ub=false",
        ],
        input=module,
        capture_output=True,
        text=True,
        timeout=60,
      )
    except (OSError, subprocess.SubprocessError) as error:
      raise Refused(f"llubi did not finish: {error}") from error
    self.seconds += time.monotonic() - started
    self.queries += 1
    # llubi says everything on stderr: the trace, the UB, and its own
    # complaints. The exit code carries the return value, not the outcome.
    return done.stderr

  def run_llrwt(self, rules: list, module: str, invocation: dict) -> str:
    """Rewrite a program with llrwt under the recorded rules, and answer with what it printed."""
    if not rules:
      raise Refused("a rewrite step names no rules")
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
      started = time.monotonic()
      try:
        done = subprocess.run(
          args,
          capture_output=True,
          text=True,
          timeout=max(60, timeout_ms / 1000 + 30),
        )
      except (OSError, subprocess.SubprocessError) as error:
        raise Refused(f"llrwt did not finish: {error}") from error
      duration = time.monotonic() - started
      if done.returncode != 0:
        raise Refused(f"llrwt refused the replay: {done.stderr.strip() or done.stdout.strip()}")
      self.queries += 1
      self.rewrite_runs += 1
      self.rewrite_seconds += duration
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

# Each comparison's inverse, which holds exactly where it fails on values that are not poison.
INVERSE = dict(eq="ne", ne="eq", slt="sge", sge="slt", sgt="sle", sle="sgt")
INVERSE |= dict(ult="uge", uge="ult", ugt="ule", ule="ugt")


def signature(package: Package, module: str, name: str) -> str:
  """The types and every attribute a function is declared or defined with.

  A cut leaves the callee declared in one program and defined in another, and
  they have to say the same thing about the arguments and semantic attributes:
  what the outer was checked against is what the callee has to be.
  """
  return function(package, module, name)["signature"]


def contract_predicates(step: dict) -> list:
  """A strengthen step's predicates. At the callee's start, llops refuses any that names a value."""
  predicates = step.get("predicates") or []
  if not isinstance(predicates, list):
    raise Refused("a strengthen step's predicates are not a list")
  return predicates


def parameter_facts(param_attrs: dict) -> list[tuple[int, dict]]:
  """A strengthen step's parameter facts, by index, in the order the engine assumes them."""
  facts: list[tuple[int, dict]] = []
  for key, fact in param_attrs.items():
    # JSON object keys are always strings; require the exact format the engine emits.
    if not isinstance(key, (str, int)) or not re.fullmatch(r"(?:0|[1-9]\d*)", str(key)):
      raise Refused(f"a strengthen parameter is not a non-negative integer index: {key!r}")
    if not isinstance(fact, dict):
      raise Refused(f"a strengthen fact for parameter {key} is not an object")
    facts.append((int(key), fact))
  return sorted(facts, key=lambda item: item[0])


def return_facts(step: dict) -> dict:
  """A strengthen step's return facts, only those that make a value outside them poison."""
  facts = step.get("ret_attrs") or {}
  if not isinstance(facts, dict):
    raise Refused("a strengthen step's return facts are not an object")
  others = sorted(set(facts) - {"range", "nonnull", "align"})
  if others:
    raise Refused(f"a strengthen step's return facts name {', '.join(others)}, not poison")
  return facts


def bare(package: Package, module: str, name: str) -> bool:
  """Whether a function is declared or defined without any attribute."""
  return function(package, module, name)["bare"] is True


def body_attrs(package: Package, module: str) -> list:
  """The attributes that change what the instructions of a program's function may do."""
  attrs = package.run_llops("validate", {"module": module}).get("body_attrs")
  if not isinstance(attrs, list):
    raise Refused("llops validate does not list body_attrs")
  return attrs


def function(package: Package, module: str, name: str) -> dict:
  """What `llops validate` says about one function the module names."""
  fn = package.run_llops("validate", {"module": module}).get("functions", {}).get(name)
  if not fn:
    raise Refused(f"@{name} is neither declared nor defined where it has to be")
  return fn


# --- the proof ---------------------------------------------------------------


class Check:
  """Every claim the manifest makes, rerun."""

  def __init__(self, package: Package, verbose: bool):
    self.package = package
    self.verbose = verbose
    self.failures: list[str] = []
    self.held = 0
    self.failed = 0
    self.unresolved = 0

  def report(
    self,
    *,
    result: str,
    gid: str,
    side: str,
    tool: str,
    check: str,
    notes: str = "",
    ms: int | None = None,
  ) -> None:
    """Report and count one obligation without changing replay control flow.

    ELAPSED is wall-clock time for the reported obligation, including program
    loading, model gates, and preparation performed within that obligation.
    The summary's solver and rewriter times measure their subprocesses only.
    """
    if result != "OK" or self.verbose:
      report_row(
        result=result,
        gid=gid,
        side=side,
        tool=tool,
        check=check,
        notes=notes,
        ms=ms,
      )
    if result == "OK":
      self.held += 1
    else:
      self.failures.append(f"{gid}: {side}: {check}: {notes}")
      if result == "FAIL":
        self.failed += 1
      else:
        self.unresolved += 1

  def outlined(self, gid: str, side: str, module: str) -> None:
    """A cut or a window moves no instruction out of a function with body_attrs."""
    started = time.monotonic()
    held = body_attrs(self.package, module)
    self.report(
      result="FAIL" if held else "OK",
      gid=gid,
      side=side,
      tool="llops",
      check="Outlined body",
      notes=f"has {', '.join(held)}" if held else "no body_attrs",
      ms=elapsed_ms(started),
    )

  def fail(self, gid: str, side: str, check: str, notes: str) -> None:
    """Record a structural failure; the caller decides whether to continue."""
    self.report(
      result="FAIL",
      gid=gid,
      side=side,
      tool="kernel",
      check=check,
      notes=notes,
    )

  def asked(
    self,
    gid: str,
    side: str,
    check: str,
    src: str,
    tgt: str,
    notes: str,
    *,
    tool: str = "alive-tv",
    started: float | None = None,
  ) -> None:
    """Ask alive-tv about one pair, preserving its answer in the report."""
    if started is None:
      started = time.monotonic()
    outcome = self.package.ask(src, tgt)
    ms = elapsed_ms(started)
    result = {"correct": "OK", "incorrect": "FAIL"}.get(outcome, "ERROR")
    if result != "OK":
      notes = f"{notes}; alive-tv: {outcome}" if notes else f"alive-tv: {outcome}"
    self.report(
      result=result,
      gid=gid,
      side=side,
      tool=tool,
      check=check,
      notes=notes,
      ms=ms,
    )

  def checked(
    self, gid: str, side: str, check: str, by: str, src: str, tgt: str, notes: str
  ) -> None:
    """Ask the checker `by` names whether `tgt` refines `src`.

    alive-tv answers with a solver. A pair whose tgt only reshapes the
    control flow of its src, or only adds attributes its instructions
    respect, is asked of the llops command of that name, with no solver.
    """
    if by == "alive2":
      self.asked(gid, side, check, src, tgt, notes)
      return
    if by not in ("reshaped", "respected"):
      self.fail(gid, side, "Checker", f"{by}, which this does not know")
      return
    started = time.monotonic()
    program = self.package.program
    answer = self.package.run_llops(by, {"before": program(src), "after": program(tgt)})
    if not answer[by]:
      notes = f"{notes}; llops: {answer.get('why')}"
    self.report(
      result="OK" if answer[by] else "FAIL",
      gid=gid,
      side=side,
      tool="llops",
      check=check,
      notes=notes,
      ms=elapsed_ms(started),
    )

  def compared(
    self,
    gid: str,
    side: str,
    tool: str,
    check: str,
    notes: str,
    same: bool,
    ms: int,
  ) -> None:
    """Report an equality comparison against the recorded program."""
    outcome = "recorded program matches" if same else "recorded program differs"
    self.report(
      result="OK" if same else "FAIL",
      gid=gid,
      side=side,
      tool=tool,
      check=check,
      notes=f"{notes}; {outcome}" if notes else outcome,
      ms=ms,
    )

  def goal(
    self,
    gid: str,
    role: str | None = None,
    loop: dict | None = None,
    callee: str | None = None,
  ) -> None:
    """Check one goal: its chain, then how it was discharged.

    `role` identifies the goal's role in a cut: None means neither caller
    nor callee, "outer" means the caller, and any other value is the
    callee's name. `loop`, on a half of a loop cut at its header, names the
    hypothesis, and on the outer also the pair the callee started with.
    `callee`, on the outer, names the function the cut outlined.
    """
    goal = self.package.goal(gid)
    head = self.chain(gid, goal, role, loop, callee)
    for side in ("src", "tgt"):
      if head[side] != goal["end"][side]:
        self.fail(
          gid,
          side,
          "Chain endpoint",
          f"ends at {head[side][:12]}, not the end pair",
        )

    discharge = goal["discharge"]
    if discharge["kind"] == "check" and goal["end"]["src"] == goal["end"]["tgt"]:
      # A program refines itself, so the same program on both sides needs no
      # solver, looping or not, but is read, which checks its hash and the no-undef model.
      self.package.program(goal["end"]["src"])
      self.report(
        result="OK",
        gid=gid,
        side="pair",
        tool="kernel",
        check="Final refinement",
        notes="the two sides are the same program",
      )
    elif discharge["kind"] == "check":
      self.checked(
        gid,
        "pair",
        "Final refinement",
        discharge.get("by", "alive2"),
        goal["end"]["src"],
        goal["end"]["tgt"],
        "tgt refines src",
      )
    elif discharge["kind"] == "cut":
      self.cut(gid, goal, discharge)
    elif discharge["kind"] == "interpose":
      self.interpose(goal, discharge)
    elif discharge["kind"] == "case":
      self.case(gid, goal, discharge)
    else:
      self.fail(
        gid,
        "pair",
        "Discharge kind",
        f"{discharge['kind']}, which this does not know",
      )

  def chain(
    self, gid: str, goal: dict, role: str | None, loop: dict | None, callee: str | None = None
  ) -> dict:
    """Walk the steps, checking each one in the direction its side implies."""
    head = dict(goal["start"])
    for step in goal["steps"]:
      if step["kind"] == "check":
        side = step["side"]
        if step["from"] != head[side]:
          self.fail(
            gid,
            side,
            "Chain continuity",
            f"step starts at {step['from'][:12]}, not the head",
          )
        # A src step optimises forward, so the new program has to refine
        # the old; a tgt step deoptimises backward, so the old refines
        # the new.
        before, after = step["from"], step["to"]
        pair = (before, after) if side == "src" else (after, before)
        which = "forward" if side == "src" else "backward"
        notes = f"{before[:12]} -> {after[:12]}; {which}"
        self.checked(gid, side, "Chain step", step.get("by", "alive2"), *pair, notes)
        head[side] = after
      elif step["kind"] == "window":
        head[step["side"]] = self.window(gid, step, head)
      elif step["kind"] == "rewrite":
        head[step["side"]] = self.rewrite(gid, step, head)
      elif step["kind"] == "unfold":
        head[step["side"]] = self.unfold(gid, step, head, loop)
      elif step["kind"] == "strengthen" and role == "outer":
        self.returns(gid, step, head, callee)
      elif step["kind"] == "strengthen":
        self.strengthen(gid, step, head, role, loop)
      else:
        self.fail(
          gid,
          "--",
          "Step kind",
          f"{step['kind']}, which this does not know",
        )
    return head

  def strengthen(
    self, gid: str, step: dict, head: dict, role: str | None, loop: dict | None
  ) -> None:
    """Replay the exact parameter attributes, function attributes, entry predicates, and return facts a callee claims to have gained."""
    if role is None or role == "outer":
      self.fail(
        gid,
        "pair",
        "Strengthening role",
        "on a goal that is not a callee",
      )
      return

    param_attrs = step.get("param_attrs") or {}
    fn_attrs = step.get("fn_attrs") or {}
    predicates = contract_predicates(step)
    ret_attrs = return_facts(step)

    if not param_attrs and not fn_attrs and not predicates and not ret_attrs:
      raise Refused(
        "a strengthen step has no parameter attributes, function attributes, predicates,"
        " or return facts"
      )

    replayable = parameter_facts(param_attrs)
    # The callee's own return, and for a loop its hypothesis's, which the
    # return facts are proved under: induction over the calls of the hypothesis.
    returners = [role, loop["hypothesis"]] if loop else [role]

    # The outer assumes these attributes of the callee, so its src has to keep them.
    if fn_attrs:
      bare = self.package.program(step["from"]["src"])
      kept = self.package.run_llops("attrs", {"module": bare, "fn": role, "attrs": fn_attrs})
      notes = f"@{role} keeps {', '.join(fn_attrs)}"
      self.asked(gid, "src", "Callee attributes", bare, kept["module"], notes)

    # The outer assumes the return facts of the callee's src, which keeps them
    # when its hypothesis returns them. That is induction over the facts a loop
    # was given before, whose proof at the hypothesis's calls assumed nothing of
    # what it returns, so return facts come alone.
    if ret_attrs and (param_attrs or fn_attrs or predicates):
      self.fail(gid, "pair", "Return facts", "come with other facts in one strengthening")
    elif ret_attrs:
      bare = self.package.program(step["from"]["src"])
      assumed = self.returning(bare, returners[1:], ret_attrs)
      kept = self.returning(assumed, [role], ret_attrs)
      notes = f"@{role} keeps {', '.join(ret_attrs)} on its return"
      self.asked(gid, "src", "Return facts", assumed, kept, notes)

    replayed = ", ".join(
      (["parameter attributes"] if param_attrs else [])
      + (["function attributes"] if fn_attrs else [])
      + (["entry predicates"] if predicates else [])
      + (["return facts"] if ret_attrs else [])
    )
    for side in ("src", "tgt"):
      if step["from"][side] != head[side]:
        self.fail(
          gid,
          side,
          "Chain continuity",
          "strengthening starts away from the head",
        )
      started = time.monotonic()
      attributed = self.package.program(step["from"][side])
      for param, fact in replayable:
        attributed = self.package.run_llops(
          "attrs",
          {"module": attributed, "fn": role, "param": param, "attrs": fact},
        )["module"]
      if fn_attrs:
        attributed = self.package.run_llops(
          "attrs",
          {"module": attributed, "fn": role, "attrs": fn_attrs},
        )["module"]
      if predicates:
        attributed = self.package.run_llops(
          "assume",
          {
            "module": attributed,
            "anchor": {"at": "start", "fn": role},
            "assertions": predicates,
          },
        )["module"]
      attributed = self.returning(attributed, returners, ret_attrs)
      # A loop's tgt takes the contract before its calls of the hypothesis too.
      if side == "tgt" and loop:
        attributed = self.enforced(attributed, loop["hypothesis"], replayable, predicates)
      same = self.package.run_llops("canon", {"module": attributed})["module"]
      matches = same == self.package.program(step["to"][side])
      ms = elapsed_ms(started)
      self.compared(
        gid,
        side,
        "llops",
        "Strengthening replay",
        replayed,
        matches,
        ms,
      )
      head[side] = step["to"][side]

  def returning(self, module: str, fns: list, facts: dict) -> str:
    """`module` with `facts` on the return of each of `fns`."""
    for fn in fns if facts else []:
      request = {"module": module, "fn": fn, "return": True, "attrs": facts}
      module = self.package.run_llops("attrs", request)["module"]
    return module

  def returns(self, gid: str, step: dict, head: dict, callee: str | None) -> None:
    """Replay the return facts an outer's declaration of its callee claims to have gained.

    They are no step: on the src they add poison to the call's result. The cut
    holds them to what the callee's own strengthening showed its src keeps.
    """
    facts = return_facts(step)
    others = [key for key in ("param_attrs", "fn_attrs", "predicates", "by") if step.get(key)]
    if callee is None or not facts or others:
      self.fail(gid, "pair", "Strengthening role", "an outer takes return facts alone")
      return
    for side in ("src", "tgt"):
      if step["from"][side] != head[side]:
        self.fail(gid, side, "Chain continuity", "strengthening starts away from the head")
      started = time.monotonic()
      returned = self.returning(self.package.program(step["from"][side]), [callee], facts)
      same = self.package.run_llops("canon", {"module": returned})["module"]
      matches = same == self.package.program(step["to"][side])
      notes = f"@{callee} returns {', '.join(facts)}"
      self.compared(gid, side, "llops", "Strengthening replay", notes, matches, elapsed_ms(started))
      head[side] = step["to"][side]

  def predicates(
    self, discharge: dict, step: dict, hypothesis: str | None, between: str | None
  ) -> None:
    """The proof that enforced a strengthen step's contract at each call of the callee.

    The parameter facts go on the declaration of the function called and the
    predicates are assumed before each call. The outer calls the callee; a
    recursive callee also calls its hypothesis, where the proof is that one
    iteration keeps what the entry assumed.
    """
    name = discharge["callee"]
    sites = [(discharge["outer"], name)]
    if hypothesis:
      sites.append((discharge["inner"], hypothesis))
    by = step.get("by")
    if not isinstance(by, list):
      raise Refused("a strengthen step names its proofs under by as a list")
    links = [link for link in by if isinstance(link, dict)]
    facts = parameter_facts(step.get("param_attrs") or {})
    for gid, fn in sites:
      proved = next((link.get("hash") for link in links if link.get("gid") == gid), None)
      found = self.proof(gid, proved, between if fn == hypothesis else None)
      if found is None:
        self.fail(
          gid, "src", "Predicate proof", f"no src step proves the entry predicates before @{fn}"
        )
        continue
      start, later = found
      # One iteration keeps the contract when the proof starts from the
      # program that assumed it at the entry. After an unfold, the copy in the
      # middle would carry that assumption too, and it was never proved there.
      if fn == hypothesis and start != step["to"]["src"]:
        self.fail(
          gid,
          "src",
          "Predicate proof",
          f"the proof before @{fn} does not start from the program the contract was assumed in",
        )
        continue
      # An unfold of the outer after the proof would make calls of the loop
      # that the proof does not cover.
      if fn == name and any(s.get("kind") == "unfold" for s in later):
        self.fail(gid, "src", "Predicate proof", f"an unfold follows the proof before @{fn}")
        continue
      started = time.monotonic()
      module = self.package.program(start)
      enforced = self.enforced(module, fn, facts, contract_predicates(step))
      same = self.package.run_llops("canon", {"module": enforced})["module"]
      matches = same == self.package.program(proved)
      self.compared(
        gid, "src", "llops", "Predicate proof", f"enforced at @{fn}", matches, elapsed_ms(started)
      )

  def proof(self, gid: str, proved: str | None, between: str | None) -> tuple[str, list] | None:
    """Where the proof that made `proved` in goal `gid` starts, and the steps after it."""
    steps = self.package.goal(gid)["steps"]
    for at, s in enumerate(steps):
      if proved and s.get("side") == "src" and s.get("to") == proved:
        return s["from"], steps[at + 1 :]
    # A callee whose iteration loops is interposed at the program the step would make.
    if proved and proved == between:
      return self.package.goal(gid)["end"]["src"], []
    return None

  def between(self, gid: str) -> str | None:
    """The program a callee goal is interposed at, if its strengthen names it as a proof."""
    goal = self.package.goal(gid)
    named = {
      link.get("hash")
      for step in goal["steps"]
      if step.get("kind") == "strengthen" and isinstance(step.get("by"), list)
      for link in step["by"]
      if isinstance(link, dict) and link.get("gid") == gid
    }
    discharge = goal["discharge"]
    if discharge.get("kind") == "interpose" and discharge.get("program") in named:
      return discharge["program"]
    return None

  def enforced(self, module: str, fn: str, facts: list, predicates: list) -> str:
    """`module` with `facts` on `fn`'s declaration and `predicates` before each call."""
    for param, fact in facts:
      module = self.package.run_llops(
        "attrs", {"module": module, "fn": fn, "param": param, "attrs": fact}
      )["module"]
    if predicates:
      anchor = {"at": "before_calls", "fn": fn}
      request = {"module": module, "anchor": anchor, "assertions": predicates}
      module = self.package.run_llops("assume", request)["module"]
    return module

  def window(self, gid: str, step: dict, head: dict) -> str:
    """A step narrowed to a window, optionally with proved preconditions.

    Both halves are inlined back into the outer program to verify faithfulness.
    If preconditions or predicates are present:
    Phase 1: Prove whole-function that outer + llvm.assume refines the whole
    being replaced, which is the before whole for a src step and the after
    whole for a tgt step. That is the side whose definedness the step's
    obligation starts from, so it is the one the facts must hold on.
    Phase 2: Add attributes and predicates to both window halves and check small pair.
    """
    side = step["side"]
    if step["from"] != head[side]:
      self.fail(
        gid,
        side,
        "Chain continuity",
        f"step starts at {step['from'][:12]}, not the head",
      )

    window = step["window"]
    preconditions = window.get("preconditions", {})
    predicates = window.get("predicates", [])

    for whole, half, which in (
      (step["from"], window["from"], "from"),
      (step["to"], window["to"], "to"),
    ):
      started = time.monotonic()
      back = self.package.run_llops(
        "inline",
        {
          "outer": self.package.program(window["outer"]),
          "callee": self.package.program(half),
          "callee_name": window["callee"],
        },
      )["module"]
      same = self.package.run_llops("canon", {"module": back})["module"]
      matches = same == self.package.program(whole)
      ms = elapsed_ms(started)
      self.compared(
        gid,
        side,
        "llops",
        "Window reconstruction",
        f"inline the {which} half",
        matches,
        ms,
      )
    self.outlined(gid, side, self.package.program(step["from"]))

    if preconditions or predicates:
      # Phase 1: Insert assumes before call in outer and verify whole-function
      assertions = list(predicates)
      for arg_str, fact in preconditions.items():
        try:
          arg = int(arg_str)
        except ValueError:
          self.fail(
            gid,
            side,
            "Precondition argument",
            f"invalid integer {arg_str}",
          )
          return step["to"]
        assertions.append({"fact": fact, "of": f"!{arg}"})

      started = time.monotonic()
      res = self.package.run_llops(
        "assume",
        {
          "module": self.package.program(window["outer"]),
          "anchor": {"at": "before_calls", "fn": window["callee"]},
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
      self.asked(
        gid,
        side,
        "Window precondition",
        self.package.program(whole),
        inlined_assumed,
        "caller preconditions on defined executions of the whole",
        tool="llops+alive-tv",
        started=started,
      )

      # Phase 2: Add attrs to both callee halves and check small pair.
      # Include preparation in this obligation's row time.
      started = time.monotonic()
      c_from = self.package.program(window["from"])
      c_to = self.package.program(window["to"])
      for arg_str, fact in preconditions.items():
        arg = int(arg_str)
        res_from = self.package.run_llops(
          "attrs",
          {"module": c_from, "fn": window["callee"], "param": arg, "attrs": fact},
        )
        res_to = self.package.run_llops(
          "attrs",
          {"module": c_to, "fn": window["callee"], "param": arg, "attrs": fact},
        )
        c_from = res_from["module"]
        c_to = res_to["module"]
      if predicates:
        start = {"at": "start", "fn": window["callee"]}
        c_from, c_to = (
          self.package.run_llops(
            "assume", {"module": half, "anchor": start, "assertions": predicates}
          )["module"]
          for half in (c_from, c_to)
        )

      pair = (c_from, c_to) if side == "src" else (c_to, c_from)
      tool = "llops+alive-tv"
    else:
      started = time.monotonic()
      pair = (window["from"], window["to"]) if side == "src" else (window["to"], window["from"])
      tool = "alive-tv"

    which = "forward" if side == "src" else "backward"
    self.asked(
      gid,
      side,
      "Window refinement",
      *pair,
      f"{window['from'][:12]} -> {window['to'][:12]}; {which}; narrowed",
      tool=tool,
      started=started,
    )
    return step["to"]

  def rewrite(self, gid: str, step: dict, head: dict) -> str:
    """A step the verified rewriter certified: rerun the same invocation.

    No solver is asked anything. What says the step holds is that llrwt, run
    again under the recorded rules, prints the recorded program back.
    """
    side = step["side"]
    # TODO: Support tgt->src rewrites (some kind of anti-optimizations).
    if side != "src":
      self.fail(
        gid,
        side,
        "Rewrite direction",
        f"recorded on {side}, but rules optimize forward on src only",
      )
      return step["to"]
    if list(step.get("invocation", {}).get("rules") or []) != list(step.get("rules") or []):
      self.fail(
        gid,
        side,
        "Rewrite invocation",
        "recorded rules do not match the invocation",
      )
      return step["to"]
    if step["from"] != head[side]:
      self.fail(
        gid,
        side,
        "Chain continuity",
        f"step starts at {step['from'][:12]}, not the head",
      )
      return step["to"]

    started = time.monotonic()
    replayed = self.package.run_llrwt(
      step.get("rules") or [], self.package.program(step["from"]), step.get("invocation") or {}
    )
    same = self.package.run_llops("canon", {"module": replayed})["module"]
    matches = same == self.package.program(step["to"])
    ms = elapsed_ms(started)
    rules = ", ".join(step.get("rules") or [])
    self.compared(
      gid,
      side,
      "llrwt+llops",
      "Rewriter replay",
      f"{step['from'][:12]} -> {step['to'][:12]}; {rules}",
      matches,
      ms,
    )
    return step["to"]

  def unfold(self, gid: str, step: dict, head: dict, loop: dict | None) -> str:
    """A detached loop's body put at each call of its hypothesis, or of the
    loop in the outer: unfold again and compare.

    The loop stays the same, so the step holds on either side and no solver
    is asked anything. The outer takes the loop as the cut made it, which is
    the loop reattach puts back.
    """
    side = step["side"]
    if loop is None:
      self.fail(gid, side, "Unfold", "on a goal that is not a half of a loop cut at its header")
      return step["to"]
    if step["from"] != head[side]:
      self.fail(
        gid,
        side,
        "Chain continuity",
        f"step starts at {step['from'][:12]}, not the head",
      )
      return step["to"]

    started = time.monotonic()
    request = {"module": self.package.program(step["from"]), "hypothesis": loop["hypothesis"]}
    if "callee" in loop:
      request["callee"] = self.package.program(loop["callee"][side])
    unfolded = self.package.run_llops("unfold", request)["module"]
    same = self.package.run_llops("canon", {"module": unfolded})["module"]
    matches = same == self.package.program(step["to"])
    self.compared(
      gid,
      side,
      "llops",
      "Unfold replay",
      f"{step['from'][:12]} -> {step['to'][:12]}; @{loop['hypothesis']}",
      matches,
      elapsed_ms(started),
    )
    return step["to"]

  def interpose(self, goal: dict, discharge: dict) -> None:
    """A goal holds through a program put between its two sides.

    The lhs half claims the program refines the goal's src, the rhs half that
    the goal's tgt refines the program, and refinement is transitive, as along
    a chain. Each half is a goal of its own with no role and no loop, since
    every callee stays uninterpreted in all three programs.
    """
    program = discharge["program"]
    halves = (
      (discharge["lhs"], {"src": goal["end"]["src"], "tgt": program}),
      (discharge["rhs"], {"src": program, "tgt": goal["end"]["tgt"]}),
    )
    for half, pair in halves:
      start = self.package.goal(half)["start"]
      self.report(
        result="OK" if start == pair else "FAIL",
        gid=half,
        side="pair",
        tool="kernel",
        check="Interposed program",
        notes=f"starts at {start['src'][:12]}, {start['tgt'][:12]}"
        + ("" if start == pair else f"; not {pair['src'][:12]}, {pair['tgt'][:12]}"),
      )
    for half, _ in halves:
      self.goal(half)

  def case(self, gid: str, goal: dict, discharge: dict) -> None:
    """A goal holds when it holds in both of the cases it was split into.

    A split on whether a parameter is poison makes it noundef in one case and
    puts poison in its place in the other, and a scalar argument is one or
    the other. A split on a comparison of parameters assumes it at the start of
    both programs in one case and its inverse in the other, which cover every
    input on which it is true or false; each parameter it compares has to be
    noundef in the src, where a poison argument is undefined behavior already,
    so no input the src defines lies in neither. Both cases are rebuilt here
    from the goal's end pair and what it was split on, and each is a goal of its
    own with no role and no loop, as an interposed goal's halves.
    """
    on = discharge.get("on")
    src = self.package.program(goal["end"]["src"])
    name = entry(self.package, src)
    if isinstance(on, dict) and set(on) == {"defined"}:
      makes = self.poison_cases(gid, name, on)
    else:
      makes = self.comparison_cases(gid, src, name, on)
    for child, (subcommand, request, said) in zip(
      (discharge["holds"], discharge["fails"]), makes, strict=True
    ):
      start = self.package.goal(child)["start"]
      for side in ("src", "tgt"):
        started = time.monotonic()
        module = self.package.program(goal["end"][side])
        made = self.package.run_llops(subcommand, {"module": module, **request})
        same = self.package.run_llops("canon", {"module": made["module"]})["module"]
        matches = same == self.package.program(start[side])
        self.compared(
          child, side, "llops", "Case reconstruction", said, matches, elapsed_ms(started)
        )
    self.goal(discharge["holds"])
    self.goal(discharge["fails"])

  def poison_cases(self, gid: str, name: str, on: dict) -> list:
    """The two cases of a split on whether a parameter is poison, as llops makes them."""
    named = on["defined"]
    if not isinstance(named, str) or not re.fullmatch(r"!(?:0|[1-9]\d*)", named):
      raise Refused(
        f"{gid} is split by cases on whether {named!r} is poison, which is no parameter"
      )
    # `llops poison` refuses a parameter that may be poison in part, which
    # neither case would cover.
    self.report(
      result="OK",
      gid=gid,
      side="pair",
      tool="kernel",
      check="Case coverage",
      notes=f"{named} is poison or not",
    )
    param = int(named[1:])
    return [
      ("attrs", {"fn": name, "param": param, "attrs": {"noundef": True}}, f"{named} noundef"),
      ("poison", {"param": param}, f"{named} poison"),
    ]

  def comparison_cases(self, gid: str, src: str, name: str, on) -> list:
    """The two cases of a split on a comparison of parameters, as llops makes them."""
    operands = [on.get("lhs"), on.get("rhs")] if isinstance(on, dict) else []
    named = [x for x in operands if isinstance(x, str) and re.fullmatch(r"!(?:0|[1-9]\d*)", x)]
    numbers = [x for x in operands if isinstance(x, int) and not isinstance(x, bool)]
    shaped = isinstance(on, dict) and on.get("op") in INVERSE
    if not shaped or not named or len(named) + len(numbers) != 2:
      raise Refused(f"{gid} is split by cases on no comparison of its parameters")
    params = function(self.package, src, name)["params"]
    for x in named:
      param = params[int(x[1:])] if int(x[1:]) < len(params) else None
      defined = param is not None and param.get("attrs", {}).get("noundef") is True
      self.report(
        result="OK" if defined else "FAIL",
        gid=gid,
        side="src",
        tool="llops",
        check="Case coverage",
        notes=f"{x} is noundef" if defined else f"{x} may be poison, which lies in no case",
      )
    start = {"at": "start", "fn": name}
    inverse = {**on, "op": INVERSE[on["op"]]}
    return [
      ("assume", {"anchor": start, "assertions": [c]}, f"{c['lhs']} {c['op']} {c['rhs']} assumed")
      for c in (on, inverse)
    ]

  def cut(self, gid: str, goal: dict, discharge: dict) -> None:
    """A cut holds when it inlines, or reattaches, back to the pair it was made on."""
    outer = self.package.goal(discharge["outer"])
    inner = self.package.goal(discharge["inner"])
    name = discharge["callee"]
    # A parameter that never changes is a phi or a value from outside, and
    # only detach knew which.
    detach = discharge.get("detach")
    if detach is not None and not (
      isinstance(detach, dict) and isinstance(detach.get("phis"), dict)
    ):
      raise Refused(f"{gid} detached a block without naming the parameters that were its phis")
    hypothesis = detach.get("hypothesis") if detach else None
    rebuild = "reattach" if detach else "inline"
    slots = discharge.get("slots")
    # A cut of the src alone keeps the tgt as it is: the outer's tgt is the
    # goal's, which never calls the callee, and the outer holds for every
    # callee, so for the src's.
    src_alone = discharge.get("src_alone") is True
    cut_sides = ("src",) if src_alone else ("src", "tgt")

    for side in cut_sides:
      started = time.monotonic()
      request = {
        "outer": self.package.program(outer["start"][side]),
        "callee": self.package.program(inner["start"][side]),
        "callee_name": name,
      }
      if hypothesis:
        request["hypothesis"] = hypothesis
      if detach:
        request["phis"] = detach["phis"].get(side)
      if slots:
        request["slots"] = slots[side]
      back = self.package.run_llops(rebuild, request)["module"]
      same = self.package.run_llops("canon", {"module": back})["module"]
      whole = self.package.program(goal["end"][side])
      matches = same == whole
      ms = elapsed_ms(started)
      self.compared(
        gid,
        side,
        "llops",
        "Cut reconstruction",
        f"{rebuild} {discharge['outer']} + {discharge['inner']} at parent end",
        matches,
        ms,
      )
      self.outlined(gid, side, whole)
    if src_alone:
      same = outer["start"]["tgt"] == goal["end"]["tgt"]
      notes = f"{discharge['outer']} starts from the parent's tgt"
      self.compared(gid, "tgt", "kernel", "Cut reconstruction", notes, same, 0)
      steps = [step for half in (outer, inner) for step in half["steps"]]
      if any(step.get("kind") == "strengthen" for step in steps):
        self.fail(gid, "pair", "Cut of the src alone", "takes no strengthening")
      # alive2 takes two calls of one name for calls of one function, so a tgt
      # that called a function of the callee's name would pair with the src.
      tgt = self.package.program(goal["end"]["tgt"])
      if name in self.package.run_llops("validate", {"module": tgt}).get("functions", {}):
        self.fail(gid, "tgt", "Cut of the src alone", f"the tgt names @{name} too")

    # The outer was checked against a declaration; the callee proves a
    # definition. An attribute on one and not the other is a claim nobody
    # made, so the two have to say the same thing.
    for side in cut_sides:
      started = time.monotonic()
      declared = signature(self.package, self.package.program(outer["end"][side]), name)
      defined = signature(self.package, self.package.program(inner["end"][side]), name)
      matches = declared == defined
      ms = elapsed_ms(started)
      self.report(
        result="OK" if matches else "FAIL",
        gid=gid,
        side=side,
        tool="llops",
        check="Callee signature",
        notes=(
          f"@{name}: {discharge['outer']} declaration = {discharge['inner']} definition"
          if matches
          else (
            f"@{name}: declaration differs from definition"
            f"\ndeclaration ({discharge['outer']}): {declared}"
            f"\ndefinition ({discharge['inner']}): {defined}"
          )
        ),
        ms=ms,
      )

    # Where a strengthen interposed the callee goal, its src ends at the program between.
    between = self.between(discharge["inner"]) if hypothesis else None
    # The hypothesis stands for the callee within its own body, so it says
    # what the definition says, no more.
    if hypothesis:
      for side in ("src", "tgt"):
        started = time.monotonic()
        end = self.package.program(between if between and side == "src" else inner["end"][side])
        matches = signature(self.package, end, hypothesis) == signature(self.package, end, name)
        self.report(
          result="OK" if matches else "FAIL",
          gid=discharge["inner"],
          side=side,
          tool="llops",
          check="Hypothesis signature",
          notes=f"@{hypothesis} declared as @{name} is defined",
          ms=elapsed_ms(started),
        )

    # A cut adds no facts: each attribute on the callee arrives by a step,
    # and each entry predicate by an assume proved before each call.
    starts = [(discharge["outer"], name), (discharge["inner"], name)]
    if hypothesis:
      starts.append((discharge["inner"], hypothesis))
    for half, fn in starts:
      for side in ("src", "tgt"):
        if src_alone and half == discharge["outer"] and side == "tgt":
          continue
        started = time.monotonic()
        start = self.package.program(self.package.goal(half)["start"][side])
        self.report(
          result="OK" if bare(self.package, start, fn) else "FAIL",
          gid=half,
          side=side,
          tool="llops",
          check="Bare callee",
          notes=f"@{fn} at the start of {half}",
          ms=elapsed_ms(started),
        )
    for step in self.package.goal(discharge["inner"])["steps"]:
      if step.get("kind") != "strengthen":
        continue
      if step.get("predicates"):
        self.predicates(discharge, step, hypothesis, between)
      # Induction cannot prove willreturn, so a recursive callee takes no
      # function attribute at all.
      if hypothesis and step.get("fn_attrs"):
        self.fail(discharge["inner"], "pair", "Recursive callee", "takes no function attributes")

    # The outer's declaration takes return facts only as one of the callee's
    # own strengthenings showed its src keeps them.
    proved = [step.get("ret_attrs") for step in inner["steps"] if step.get("kind") == "strengthen"]
    for step in outer["steps"]:
      if step.get("kind") == "strengthen":
        facts = step.get("ret_attrs")
        shown = bool(facts) and facts in proved
        inner_id = discharge["inner"]
        who = inner_id if shown else f"no strengthening of {inner_id}"
        self.report(
          result="OK" if shown else "FAIL",
          gid=discharge["outer"],
          side="pair",
          tool="kernel",
          check="Return facts",
          notes=f"@{name} returns {', '.join(facts or {})}, which {who} showed",
        )

    # The outer half keeps the entry the cut was made in; the callee's
    # parameters are values computed before it, so it is asked about them
    # under no assumption at all.
    self.goal(
      discharge["outer"],
      "outer",
      {"hypothesis": hypothesis, "callee": inner["start"]} if hypothesis else None,
      name,
    )
    self.goal(discharge["inner"], name, {"hypothesis": hypothesis} if hypothesis else None)


class Refutation:
  """Re-ask alive-tv about the pair, at its input if any; llubi decides where it does not."""

  def __init__(self, package: Package, verbose: bool):
    self.package = package
    self.verbose = verbose

  def confirm(self) -> tuple[bool, str]:
    pair = self.package.counterexample_pair()
    args = self.package.counterexample_input()
    unroll = self.package.counterexample_unroll()
    by_llubi = self.package.source() == "llubi"
    if by_llubi and args is None:
      raise Refused("a counterexample llubi refuted names no input")
    started = time.monotonic()
    src, tgt = self.package.program(pair["src"]), self.package.program(pair["tgt"])
    if args is not None:
      at = self.package.run_llops("instantiate", {"src": src, "tgt": tgt, "args": args})
      src, tgt = at["src"], at["tgt"]
    # alive-tv is asked about a loop only with an unroll factor, and then its
    # answer covers only the iterations it unrolled.
    looping = by_llubi and (self.package.loops(src) or self.package.loops(tgt))
    answer = "not asked" if looping and not unroll else self.package.ask(src, tgt, unroll)
    decided = answer == "incorrect" or answer == "correct" and not looping
    report_row(
      result="OK" if answer == "incorrect" else "FAIL" if decided or not by_llubi else "--",
      gid=self.package.root_goal(),
      side="pair",
      tool="alive-tv",
      check="Root refutation",
      notes=answer,
      ms=elapsed_ms(started),
    )
    if answer == "incorrect":
      return True, ""
    if not by_llubi:
      return False, "the pair was not refuted again"
    if decided:
      return False, "alive-tv finds no divergence at the input"
    return Replay(self.package, self.verbose).confirm(pair, args)


# --- the counterexample ------------------------------------------------------


def entry(package: Package, module: str) -> str:
  """The one function a program defines, which is what a harness wraps."""
  functions = package.run_llops("validate", {"module": module}).get("functions", {})
  defined = [name for name, fn in functions.items() if fn.get("defined")]
  if len(defined) != 1:
    raise Refused("a program of the pair does not define exactly one function")
  return defined[0]


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

  A src with UB on this input allows every target, so it settles nothing, and
  a src observation that is poison allows any value there. A tgt with UB
  where the src returned is a refutation, and so is any other observation the
  two disagree on, poison in the tgt included.
  """
  for side, run in (("src", src), ("tgt", tgt)):
    if run["outcome"] == "error":
      return False, f"the {side} did not run: {run['reason']}"
  if src["outcome"] == "ub":
    return False, f"the src has UB on this input ({src['reason']}), so every target refines it"
  if tgt["outcome"] == "ub":
    return True, f"the tgt has UB where the src returns: {tgt['reason']}"
  if sorted(src["observations"]) != sorted(tgt["observations"]):
    return False, "the two runs do not observe the same things"
  for name, value in src["observations"].items():
    if value != tgt["observations"][name] and "poison" not in value:
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

  def say(self, entry: str, module: str, runs: dict, confirmed: bool, args: list) -> None:
    """What was run and what each side did, as alive2 reports the same thing."""
    if confirmed:
      print()
      print(f"ERROR: {self.error(runs)}")
    print()
    print("Example:")
    # Not strict: llops harness takes one argument per parameter and has
    # already refused an input of the wrong length, and a report is no
    # place to raise.
    for param, argument in zip(declared(self.package, module, entry), args, strict=False):
      print(f"{param} = {given(argument)}")
    for side, name in (("src", "Source"), ("tgt", "Target")):
      print()
      print(f"{name}:")
      run = runs[side]
      if run["outcome"] == "ub":
        print(f"  UB triggered: {run['reason']}")
      for observed, value in run["observations"].items():
        print(f"  {observed} = {value}")
    print()

  def error(self, runs: dict) -> str:
    """What went wrong, in the words alive2 reports the same thing in."""
    if runs["tgt"]["outcome"] == "ub":
      return "Source is more defined than target"
    for name, value in runs["src"]["observations"].items():
      theirs = runs["tgt"]["observations"][name]
      if theirs != value and "poison" not in value:
        return "Target is more poisonous than source" if "poison" in theirs else "Value mismatch"
    return "Value mismatch"

  def confirm(self, pair: dict, args: list) -> tuple[bool, str]:
    programs = {side: self.package.program(pair[side]) for side in ("src", "tgt")}
    entries = {side: entry(self.package, text) for side, text in programs.items()}
    if entries["src"] != entries["tgt"]:
      raise Refused(
        f"the pair defines @{entries['src']} on one side and @{entries['tgt']} on the other"
      )

    harnesses = {
      side: self.package.run_llops(
        "harness", {"module": text, "entry": entries[side], "args": args}
      )
      for side, text in programs.items()
    }
    # llubi's run stands for the src only where llubi treats it as alive2 does.
    different = harnesses["src"].get("differences") or []
    if different:
      return False, f"llubi treats the src's {', '.join(different)} differently from alive2"
    runs = {side: read_run(self.package.interpret(h["module"])) for side, h in harnesses.items()}

    confirmed, reason = divergence(runs["src"], runs["tgt"])
    self.say(entries["src"], programs["src"], runs, confirmed, args)
    print(reason)
    return confirmed, reason


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
      if args.verbose:
        print()
        report_header()
      confirmed, why = Refutation(package, args.verbose).confirm()
      print()
    else:
      check = Check(package, args.verbose)
      if args.verbose:
        print()
        report_header()
      check.goal(package.root_goal())
      print()
      confirmed = not check.failures
  except (Refused, OSError) as error:
    print(f"refused: {error}", file=sys.stderr)
    return 1

  if package.verdict == "counterexample":
    runs = package.queries - package.solver_queries
    ran = f" and {runs} runs" if runs else ""
    print(f"{package.solver_queries} solver queries{ran} in {package.seconds:.1f}s")
    print("counterexample" if confirmed else f"NOT a counterexample: {why}")
    return 0 if confirmed else 1

  # Only proofs reach this summary, and replay already validated their root.
  root = package.root_goal()
  solver_noun = "query" if package.solver_queries == 1 else "queries"
  timing = f"{package.solver_queries} solver {solver_noun} · {package.seconds:.1f}s solver time"
  if package.rewrite_runs:
    rewrite_noun = "run" if package.rewrite_runs == 1 else "runs"
    timing += (
      f" · {package.rewrite_runs} rewriter {rewrite_noun}"
      f" · {package.rewrite_seconds:.1f}s rewriter time"
    )

  if confirmed:
    print(f"VERIFIED - root {root}")
    held_noun = "obligation" if check.held == 1 else "obligations"
    print(f"{check.held} {held_noun} passed · {timing}")
    return 0

  failed_noun = "obligation" if check.failed == 1 else "obligations"
  failed = f"{check.failed} {failed_noun} failed"
  if check.unresolved:
    failed += f" · {check.unresolved} not established"
  print(f"NOT verified - root {root}")
  print(f"{failed} · {timing}")
  return 1


if __name__ == "__main__":
  sys.exit(main())
