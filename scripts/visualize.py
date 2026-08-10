#!/usr/bin/env python3
"""Render a session directory as one self-contained HTML page.

    python3 scripts/visualize.py sessions/<id> [-o page.html]

The page needs no server and no network: the trajectory, the programs it
refers to and a goal tree per event are embedded in it.

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
    node here, with an edge from the pair the move started at. That is the
    shape the page draws: the derivation, where a split branches and a revert
    leaves the abandoned line beside the one that continued.
    """

    def __init__(self, src: str, tgt: str, at: int):
        self.goals: dict[str, dict] = {}
        self.nodes: list[dict] = []
        self.open_goal("g1", None, None, None, src, tgt, at, "run_start", None)

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
    ) -> None:
        self.goals[gid] = {
            "id": gid,
            "parent": parent,
            "role": role,
            "status": "open",
            "src": [src],
            "tgt": [tgt],
            "children": [],
            "node": self.node(gid, from_node, src, tgt, at, tool, side),
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
            }
        )
        return name

    def moved(self, goal: dict, at: int, tool: str, side: str | None) -> None:
        """Record the pair a goal moved to, as a node under the one it left."""
        goal["node"] = self.node(
            goal["id"], goal["node"], goal["src"][-1], goal["tgt"][-1], at, tool, side
        )

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
            self.moved(goal, at, tool, effect["side"])
        elif kind == "revert":
            goal = self.editable(effect["gid"])
            history = goal[effect["side"]]
            if effect["to"] not in history:
                raise Broken(f"{effect['gid']} never had {effect['to']}")
            goal[effect["side"]] = history[: len(history) - history[::-1].index(effect["to"])]
            self.moved(goal, at, "revert", effect["side"])
        elif kind == "strengthen":
            goal = self.editable(effect["gid"])
            goal["src"].append(effect["src"])
            goal["tgt"].append(effect["tgt"])
            self.moved(goal, at, "strengthen", "both")
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
            goal["id"]: {"status": goal["status"], "node": goal["node"], "role": goal["role"]}
            for goal in self.goals.values()
        }

    def verdict(self) -> str:
        root = self.goals.get("g1")
        if root is None:
            return "unknown"
        return {"proved": "verified", "refuted": "counterexample"}.get(root["status"], "unknown")


class Replay:
    """What the page is drawn from: the nodes, and where each goal stands."""

    def __init__(
        self,
        snapshots: list[dict],
        nodes: list[dict],
        focus: list[str | None],
        error: str | None,
        verdict: str,
    ):
        self.snapshots = snapshots
        self.nodes = nodes
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
        snapshots, tree.nodes if tree else [], focus, error, tree.verdict() if tree else "unknown"
    )


# --- what the page needs -----------------------------------------------------


def programs_for(store: Path, nodes: list[dict]) -> dict[str, str]:
    """The programs any goal ever held, read out of the store."""
    wanted = {node[side] for node in nodes for side in ("src", "tgt")}
    programs = {}
    for digest in sorted(wanted):
        path = store / f"{digest}.ll"
        programs[digest] = (
            path.read_text() if path.exists() else f"; {digest} is not in the store\n"
        )
    return programs


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
        f"{effect['effect']} {effect.get('gid', '')}".strip()
        for effect in row[1].get("effects", [])
    )
    return f"{call} -> {effects or 'no change'}"


def kind_of(row: list[dict]) -> str:
    """What a filter switch turns off: a tool by name, anything else by kind."""
    return row[0]["tool"] if row[0]["kind"] == "tool_call" else row[0]["kind"]


def compact(args: object, limit: int = 60) -> str:
    if args in (None, {}):
        return ""
    text = json.dumps(args, separators=(",", ":"))
    return text if len(text) <= limit else text[: limit - 1] + "…"


# --- the page ----------------------------------------------------------------

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>__CSS__</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <p id="summary"></p>
</header>
<main>
  <aside>
    <div id="filters"></div>
    <input id="scrubber" type="range" min="0" value="0">
    <ol id="timeline"></ol>
  </aside>
  <section>
    <h2>derivation</h2>
    <p class="legend">
      <span class="chip proved">proved</span>
      <span class="chip open">open</span>
      <span class="chip split">split</span>
      <span class="chip refuted">refuted</span>
      <span class="chip past">superseded</span>
      <span class="hint">click a node for its pair, the caret to fold it</span>
    </p>
    <div id="tree" class="tree"></div>
    <h2 id="pair-title">pair</h2>
    <div class="pair">
      <div><h3 id="src-title">src</h3><div id="src-body"></div></div>
      <div><h3 id="tgt-title">tgt</h3><div id="tgt-body"></div></div>
    </div>
    <h2>event</h2>
    <pre id="detail"></pre>
  </section>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>__JS__</script>
</body>
</html>
"""

CSS = """
:root {
  color-scheme: light dark;
  --line: #8884; --add: #1a7f37; --del: #cf222e; --warm: #9a6700;
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; }
header { padding: 8px 16px; border-bottom: 1px solid var(--line); }
h1 { font-size: 16px; margin: 0; }
h2 { font-size: 13px; text-transform: lowercase; letter-spacing: .04em; margin: 16px 0 4px; }
#summary { margin: 2px 0 0; opacity: .7; }
main { display: flex; align-items: stretch; height: calc(100vh - 62px); }
aside { width: 22em; min-width: 16em; border-right: 1px solid var(--line);
        display: flex; flex-direction: column; }
#filters { padding: 6px 10px; border-bottom: 1px solid var(--line); font-size: 12px; }
#filters label { margin-right: 8px; white-space: nowrap; }
#scrubber { width: calc(100% - 20px); margin: 8px 10px; }
#timeline { flex: 1; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
#timeline li { padding: 3px 10px; cursor: pointer; display: flex; gap: 6px;
               font-family: ui-monospace, monospace; font-size: 12px; white-space: nowrap; }
#timeline li:hover { background: #8882; }
#timeline li.on { background: #8884; font-weight: 600; }
#timeline .n { opacity: .5; min-width: 2.5em; text-align: right; }
#timeline .ms { margin-left: auto; opacity: .5; }
section { flex: 1; overflow: auto; padding: 8px 16px 32px; }

.legend { margin: 0 0 8px; font-size: 12px; }
.hint { opacity: .6; margin-left: 8px; }
.chip { border-radius: 3px; padding: 0 6px; margin-right: 4px; border: 1px solid; }

/* The derivation: nested lists with the usual connector lines, so a subtree
   folds by not being drawn. */
.tree ul { list-style: none; margin: 0; padding-left: 20px; }
.tree > ul { padding-left: 0; }
.tree li { position: relative; padding: 2px 0 2px 16px; }
.tree > ul > li { padding-left: 0; }
.tree > ul > li::before, .tree > ul > li::after { display: none; }
.tree li::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0;
                   border-left: 1px solid var(--line); }
.tree li:last-child::before { bottom: auto; height: 15px; }
.tree li::after { content: ""; position: absolute; left: 0; top: 15px; width: 12px;
                  border-top: 1px solid var(--line); }

.node { display: inline-flex; align-items: baseline; gap: 6px; cursor: pointer;
        border: 1px solid; border-radius: 4px; padding: 1px 8px;
        font-family: ui-monospace, monospace; font-size: 12px; }
.node.on { outline: 2px solid currentColor; outline-offset: 1px; }
.node .gid { font-weight: 600; }
.node .via { opacity: .75; }
.node .pair { opacity: .5; }
.caret { border: 0; background: none; cursor: pointer; padding: 0 2px; font: inherit;
         color: inherit; opacity: .6; }
.edge { border: 0; background: none; padding: 0 6px 0 0; cursor: pointer; opacity: .75;
        font-family: ui-monospace, monospace; font-size: 12px; color: inherit; }
.edge:hover { opacity: 1; text-decoration: underline; }
.folded { opacity: .6; font-size: 11px; margin-left: 4px; }

.proved { color: var(--add); border-color: var(--add); }
.open { color: var(--del); border-color: var(--del); }
.split { color: var(--warm); border-color: var(--warm); }
.refuted { color: var(--del); border-color: var(--del); border-style: double; border-width: 3px; }
.past { opacity: .45; border-style: dashed; }

h3 { font-size: 12px; font-weight: 600; margin: 0 0 2px; opacity: .7; }
h3.changed { opacity: 1; color: var(--warm); }
.arrow { text-align: center; font-size: 16px; line-height: 1.2; opacity: .7; margin: 2px 0; }
.was pre { opacity: .75; }
.caption { font-size: 11px; opacity: .6; }
#pair-title span { font-weight: 400; opacity: .8; margin-left: 6px; }
#pair-title .at, #pair-title .quiet, .quiet { opacity: .55; }
.was { border: 1px solid var(--line); border-radius: 3px; background: none; color: inherit;
       font: inherit; font-size: 11px; padding: 0 5px; cursor: pointer; }
.pair { display: flex; gap: 12px; align-items: flex-start; }
.pair > div { flex: 1; min-width: 0; }
pre { font-family: ui-monospace, monospace; font-size: 12px; border: 1px solid var(--line);
      padding: 8px; overflow-x: auto; margin: 0; white-space: pre; }
"""

JS = """
const data = JSON.parse(document.getElementById("data").textContent);
const kinds = [...new Set(data.events.map((event) => event.kind))];
const byId = new Map(data.nodes.map((node) => [node.id, node]));
const children = new Map(data.nodes.map((node) => [node.id, []]));
for (const node of data.nodes) if (node.parent) children.get(node.parent).push(node.id);

const hidden = new Set();
const folded = new Set();
let at = data.events.length - 1;
let picked = data.events[at].focus;

const timeline = document.getElementById("timeline");
const scrubber = document.getElementById("scrubber");
scrubber.max = String(data.events.length - 1);

document.getElementById("summary").textContent =
  `${data.events.length} events, ${data.nodes.length} pairs, verdict ${data.verdict}` +
  (data.error ? `, log broken at ${data.error}` : "");

document.getElementById("filters").append(...kinds.map((kind) => {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = true;
  box.onchange = () => { box.checked ? hidden.delete(kind) : hidden.add(kind); draw(); };
  label.append(box, " " + kind);
  return label;
}));

function draw() {
  drawTimeline();
  drawTree();
  drawPair();
  document.getElementById("detail").textContent =
    data.events[at].entries.map((entry) => JSON.stringify(entry, null, 2)).join("\\n\\n");
}

function drawTimeline() {
  timeline.replaceChildren(...data.events.flatMap((event, index) => {
    if (hidden.has(event.kind)) return [];
    const row = document.createElement("li");
    if (index === at) row.className = "on";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(index);
    const what = document.createElement("span");
    what.textContent = event.label;
    row.append(n, what);
    if (event.ms !== undefined) {
      const ms = document.createElement("span");
      ms.className = "ms";
      ms.textContent = event.ms + "ms";
      row.append(ms);
    }
    row.onclick = () => { go(index); };
    return [row];
  }));
  timeline.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  scrubber.value = String(at);
}

/**
 * The derivation as it stands at the selected event: a node is drawn once its
 * move has happened, coloured by where its goal stands when the node is the
 * pair that goal currently holds, and faded when the run has moved past it.
 */
function drawTree() {
  const where = data.snapshots[at] ?? {};
  const current = new Map(Object.entries(where).map(([gid, goal]) => [goal.node, gid]));

  const drawNode = (id) => {
    const node = byId.get(id);
    const gid = current.get(id);
    const goal = gid ? where[gid] : null;
    const kids = children.get(id).filter((child) => byId.get(child).at <= at);

    const box = document.createElement("span");
    box.className = "node " + (goal ? goal.status : "past") + (id === picked ? " on" : "");
    box.onclick = () => { picked = id; draw(); };

    if (kids.length) {
      const caret = document.createElement("button");
      caret.className = "caret";
      caret.textContent = folded.has(id) ? "▸" : "▾";
      caret.onclick = (event) => {
        event.stopPropagation();
        folded.has(id) ? folded.delete(id) : folded.add(id);
        drawTree();
      };
      box.append(caret);
    }
    const name = document.createElement("span");
    name.className = "gid";
    name.textContent = node.gid + (goal?.role ? ` ${goal.role}` : "");
    const pair = document.createElement("span");
    pair.className = "pair";
    pair.textContent = `${short(node.src)} ${short(node.tgt)}`;
    box.append(name, pair);

    const row = document.createElement("li");
    // The edge is the move, so it carries the move's name and goes to the
    // event that made it; the node it points at is the pair that came out.
    if (node.parent) {
      const edge = document.createElement("button");
      edge.className = "edge";
      edge.textContent = `${moveOf(node)} →`;
      edge.title = `event ${node.at}: ${data.events[node.at].label}`;
      edge.onclick = () => { go(node.at, id); };
      row.append(edge);
    }
    row.append(box);
    if (folded.has(id) && kids.length) {
      const count = document.createElement("span");
      count.className = "folded";
      count.textContent = `+${countUnder(id)}`;
      box.append(count);
    } else if (kids.length) {
      const list = document.createElement("ul");
      list.append(...kids.map(drawNode));
      row.append(list);
    }
    return row;
  };

  const roots = data.nodes.filter((node) => !node.parent && node.at <= at);
  const list = document.createElement("ul");
  list.append(...roots.map((node) => drawNode(node.id)));
  document.getElementById("tree").replaceChildren(list);
}

function countUnder(id) {
  return children.get(id)
    .filter((child) => byId.get(child).at <= at)
    .reduce((total, child) => total + 1 + countUnder(child), 0);
}

/** How a node came about, in the words the timeline uses. */
function moveOf(node) {
  if (!node.parent) return node.tool;
  return node.side ? `${node.tool} on ${node.side}` : node.tool;
}

/**
 * The selected pair, and the move that produced it: which side it touched and
 * what that side was before, with the side that did not move said so.
 */
function drawPair() {
  const node = byId.get(picked);
  const title = document.getElementById("pair-title");
  const from = node?.parent ? byId.get(node.parent) : null;
  if (!node) {
    title.textContent = "pair";
    for (const side of ["src", "tgt"]) document.getElementById(side).textContent = "";
    return;
  }

  const moved = node.at === at;
  title.replaceChildren(
    tag("b", node.gid),
    tag("span", ` ${moveOf(node)}`),
    tag("span", from ? ` from ${from.id} to ${node.id}` : " the pair the run was asked about"),
    tag("span", ` at event ${node.at}`, "at"),
    moved ? tag("span", "") : tag("span", "unchanged by the selected event", "quiet"),
  );

  for (const side of ["src", "tgt"]) {
    const changed = from && from[side] !== node[side];
    const header = document.getElementById(side + "-title");
    header.className = changed ? "changed" : "";
    header.textContent = changed
      ? `${side} ${short(from[side])} → ${short(node[side])}`
      : `${side} ${short(node[side])}` + (from ? " unchanged" : "");

    const body = document.getElementById(side + "-body");
    const after = program(node[side]);
    if (!changed) {
      body.replaceChildren(after);
      continue;
    }
    // What the move replaced, above what it put there, so the change is read
    // rather than described.
    const before = program(from[side]);
    before.className = "was";
    body.replaceChildren(before, tag("div", "↓", "arrow"), after);
  }
}

function program(digest) {
  const block = document.createElement("pre");
  block.textContent = data.programs[digest] ?? "";
  return block;
}

function tag(name, text, className) {
  const node = document.createElement(name);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function short(digest) { return digest.slice(0, 8); }

/** Move to an event, and to the pair it is about unless one is named. */
function go(index, pick) {
  at = Math.min(data.events.length - 1, Math.max(0, index));
  picked = pick ?? data.events[at].focus ?? picked;
  draw();
}

scrubber.oninput = () => { go(Number(scrubber.value)); };
document.onkeydown = (key) => {
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -data.events.length, End: data.events.length };
  if (!(key.key in step)) return;
  key.preventDefault();
  go(at + step[key.key]);
};
draw();
"""


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
                "ms": row[-1].get("ms"),
                "focus": run.focus[index],
                "entries": row,
            }
            for index, row in enumerate(grouped)
        ],
        "snapshots": run.snapshots,
        "nodes": run.nodes,
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
