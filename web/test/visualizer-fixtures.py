"""Capture the native visualizer's regression sessions as a browser adapter oracle."""

import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import visualize  # noqa: E402
import visualize_test  # noqa: E402

render = visualize.render
fixtures = []


def capture(session):
  page = render(session)
  expected = json.loads(
    re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S)[1]
  )
  programs = {path.stem: path.read_text() for path in (session / "store").glob("*.ll")}
  if expected["error"] is None and all(key in programs for key in expected["programs"]):
    fixtures.append(
      {
        "source": {
          "trajectory": (session / "trajectory.jsonl").read_text().splitlines(keepends=True),
          "programs": programs,
        },
        "expected": expected,
      }
    )
  return page


visualize.render = capture
output = io.StringIO()
result = unittest.TextTestRunner(stream=output).run(
  unittest.defaultTestLoader.loadTestsFromModule(visualize_test)
)
if not result.wasSuccessful():
  raise RuntimeError(output.getvalue())

# Exercise Unicode labels and difflib's repeated-line heuristic beyond the small fixtures.
with tempfile.TemporaryDirectory() as directory:
  session = visualize_test.Session(Path(directory) / "long-diff")
  source = visualize_test.SRC.replace("entry:\n", "entry:\n" + "  ; repeated\n" * 220)
  src = session.program(source)
  tgt = session.program(visualize_test.TGT)
  changed = session.program(source.replace("mul i32 %0, 2", "add i32 %0, %0"))
  session.append({"kind": "start", "src": src, "tgt": tgt, "config": {}, "versions": {}})
  session.append(
    {
      "kind": "tool_call",
      "id": "unicode",
      "tool": "commit",
      "args": {"gid": "g1", "label": "λ雪😀\x7f"},
    }
  )
  session.append(
    {
      "kind": "tool_result",
      "id": "unicode",
      "tool": "commit",
      "ms": 1,
      "effects": [
        {
          "effect": "step",
          "gid": "g1",
          "side": "src",
          "to": changed,
          "how": "check",
          "by": "alive2",
        }
      ],
    }
  )
  session.result("check", {"effect": "proved", "gid": "g1"})
  session.append({"kind": "verdict", "outcome": "verified"})
  capture(session.write())

with tempfile.TemporaryDirectory() as directory:
  session = visualize_test.Session(Path(directory) / "backtracking")
  src = session.program(visualize_test.SRC)
  tgt = session.program(visualize_test.TGT)
  mid = session.program(visualize_test.SRC.replace("mul i32 %0, 2", "add i32 %0, %0"))
  session.append({"kind": "start", "src": src, "tgt": tgt, "config": {}, "versions": {}})
  session.result(
    "cut",
    {
      "effect": "cut",
      "gid": "g1",
      "name": "outlined_g3",
      "outer": {"gid": "g2", "src": src, "tgt": tgt},
      "callee": {"gid": "g3", "src": src, "tgt": tgt},
    },
  )
  session.result("refute", {"effect": "refuted", "gid": "g3"})
  session.result("uncut", {"effect": "uncut", "gid": "g1"})
  session.result(
    "interpose",
    {
      "effect": "interpose",
      "gid": "g1",
      "lhs": {"gid": "g4", "src": src, "tgt": mid},
      "rhs": {"gid": "g5", "src": mid, "tgt": tgt},
    },
  )
  session.result("uninterpose", {"effect": "uninterpose", "gid": "g1"})
  session.result(
    "case",
    {
      "effect": "case",
      "gid": "g1",
      "on": {"defined": "!0"},
      "holds": {"gid": "g6", "src": src, "tgt": tgt},
      "fails": {"gid": "g7", "src": src, "tgt": tgt},
    },
  )
  session.result("uncase", {"effect": "uncase", "gid": "g1"})
  session.result(
    "commit", {"effect": "step", "gid": "g1", "side": "src", "to": mid, "how": "check"}
  )
  session.result("revert", {"effect": "revert", "gid": "g1", "side": "src", "to": src})
  session.append({"kind": "verdict", "outcome": "unknown"})
  capture(session.write())
print(json.dumps(fixtures))
