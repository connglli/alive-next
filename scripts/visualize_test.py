#!/usr/bin/env python3
"""Tests for visualize.py.

    python3 scripts/visualize_test.py

Sessions are built here rather than recorded, so the fold is tested on the
effects it is meant to understand and on the ones that should stop it.
"""

import hashlib
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import visualize  # noqa: E402

SRC = "define i32 @f(i32 %0) {\nentry:\n  %1 = mul i32 %0, 2\n  ret i32 %1\n}\n"
TGT = "define i32 @f(i32 %0) {\nentry:\n  %1 = shl i32 %0, 1\n  ret i32 %1\n}\n"


def digest(text: str) -> str:
  return hashlib.sha256(text.encode()).hexdigest()


class Session:
  """A session directory, written the way the framework writes one."""

  def __init__(self, root: Path):
    self.dir = root
    (self.dir / "store").mkdir(parents=True)
    self.lines: list[str] = []
    self.prev = ""

  def program(self, text: str) -> str:
    name = digest(text)
    (self.dir / "store" / f"{name}.ll").write_text(text)
    return name

  def append(self, event: dict) -> None:
    line = json.dumps({**event, "time": 0, "prev": self.prev})
    self.lines.append(line)
    self.prev = digest(line)

  def result(self, tool: str, *effects: dict) -> None:
    self.append({"kind": "tool_call", "id": "t", "tool": tool, "args": {}})
    self.append({"kind": "tool_result", "id": "t", "tool": tool, "effects": list(effects), "ms": 1})

  def write(self) -> Path:
    (self.dir / "trajectory.jsonl").write_text("".join(line + "\n" for line in self.lines))
    return self.dir


class Case(unittest.TestCase):
  def setUp(self) -> None:
    self.root = Path(tempfile.mkdtemp())
    self.session = Session(self.root / "run")
    self.src = self.session.program(SRC)
    self.tgt = self.session.program(TGT)
    self.session.append(
      {"kind": "run_start", "src": self.src, "tgt": self.tgt, "config": {}, "versions": {}}
    )

  def tearDown(self) -> None:
    shutil.rmtree(self.root, ignore_errors=True)

  def data(self) -> dict:
    page = visualize.render(self.session.write())
    found = re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S)
    assert found is not None, "the page carries its data"
    return json.loads(found.group(1))


class TestFold(Case):
  def test_a_proved_root_is_verified(self):
    self.session.result("check", {"effect": "proved", "gid": "g1"})
    self.session.append({"kind": "verdict", "outcome": "verified"})
    data = self.data()
    self.assertEqual(data["verdict"], "verified")
    self.assertEqual(
      data["snapshots"][-1],
      {"g1": {"status": "proved", "node": "n0", "role": None, "parent": None}},
    )

  def test_a_split_is_proved_through_its_children(self):
    self.session.result(
      "split",
      {
        "effect": "split",
        "gid": "g1",
        "name": "outlined_g3",
        "outer": {"gid": "g2", "src": self.src, "tgt": self.tgt},
        "callee": {"gid": "g3", "src": self.src, "tgt": self.tgt},
      },
    )
    self.session.result("check", {"effect": "proved", "gid": "g2"})
    # One child is not enough, and the tree says so at that moment.
    self.assertEqual(self.data()["snapshots"][-1]["g1"]["status"], "split")

    self.session.result("check", {"effect": "proved", "gid": "g3"})
    self.session.append({"kind": "verdict", "outcome": "verified"})
    data = self.data()
    self.assertEqual(data["verdict"], "verified")
    self.assertEqual(data["snapshots"][-1]["g1"]["status"], "proved")

    # Both halves hang off the pair the cut was made on, and a cut moves
    # neither side of anything: it makes two goals.
    nodes = {node["id"]: node for node in data["nodes"]}
    outer, callee = data["nodes"][1], data["nodes"][2]
    self.assertEqual((outer["gid"], outer["parent"], outer["side"]), ("g2", "n0", None))
    self.assertEqual(
      (callee["gid"], callee["parent"], callee["tool"]), ("g3", "n0", "split callee")
    )
    self.assertEqual(nodes["n0"]["gid"], "g1")

  def test_a_step_reopens_a_proved_goal(self):
    other = self.session.program(SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
    self.session.result("check", {"effect": "proved", "gid": "g1"})
    self.session.result(
      "commit", {"effect": "step", "gid": "g1", "side": "src", "to": other, "how": "checked"}
    )
    data = self.data()
    self.assertEqual(data["verdict"], "unknown")
    self.assertEqual(data["snapshots"][-1]["g1"]["status"], "open")

    # The step is an edge from the pair it started at to the pair it made.
    self.assertEqual(len(data["nodes"]), 2)
    self.assertEqual(data["nodes"][1]["parent"], "n0")
    self.assertEqual((data["nodes"][1]["tool"], data["nodes"][1]["side"]), ("commit", "src"))
    self.assertEqual(data["snapshots"][-1]["g1"]["node"], "n1")

  def test_every_event_points_at_a_pair(self):
    # Moving along the timeline has to move what the page shows, so an
    # event names the pair its move produced, or the pair of the goal it
    # is about when it produces none.
    other = self.session.program(SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
    self.session.result("check", {"effect": "proved", "gid": "g1"})
    self.session.result(
      "commit", {"effect": "step", "gid": "g1", "side": "src", "to": other, "how": "checked"}
    )
    events = self.data()["events"]
    self.assertEqual(events[1]["label"], "check() -> proved g1")
    self.assertEqual(events[1]["focus"], "n0")
    self.assertEqual(events[2]["focus"], "n1")
    self.assertTrue(all(event["focus"] for event in events))

  def test_a_step_is_a_version_of_its_goal_with_a_diff(self):
    other = self.session.program(SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
    self.session.result(
      "commit",
      {"effect": "step", "gid": "g1", "side": "src", "to": other, "how": "checked"},
    )
    data = self.data()
    # Programs are named in the order they appeared, as goal_show names them.
    self.assertEqual(data["pnames"], {self.src: "p1", self.tgt: "p2", other: "p3"})
    # The step is a second version of the same goal, not a branch.
    self.assertEqual(data["nodes"][1]["parent"], "n0")
    self.assertEqual(data["snapshots"][-1]["g1"]["parent"], None)
    # The pair panel reads the change, not two dumps: the moved side diffs.
    diff = data["diffs"]["n1"]
    self.assertTrue(diff["src"]["changed"])
    self.assertIn("-  %1 = mul i32 %0, 2", diff["src"]["lines"])
    self.assertIn("+  %1 = add i32 %0, %0", diff["src"]["lines"])
    self.assertFalse(diff["tgt"]["changed"])

  def test_a_rewrite_names_its_rule_and_a_strengthen_its_attributes(self):
    other = self.session.program(SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
    self.session.result(
      "rewrite",
      {
        "effect": "step",
        "gid": "g1",
        "side": "src",
        "to": other,
        "how": "rule",
        "rules": ["muli-pow2-to-shl"],
      },
    )
    strengthened_src = self.session.program(SRC.replace("@f(", "@f noundef "))
    strengthened_tgt = self.session.program(TGT.replace("@f(", "@f noundef "))
    self.session.result(
      "strengthen",
      {
        "effect": "strengthen",
        "gid": "g1",
        "src": strengthened_src,
        "tgt": strengthened_tgt,
        "param_attrs": {"0": {"noundef": True}},
      },
    )
    data = self.data()
    nodes = {node["id"]: node for node in data["nodes"]}
    self.assertEqual(nodes["n1"]["note"], "muli-pow2-to-shl")
    self.assertEqual(nodes["n2"]["note"], "+noundef %0")

  def test_a_split_birth_has_no_before_to_diff_against(self):
    self.session.result(
      "split",
      {
        "effect": "split",
        "gid": "g1",
        "name": "outlined_g3",
        "outer": {"gid": "g2", "src": self.src, "tgt": self.tgt},
        "callee": {"gid": "g3", "src": self.src, "tgt": self.tgt},
      },
    )
    data = self.data()
    self.assertEqual(data["snapshots"][-1]["g2"]["parent"], "g1")
    for nid in ("n1", "n2"):
      for side in ("src", "tgt"):
        self.assertTrue(data["diffs"][nid][side]["birth"])

  def test_an_impossible_effect_stops_the_fold_and_is_reported(self):
    self.session.result("check", {"effect": "proved", "gid": "g9"})
    data = self.data()
    self.assertIn("no goal g9", data["error"])
    # Everything up to the breakage is still there to look at.
    self.assertEqual(len(data["events"]), len(data["snapshots"]))


class TestPage(Case):
  def setUp(self) -> None:
    super().setUp()
    self.session.result("check", {"effect": "proved", "gid": "g1"})
    self.session.append({"kind": "verdict", "outcome": "verified"})

  def test_no_string_in_the_script_runs_off_its_line(self):
    # The script is a Python string, so a newline meant for JavaScript has
    # to arrive escaped. When it does not, the page carries a string
    # literal split across two lines and nothing on it runs.
    page = visualize.render(self.session.write())
    script = re.search(r"<script>(.*?)</script>", page, re.S).group(1)
    for number, line in enumerate(script.splitlines(), start=1):
      quotes = len(re.findall(r'(?<!\\)"', line))
      self.assertEqual(quotes % 2, 0, f"line {number} of the script: {line}")

  def test_outside_loads_are_only_the_pinned_highlighter(self):
    # Highlighting comes from a pinned CDN; everything else stays embedded,
    # and the page reads plain when the library fails to load.
    page = visualize.render(self.session.write())
    refs = re.findall(r'(?:src|href)="(?!#)([^"]*)"', page)
    self.assertTrue(refs)
    for ref in refs:
      self.assertTrue(
        ref.startswith("https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/"),
        ref,
      )

  def test_both_programs_of_a_pair_are_there(self):
    programs = self.data()["programs"]
    self.assertEqual(programs[self.src], SRC)
    self.assertEqual(programs[self.tgt], TGT)

  def test_a_call_and_its_result_are_one_move(self):
    events = self.data()["events"]
    self.assertEqual([event["kind"] for event in events], ["run_start", "check", "verdict"])
    call, result = events[1]["entries"]
    self.assertEqual((call["kind"], result["kind"]), ("tool_call", "tool_result"))
    self.assertEqual(events[1]["label"], "check() -> proved g1")
    # The duration is the result's, and a filter switch is per tool.
    self.assertEqual(events[1]["ms"], 1)

  def test_a_call_with_no_result_still_has_a_line(self):
    self.session.append({"kind": "tool_call", "id": "t", "tool": "check", "args": {}})
    self.assertEqual(self.data()["events"][-1]["label"], "check() ...")

  def test_a_move_with_no_duration_carries_none(self):
    events = self.data()["events"]
    self.assertEqual(events[0]["label"], "run_start")
    self.assertNotIn("ms", events[0])

  def test_every_event_has_a_line_for_the_timeline(self):
    data = self.data()
    self.assertEqual(data["events"][0]["label"], "run_start")
    self.assertEqual(data["events"][-1]["label"], "verdict verified")
    self.assertTrue(all(event["label"] for event in data["events"]))


class TestRefusals(Case):
  def test_a_verdict_the_replay_does_not_reach(self):
    # The fold here is the one in goals.ts written twice, so the verdict is
    # where the two are made to agree.
    self.session.append({"kind": "verdict", "outcome": "verified"})
    with self.assertRaisesRegex(visualize.Broken, "records verified"):
      visualize.render(self.session.write())

  def test_a_broken_chain_names_its_line(self):
    self.session.result("check", {"effect": "proved", "gid": "g1"})
    session = self.session.write()
    path = session / "trajectory.jsonl"
    lines = path.read_text().splitlines()
    lines[1] = lines[1].replace("check", "bentx")
    path.write_text("".join(line + "\n" for line in lines))
    with self.assertRaisesRegex(visualize.Broken, "line 3"):
      visualize.render(session)

  def test_a_session_with_no_trajectory(self):
    (self.root / "empty").mkdir()
    with self.assertRaises(OSError):
      visualize.render(self.root / "empty")


if __name__ == "__main__":
  unittest.main(verbosity=2)
