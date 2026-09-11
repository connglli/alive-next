#!/usr/bin/env python3
"""Render a session directory as one self-contained HTML page.

    python3 scripts/visualize.py sessions/<id> [-o page.html]

The page needs no server: the trajectory, the programs it
refers to and a goal tree per event are embedded in it. Syntax
highlighting loads Highlight.js and its theme from a pinned CDN;
the page reads plain when those assets are unavailable.

The fold below is the same one engine/core/state/goals.ts applies, so the two can
drift. What keeps them honest is the verdict: a session that ends in one is
checked against the verdict this fold arrives at, and a mismatch is reported
rather than rendered.
"""

import argparse
import hashlib
import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from visualize_ui import CSS, JS, PAGE

# --- the trajectory ----------------------------------------------------------


class Broken(Exception):
  """The log does not hold together, naming the line where that shows."""


def read_trajectory(path: Path) -> list[dict]:
  """Every entry in order, with the hash chain checked as it goes."""
  entries = []
  expected = ""
  for number, line in enumerate(path.read_text().splitlines(), start=1):
    if not line:
      continue
    try:
      entry = json.loads(line)
    except json.JSONDecodeError as error:
      raise Broken(f"line {number}: not JSON, {error}") from error
    if entry.get("prev", "") != expected:
      raise Broken(f"line {number}: follows {entry.get('prev') or 'nothing'}, not {expected}")
    entries.append(entry)
    expected = hashlib.sha256(line.encode()).hexdigest()
  return entries


# --- the goal tree -----------------------------------------------------------


class Tree:
  """The goals, as the effects so far describe them.

  A goal's pair changes as the run works on it, and every pair it holds is a
  node here, grouped by goal. That is what the page draws: the goal tree,
  where only a split branches, and each goal carries its own rewrite history
  as a version strip. A revert leaves the abandoned line beside the one that
  continued, as another version of the same goal.
  """

  def __init__(self, src: str, tgt: str, at: int):
    self.goals: dict[str, dict] = {}
    self.nodes: list[dict] = []
    self.pnames: dict[str, str] = {}
    self.name(src)
    self.name(tgt)
    self.open_goal("g1", None, None, None, src, tgt, at, "run_start", None, None)

  def open_goal(
    self,
    gid: str,
    parent: str | None,
    role: str | None,
    from_node: str | None,
    src: str,
    tgt: str,
    at: int,
    tool: str,
    side: str | None,
    note: str | None,
  ) -> None:
    self.name(src)
    self.name(tgt)
    self.goals[gid] = {
      "id": gid,
      "parent": parent,
      "role": role,
      "status": "open",
      "src": [src],
      "tgt": [tgt],
      "children": [],
      "node": self.node(gid, from_node, src, tgt, at, tool, side, note),
    }

  def node(
    self,
    gid: str,
    parent: str | None,
    src: str,
    tgt: str,
    at: int,
    tool: str,
    side: str | None,
    note: str | None,
  ) -> str:
    """A pair a goal now holds, the move that led to it, and which side it moved."""
    name = f"n{len(self.nodes)}"
    self.nodes.append(
      {
        "id": name,
        "gid": gid,
        "parent": parent,
        "src": src,
        "tgt": tgt,
        "at": at,
        "tool": tool,
        "side": side,
        "note": note,
      }
    )
    return name

  def moved(self, goal: dict, at: int, tool: str, side: str | None, note: str | None) -> None:
    """Record the pair a goal moved to, as a version after the one it left."""
    goal["node"] = self.node(
      goal["id"], goal["node"], goal["src"][-1], goal["tgt"][-1], at, tool, side, note
    )

  def name(self, digest: str) -> str:
    """The short name of a program, in the order programs first appeared."""
    found = self.pnames.get(digest)
    if found is None:
      found = f"p{len(self.pnames) + 1}"
      self.pnames[digest] = found
    return found

  def get(self, gid: str) -> dict:
    goal = self.goals.get(gid)
    if goal is None:
      raise Broken(f"no goal {gid}")
    return goal

  def editable(self, gid: str) -> dict:
    """A goal a move may touch; a proved one reopens, as goals.ts has it."""
    goal = self.get(gid)
    if goal["status"] == "proved":
      goal["status"] = "open"
      self.unsettle(goal["parent"])
    if goal["status"] != "open":
      raise Broken(f"{gid} is {goal['status']}, not open")
    return goal

  def settle(self, gid: str | None) -> None:
    while gid is not None:
      goal = self.get(gid)
      if goal["status"] != "split":
        return
      if not all(self.get(child)["status"] == "proved" for child in goal["children"]):
        return
      goal["status"] = "proved"
      gid = goal["parent"]

  def unsettle(self, gid: str | None) -> None:
    while gid is not None:
      goal = self.get(gid)
      if goal["status"] != "proved":
        return
      goal["status"] = "split" if goal["children"] else "open"
      gid = goal["parent"]

  def discard(self, gid: str) -> None:
    for child in self.get(gid)["children"]:
      self.discard(child)
    del self.goals[gid]

  def apply(self, effect: dict, at: int, tool: str) -> None:
    kind = effect["effect"]
    if kind == "step":
      goal = self.editable(effect["gid"])
      goal[effect["side"]].append(effect["to"])
      self.name(effect["to"])
      self.moved(goal, at, tool, effect["side"], step_note(effect))
    elif kind == "revert":
      goal = self.editable(effect["gid"])
      history = goal[effect["side"]]
      if effect["to"] not in history:
        raise Broken(f"{effect['gid']} never had {effect['to']}")
      goal[effect["side"]] = history[: len(history) - history[::-1].index(effect["to"])]
      self.moved(goal, at, "revert", effect["side"], None)
    elif kind == "strengthen":
      goal = self.editable(effect["gid"])
      goal["src"].append(effect["src"])
      goal["tgt"].append(effect["tgt"])
      self.name(effect["src"])
      self.name(effect["tgt"])
      self.moved(goal, at, "strengthen", "both", attrs_note(effect))
    elif kind == "split":
      parent = self.editable(effect["gid"])
      for role in ("outer", "callee"):
        child = effect[role]
        self.open_goal(
          child["gid"],
          parent["id"],
          role,
          parent["node"],
          child["src"],
          child["tgt"],
          at,
          f"split {role}",
          None,
          None,
        )
        parent["children"].append(child["gid"])
      parent["status"] = "split"
    elif kind == "unsplit":
      parent = self.get(effect["gid"])
      if parent["status"] != "split":
        raise Broken(f"{parent['id']} is not split")
      for child in parent["children"]:
        self.discard(child)
      parent["children"] = []
      parent["status"] = "open"
    elif kind == "proved":
      goal = self.get(effect["gid"])
      goal["status"] = "proved"
      self.settle(goal["parent"])
    elif kind == "refuted":
      self.get(effect["gid"])["status"] = "refuted"
    else:
      raise Broken(f"unknown effect {kind}")

  def snapshot(self) -> dict[str, dict]:
    """What the page draws: where each goal stands, keyed by its id."""
    return {
      goal["id"]: {
        "status": goal["status"],
        "node": goal["node"],
        "role": goal["role"],
        "parent": goal["parent"],
      }
      for goal in self.goals.values()
    }

  def verdict(self) -> str:
    root = self.goals.get("g1")
    if root is None:
      return "unknown"
    return {"proved": "verified", "refuted": "counterexample"}.get(root["status"], "unknown")


def step_note(effect: dict) -> str | None:
  """The rule behind a rewrite step, where the effect names one."""
  rules = effect.get("rules")
  if isinstance(rules, list) and rules and all(isinstance(rule, str) for rule in rules):
    return ",".join(rules)
  return None


def attrs_note(effect: dict) -> str | None:
  """The attributes a strengthen adds, grouped by attribute name."""
  attrs = effect.get("param_attrs")
  if not isinstance(attrs, dict):
    return None
  by_attr: dict[str, list[str]] = {}
  for param in sorted(attrs, key=str):
    names = attrs[param]
    if not isinstance(names, dict):
      continue
    for name in sorted(names):
      if names[name] is True:
        by_attr.setdefault(name, []).append(f"%{param}")
  if not by_attr:
    return None
  return " ".join(f"+{name} {' '.join(params)}" for name, params in sorted(by_attr.items()))


class Replay:
  """What the page is drawn from: the versions, and where each goal stands."""

  def __init__(
    self,
    snapshots: list[dict],
    nodes: list[dict],
    pnames: dict[str, str],
    focus: list[str | None],
    error: str | None,
    verdict: str,
  ):
    self.snapshots = snapshots
    self.nodes = nodes
    self.pnames = pnames
    self.focus = focus
    self.error = error
    self.verdict = verdict


def rows(entries: list[dict]) -> list[list[dict]]:
  """The events, with a tool call and its result kept together as one move."""
  grouped: list[list[dict]] = []
  index = 0
  while index < len(entries):
    entry = entries[index]
    following = entries[index + 1] if index + 1 < len(entries) else None
    if (
      entry["kind"] == "tool_call"
      and following is not None
      and following["kind"] == "tool_result"
      and following.get("id") == entry.get("id")
    ):
      grouped.append([entry, following])
      index += 2
    else:
      grouped.append([entry])
      index += 1
  return grouped


def mentioned(entry: dict) -> str | None:
  """The goal an event is about, when it says."""
  effects = entry.get("effects") or []
  if effects:
    return effects[-1].get("gid")
  args = entry.get("args")
  if isinstance(args, dict) and isinstance(args.get("gid"), str):
    return args["gid"]
  return None


def replay(grouped: list[list[dict]]) -> Replay:
  """Fold the log, keeping where every goal stood after each move.

  Each move also gets the pair it is about, so that stepping along the
  timeline moves what the page shows: the pair the move produced, or the
  pair the goal it names is holding when it produces none.
  """
  tree: Tree | None = None
  snapshots: list[dict] = []
  focus: list[str | None] = []
  error = None
  about: str | None = None
  for index, row in enumerate(grouped):
    before = len(tree.nodes) if tree else 0
    try:
      for entry in row:
        if entry["kind"] == "run_start":
          if tree is not None:
            raise Broken("a second run_start")
          tree = Tree(entry["src"], entry["tgt"], index)
        for effect in entry.get("effects", []):
          if tree is None:
            raise Broken(f"{effect['effect']} before run_start")
          tree.apply(effect, index, entry.get("tool", entry["kind"]))
    except Broken as broken:
      error = f"move {index}: {broken}"
      snapshots.append(snapshots[-1] if snapshots else {})
      focus.append(focus[-1] if focus else None)
      break
    here = tree.snapshot() if tree else {}
    snapshots.append(here)
    for entry in row:
      about = mentioned(entry) or about
    made = tree.nodes[before:] if tree else []
    if made:
      focus.append(made[-1]["id"])
    elif about in here:
      focus.append(here[about]["node"])
    else:
      focus.append(focus[-1] if focus else None)
  while len(snapshots) < len(grouped):
    snapshots.append(snapshots[-1] if snapshots else {})
    focus.append(focus[-1] if focus else None)
  return Replay(
    snapshots,
    tree.nodes if tree else [],
    tree.pnames if tree else {},
    focus,
    error,
    tree.verdict() if tree else "unknown",
  )


# --- what the page needs -----------------------------------------------------


def programs_for(store: Path, nodes: list[dict]) -> dict[str, str]:
  """The programs any goal ever held, read out of the store."""
  wanted = {node[side] for node in nodes for side in ("src", "tgt")}
  programs = {}
  for digest in sorted(wanted):
    path = store / f"{digest}.ll"
    programs[digest] = path.read_text() if path.exists() else f"; {digest} is not in the store\n"
  return programs


def diffs_for(nodes: list[dict], programs: dict[str, str]) -> dict[str, dict]:
  """The inline diff behind each rewrite: what each side was and became.

  A version born of a split has no before to diff against: its two halves
  are new functions, so the page shows them whole. Every other version diffs
  against the version of the same goal it follows, with three lines of
  context around each change.
  """
  import difflib

  by_id = {node["id"]: node for node in nodes}
  diffs = {}
  for node in nodes:
    parent = by_id.get(node["parent"] or "")
    entry = {}
    for side in ("src", "tgt"):
      if parent is None or parent["gid"] != node["gid"]:
        entry[side] = {"changed": True, "birth": True, "lines": [], "adds": 0, "dels": 0}
      elif parent[side] == node[side]:
        entry[side] = {"changed": False, "lines": [], "adds": 0, "dels": 0}
      else:
        before = programs.get(parent[side], "").splitlines()
        after = programs.get(node[side], "").splitlines()
        # Only the first two lines are file headers.
        raw = list(difflib.unified_diff(before, after, n=3, lineterm=""))
        lines = raw[2:] if raw else []
        entry[side] = {
          "changed": True,
          "lines": lines,
          "adds": sum(line.startswith("+") for line in lines),
          "dels": sum(line.startswith("-") for line in lines),
        }
    diffs[node["id"]] = entry
  return diffs


def label(row: list[dict]) -> str:
  """The one line the timeline shows for a move."""
  entry = row[0]
  kind = entry["kind"]
  if kind == "run_start":
    return "run_start"
  if kind == "verdict":
    return f"verdict {entry['outcome']}"
  if kind == "auto":
    return f"auto {entry.get('action', '')}"
  if kind != "tool_call":
    return kind
  call = f"{entry['tool']}({compact(entry.get('args'))})"
  if len(row) == 1:
    return f"{call} ..."
  effects = ", ".join(
    f"{effect['effect']} {effect.get('gid', '')}".strip() for effect in row[1].get("effects", [])
  )
  return f"{call} -> {effects or 'no change'}"


def kind_of(row: list[dict]) -> str:
  """What a filter switch turns off: a tool by name, anything else by kind."""
  return row[0]["tool"] if row[0]["kind"] == "tool_call" else row[0]["kind"]


def timed(row: list[dict]) -> dict:
  """The move's elapsed time, present only when the trajectory recorded one."""
  return {"ms": row[-1]["ms"]} if "ms" in row[-1] else {}


def compact(args: object, limit: int = 60) -> str:
  if args in (None, {}):
    return ""
  text = json.dumps(args, separators=(",", ":"))
  return text if len(text) <= limit else text[: limit - 1] + "…"


# --- the page ----------------------------------------------------------------


def render(session: Path) -> str:
  entries = read_trajectory(session / "trajectory.jsonl")
  if not entries:
    raise Broken("the trajectory is empty")
  grouped = rows(entries)
  run = replay(grouped)
  programs = programs_for(session / "store", run.nodes)

  recorded = next((e["outcome"] for e in entries if e["kind"] == "verdict"), None)
  if recorded is not None and recorded != run.verdict and run.error is None:
    raise Broken(f"the log records {recorded} and this replay arrives at {run.verdict}")

  data = {
    "verdict": recorded or run.verdict,
    "error": run.error,
    "events": [
      {
        "kind": kind_of(row),
        "label": label(row),
        **timed(row),
        "focus": run.focus[index],
        "entries": row,
      }
      for index, row in enumerate(grouped)
    ],
    "snapshots": run.snapshots,
    "nodes": run.nodes,
    "pnames": run.pnames,
    "diffs": diffs_for(run.nodes, programs),
    "programs": programs,
  }
  payload = json.dumps(data).replace("</", "<\\/")
  return (
    PAGE.replace("__TITLE__", html.escape(session.name))
    .replace("__CSS__", CSS)
    .replace("__JS__", JS)
    .replace("__DATA__", payload)
  )


def main() -> int:
  parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
  parser.add_argument("session", type=Path, help="a session directory")
  parser.add_argument("-o", "--output", type=Path, help="default: <session>/session.html")
  args = parser.parse_args()

  try:
    page = render(args.session)
  except (Broken, OSError) as error:
    print(f"visualize: {error}", file=sys.stderr)
    return 1

  out = args.output or args.session / "session.html"
  out.write_text(page)
  print(out)
  return 0


if __name__ == "__main__":
  sys.exit(main())
