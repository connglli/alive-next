// biome-ignore lint/suspicious/noRedundantUseStrict: visualize.py embeds this as a classic script.
"use strict";

const data = JSON.parse(document.getElementById("data").textContent);
const $ = (id) => document.getElementById(id);
const byId = new Map(data.nodes.map((node) => [node.id, node]));
const hiddenKinds = new Set();
const NS = "http://www.w3.org/2000/svg";

let at = data.events.length - 1;
let selection = null;
let inspectorView = "changes";
let showAll = false;
let zoom = 1;
let graphWidth = 1;
let graphHeight = 1;

/* Fixed card dimensions make the layout deterministic and dependency-free. */
const CARD_W = 348;
const CARD_H = 104;
const STEP_GAP = 66;
const SIBLING_GAP = 38;
const JUNCTION_W = 184;
const JUNCTION_H = 40;
const PAD = 35;

/*
 * Refutation changes a goal's status without creating a new node.
 * Index the reporting event separately from the revision's creation event.
 *
 * We know the effects schema, but not the checker payload schema, so retain
 * the complete originating event rather than guessing diagnostic fields.
 */
const counterexamples = data.events.flatMap((event, index) => {
  const gids = [
    ...new Set(
      event.entries.flatMap((entry) =>
        (entry.effects || [])
          .filter((effect) => effect.effect === "refuted" && typeof effect.gid === "string")
          .map((effect) => effect.gid),
      ),
    ),
  ];

  if (!gids.length) return [];

  /*
   * Only attach evidence to revisions confirmed refuted in this snapshot.
   * With a broken replay, keep event evidence accessible but avoid claiming
   * a validated association with the graph.
   */
  const nodeIds = data.error
    ? []
    : gids.flatMap((gid) => {
        const goal = data.snapshots[index]?.[gid];
        return goal?.status === "refuted" && byId.has(goal.node) ? [goal.node] : [];
      });

  return [
    {
      at: index,
      gids,
      nodeIds,
      entries: event.entries,
    },
  ];
});

const counterexampleByEvent = new Map(counterexamples.map((record) => [record.at, record]));

function counterexamplesForNode(nodeId) {
  return counterexamples.filter((record) => record.at <= at && record.nodeIds.includes(nodeId));
}

function counterexamplesForSelection() {
  if (!selection) return [];

  if (selection.type === "event") {
    const direct = counterexampleByEvent.get(selection.at);
    if (direct) return [direct];

    const event = data.events[selection.at];
    const isCounterexampleVerdict = event?.entries.some(
      (entry) => entry.kind === "verdict" && entry.outcome === "counterexample",
    );

    if (isCounterexampleVerdict) {
      // A refuted child alone is not evidence for the final root verdict.
      return counterexamples.filter(
        (record) => record.at <= selection.at && record.gids.includes("g1"),
      );
    }

    return [];
  }

  if (selection.type === "node" || selection.type === "step") {
    return counterexamplesForNode(selection.nodeId);
  }

  return [];
}

function syncInspectorTabs() {
  const count = counterexamplesForSelection().length;

  if (inspectorView === "counterexample" && count === 0) {
    inspectorView = "changes";
  }

  for (const tab of document.querySelectorAll("[data-view]")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.view === inspectorView));

    if (tab.dataset.view === "counterexample") {
      tab.hidden = count === 0;
      tab.textContent = count ? `Counterexample (${count})` : "Counterexample";
    }
  }
}

function openCounterexample(eventIndex) {
  inspectorView = "counterexample";
  go(eventIndex);
  openInspector();
}

/*
 * Observations read as one `name = value` line each. Null when there is
 * nothing to show, so the caller reads reason and stop instead.
 */
function observationsText(observations) {
  if (!observations || typeof observations !== "object" || Array.isArray(observations)) {
    return null;
  }
  const lines = Object.keys(observations).map((key) => {
    const shown =
      typeof observations[key] === "string" ? observations[key] : JSON.stringify(observations[key]);
    return `${key} = ${shown}`;
  });
  return lines.length ? lines.join("\n") : null;
}

/*
 * One side's output: observations as `name = value` lines, or, when the run
 * showed nothing, why it stopped and the instruction it stopped at.
 */
function sideText(side) {
  const seen = observationsText(side.observations);
  if (seen !== null) return seen;
  const lines = [];
  if (side.reason) lines.push(`${side.reason}`);
  if (side.at) lines.push(`at: ${side.at}`);
  if (!lines.length) lines.push(`outcome: ${side.outcome || "unknown"}`);
  return lines.join("\n");
}

/*
 * JSON escapes multiline output. Render those strings separately as readable
 * text, while preserving the entire original payload below.
 *
 * Insert checker output with textContent through el(). Highlight.js may then
 * safely decorate explicitly identified code; arbitrary diagnostics stay text.
 */
function multilineFields(value, path = "$", result = []) {
  const isInput = /\["inputs?"\]$/.test(path);
  // Traces never show.
  if (/\["trace"\]$/.test(path)) return result;
  const isReplaySide = /\["result"\]\["replay"\]\["(?:src|tgt)"\]$/.test(path);
  if (isReplaySide && value && typeof value === "object" && !Array.isArray(value)) {
    result.push({ path: `${path}["observations"]`, text: sideText(value) });
    return result;
  }

  // Include input even when it isn't a multiline string.
  // Preserve structured values rather than extracting guessed fields.
  if (isInput) {
    result.push({
      path,
      language: typeof value === "string" ? null : "json",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    });
    return result;
  }

  if (typeof value === "string") {
    if (/[\r\n]/.test(value)) {
      result.push({ path, text: value });
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      multilineFields(item, `${path}[${index}]`, result);
    });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      multilineFields(item, `${path}[${JSON.stringify(key)}]`, result);
    }
  }

  return result;
}

function counterexampleFieldLabel(path) {
  if (/\["inputs?"\]$/.test(path)) {
    return "INPUT";
  }

  if (/\["result"\]\["replay"\]\["src"\]\["observations"\]$/.test(path)) {
    return "SOURCE OUTPUT (LLUBI)";
  }

  if (/\["result"\]\["replay"\]\["tgt"\]\["observations"\]$/.test(path)) {
    return "TARGET OUTPUT (LLUBI)";
  }

  if (/\["check"\]\["detail"\]$/.test(path)) {
    return "EXAMPLE (ALIVE2)";
  }

  if (/\["check"\]\["stdout"\]$/.test(path)) {
    return "DETAILS (ALIVE2)";
  }

  return path;
}

function recordedPayloadView(entries) {
  const body = el("div");
  const collected = multilineFields(entries);
  const isInput = (field) => /\["inputs?"\]$/.test(field.path);

  // Source and target share the same input. Display it once, first.
  const input = collected.find(isInput);
  const fields = [...(input ? [input] : []), ...collected.filter((field) => !isInput(field))];

  for (const field of fields) {
    const section = el("section", "counterexample-field");
    const heading = el("div", "counterexample-field-heading", counterexampleFieldLabel(field.path));
    heading.title = field.path;

    section.append(
      heading,
      field.language
        ? codeBlock(field.text, field.language, "counterexample-text")
        : el("pre", "counterexample-text", field.text),
    );
    body.append(section);
  }

  const raw = el("details", "counterexample-payload");
  // With no multiline fields, show the complete payload immediately.
  raw.open = fields.length === 0;
  raw.append(
    el("summary", "", "Complete recorded event payload"),
    codeBlock(JSON.stringify(entries, null, 2), "json", "raw-json counterexample-text"),
  );
  body.append(raw);

  return body;
}

function counterexampleView() {
  const body = el("div");
  const records = counterexamplesForSelection();

  if (!records.length) {
    body.append(
      el(
        "div",
        "empty",
        "No counterexample-reporting event is linked to this selection " +
          "at the current trajectory position.",
      ),
    );

    /*
     * Still let the user inspect the selected event. Some checker failures
     * may carry diagnostics without emitting a refuted effect.
     */
    const event = data.events[eventForSelection()];
    if (event) {
      body.append(
        el(
          "p",
          "counterexample-note",
          "The complete selected event is shown below. Diagnostics without " +
            "a refuted effect are not automatically classified as counterexamples.",
        ),
        recordedPayloadView(event.entries),
      );
    }

    return body;
  }

  body.append(
    el(
      "p",
      "counterexample-note",
      "Complete recorded event data. Multiline fields are expanded for " +
        "readability; the original payload is preserved below. " +
        "These records describe the check that refuted the run, whatever " +
        "tool (llubi or alive2) reported it.",
    ),
  );

  for (const record of records) {
    const card = el("section", "counterexample-card");
    const revisions = record.nodeIds.map((nodeId) => {
      const node = byId.get(nodeId);
      return `${node.gid} v${revisionOf(node)}`;
    });

    card.append(
      selectionHeading(
        `Counterexample · ${record.gids.join(", ")}`,
        `Reported at event ${record.at} · ${data.events[record.at].kind}` +
          (revisions.length ? ` · ${revisions.join(", ")}` : ""),
        record.at,
      ),
      recordedPayloadView(record.entries),
    );
    body.append(card);
  }

  return body;
}

function el(name, className = "", text = null) {
  const item = document.createElement(name);
  if (className) item.className = className;
  if (text !== null) item.textContent = text;
  return item;
}

function button(text, className, action) {
  const item = el("button", className, text);
  item.type = "button";
  item.onclick = action;
  return item;
}

function svg(name, attributes = {}) {
  const item = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) {
    item.setAttribute(key, String(value));
  }
  return item;
}

function short(digest) {
  return data.pnames[digest] || String(digest).slice(0, 8);
}

function clip(text, limit) {
  text = String(text);
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function currentSnapshot() {
  return data.snapshots[at] || {};
}

/*
 * Follow actual node ancestry, not all nodes with the same gid.
 * This avoids mixing separate incarnations if an undone split removes
 * children and a later split reuses their goal IDs.
 */
function historyFor(nodeId) {
  const result = [];
  let node = byId.get(nodeId);
  const gid = node?.gid;
  const seen = new Set();

  while (node && node.gid === gid && !seen.has(node.id)) {
    seen.add(node.id);
    result.push(node);
    node = byId.get(node.parent);
  }
  return result.reverse();
}

function revisionOf(node) {
  return historyFor(node.id).length - 1;
}

function moveOf(node) {
  const parent = byId.get(node.parent);
  if (!parent || parent.gid !== node.gid) return node.tool;

  const side = {
    src: "Source",
    tgt: "Target",
    both: "Both sides",
  }[node.side];

  return [side, node.tool, node.note].filter(Boolean).join(" · ");
}

function edgeCaption(node) {
  const side = { src: "SRC", tgt: "TGT", both: "BOTH" }[node.side];
  // A commit records a transaction, so the edge says what it was. A
  // strengthen's attributes stay in the footers, so its edge says one word.
  let move = node.note || node.tool;
  if (node.tool === "tx_commit") move = "transaction";
  else if (node.side === "both") move = node.tool;
  return [side, move].filter(Boolean).join(" · ");
}

function selectedNodeId() {
  return selection?.nodeId || null;
}

function select(value) {
  selection = value;
  drawGraph();
  openInspector();
}

function openInspector() {
  const dialog = $("inspector-dialog");

  syncInspectorTabs();

  $("dialog-content").replaceChildren(inspectorBody());

  if (!dialog.open) {
    dialog.showModal();
  }

  $("dialog-content").scrollTop = 0;
}

function eventForSelection() {
  if (!selection) return at;
  if (selection.type === "event" || selection.type === "split") {
    return selection.at;
  }
  return byId.get(selection.nodeId)?.at ?? at;
}

/* ---------- Trajectory ---------- */

const kinds = [...new Set(data.events.map((event) => event.kind))];

$("filters").append(
  ...kinds.map((kind) => {
    const label = el("label");
    const input = el("input");
    input.type = "checkbox";
    input.checked = true;
    input.onchange = () => {
      input.checked ? hiddenKinds.delete(kind) : hiddenKinds.add(kind);
      drawTimeline();
    };
    label.append(input, document.createTextNode(kind));
    return label;
  }),
);

function drawTimeline() {
  const query = $("search").value.trim().toLowerCase();
  let visible = 0;
  const fragment = document.createDocumentFragment();

  data.events.forEach((event, index) => {
    if (hiddenKinds.has(event.kind)) return;
    if (query && !(event.label + " " + JSON.stringify(event.entries)).toLowerCase().includes(query))
      return;

    visible++;
    const row = el("li");

    // A reported counterexample has two independent actions:
    //   kind → open counterexample
    //   description → select trajectory event
    // Which tool reported it does not matter: a report_cex row and one
    // from a check or the start check read the same.
    const reported =
      event.kind === "report_cex" ||
      event.entries.some((entry) => entry.tool === "report_cex") ||
      counterexampleByEvent.has(index);

    const control = reported
      ? el("div", "event-button")
      : button("", "event-button", () => go(index));

    // The cover stays a div, since a button does not carry buttons, but a
    // click anywhere on the card still selects. Clicks on the kind and the
    // description bubble into it, and those actions already select.
    if (reported) control.onclick = () => go(index);

    control.dataset.index = String(index);

    if (!reported) {
      control.title = event.label;
    }

    const number = el("span", "event-number", String(index).padStart(3, "0"));
    const body = el("span", "event-text");
    const top = el("span", "event-top");

    if (reported) {
      const kind = button(event.kind, "event-kind counterexample-link", () =>
        openCounterexample(index),
      );
      kind.title = "Open counterexample";
      kind.setAttribute("aria-label", `Open counterexample reported at event ${index}`);
      top.append(kind);
    } else {
      top.append(el("span", "event-kind", event.kind));
    }

    if (event.ms !== undefined) {
      top.append(el("span", "event-time", `${event.ms} ms`));
    }

    const description = reported
      ? button(event.label, "event-description event-select", () => go(index))
      : el("span", "event-description", event.label);

    if (reported) {
      description.title = event.label;
      description.setAttribute("aria-label", `Select event ${index}: ${event.label}`);
    }

    body.append(top, description);
    control.append(number, body);
    row.append(control);

    fragment.append(row);
  });

  $("timeline").replaceChildren(fragment);
  $("event-count").textContent = `${visible} / ${data.events.length}`;
  $("no-events").hidden = visible !== 0;
  syncTimeline(false);
}

function syncTimeline(scroll = true) {
  for (const control of $("timeline").querySelectorAll(".event-button")) {
    const active = Number(control.dataset.index) === at;
    control.classList.toggle("selected", active);
    if (active) control.setAttribute("aria-current", "step");
    else control.removeAttribute("aria-current");
  }

  $("scrubber").value = String(at);
  $("position").textContent = `Event ${at} of ${data.events.length - 1}`;
  $("previous").disabled = at === 0;
  $("next").disabled = at === data.events.length - 1;

  if (scroll) {
    $("timeline").querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  }
}

function go(index) {
  at = Math.max(0, Math.min(data.events.length - 1, index));
  const focus = data.events[at]?.focus;
  selection = {
    type: "event",
    at,
    nodeId: focus && byId.has(focus) ? focus : null,
  };
  syncTimeline();
  drawGraph();
  drawInspector();
}

/* ---------- Graph model and layout ---------- */

function buildForest() {
  const snapshot = currentSnapshot();
  const children = new Map(Object.keys(snapshot).map((gid) => [gid, []]));
  const roots = [];

  for (const [gid, goal] of Object.entries(snapshot)) {
    if (goal.parent && children.has(goal.parent)) {
      children.get(goal.parent).push(gid);
    } else {
      roots.push(gid);
    }
  }

  function build(gid) {
    const goal = snapshot[gid];
    const history = historyFor(goal.node);
    const nodes = showAll ? history : history.slice(-1);
    const kids = children.get(gid).map(build);
    const ownHeight = nodes.length * CARD_H + Math.max(0, nodes.length - 1) * STEP_GAP;

    const childWidth =
      kids.reduce((sum, child) => sum + child.width, 0) +
      Math.max(0, kids.length - 1) * SIBLING_GAP;

    return {
      gid,
      goal,
      history,
      nodes,
      kids,
      ownHeight,
      width: Math.max(CARD_W, childWidth),
      height:
        ownHeight +
        (kids.length ? 48 + JUNCTION_H + 86 + Math.max(...kids.map((child) => child.height)) : 0),
    };
  }

  return roots.map(build);
}

function splitSelection(plan) {
  const children = plan.kids.map((child) => child.history[0]).filter(Boolean);
  return {
    type: "split",
    gid: plan.gid,
    nodeId: children[0]?.parent || plan.goal.node,
    children: children.map((node) => node.id),
    at: children[0]?.at ?? at,
  };
}

function isSelectedEdge(value) {
  if (!selection || selection.type !== value.type) return false;
  if (value.type === "split") {
    return selection.gid === value.gid && selection.at === value.at;
  }
  return selection.nodeId === value.nodeId;
}

function addEdge(x1, y1, x2, y2, label, value) {
  const middle = (y1 + y2) / 2;
  const path = `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
  const group = svg("g", {
    class: "graph-edge" + (isSelectedEdge(value) ? " selected" : ""),
    tabindex: 0,
    role: "button",
    "aria-label": label || "Inspect split",
  });

  const title = svg("title");
  title.textContent = label || "Inspect split";

  group.append(
    title,
    svg("path", { d: path, class: "edge-hit" }),
    svg("path", { d: path, class: "edge-line", "marker-end": "url(#arrow)" }),
  );

  if (label) {
    const text = clip(label, 35);
    const width = text.length * 6.2 + 18;
    const x = (x1 + x2) / 2;

    group.append(
      svg("rect", {
        x: x - width / 2,
        y: middle - 12,
        width,
        height: 24,
        rx: 7,
        class: "edge-label-bg",
      }),
    );

    const caption = svg("text", {
      x,
      y: middle + 3.5,
      class: "edge-label",
    });
    caption.textContent = text;
    group.append(caption);
  }

  group.onclick = () => select(value);
  group.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(value);
    }
  };
  $("wires").append(group);
}

function addCard(plan, node, x, y) {
  const current = node.id === plan.goal.node;
  const status = current ? plan.goal.status : "historical";
  const picked = selectedNodeId();
  const selected =
    node.id === picked || (!showAll && plan.history.some((version) => version.id === picked));

  const card = el("article", "goal-card" + (selected ? " selected" : ""));
  card.dataset.status = status;
  Object.assign(card.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${CARD_W}px`,
    height: `${CARD_H}px`,
  });

  const main = button("", "node-main", () => select({ type: "node", nodeId: node.id }));
  main.setAttribute(
    "aria-label",
    `${node.gid} revision ${revisionOf(node)}, ${status}, ` +
      `source ${short(node.src)}, target ${short(node.tgt)}`,
  );

  const heading = el("span", "node-heading");
  heading.append(
    el("span", "goal-name", node.gid),
    el("span", "revision-name", `v${revisionOf(node)}`),
  );
  if (plan.goal.role) heading.append(el("span", "goal-role", plan.goal.role));
  heading.append(el("span", `status ${status}`, status));

  const pair = el("span", "node-pair");
  for (const side of ["src", "tgt"]) {
    const half = el("span", "node-side");
    const label = el("span", "side-label", side === "src" ? "SOURCE" : "TARGET");
    const name = el("span", "program-name", short(node[side]));
    name.title = node[side];
    label.append(name);
    half.append(label);
    pair.append(half);
  }
  main.append(heading, pair);

  const strip = el("div", "version-strip");
  if (showAll) {
    const info = button(`Event ${node.at} · ${clip(moveOf(node), 42)}`, "hop-chip", () =>
      select({ type: node.parent ? "step" : "node", nodeId: node.id }),
    );
    info.title = moveOf(node);
    strip.append(info);
  } else {
    plan.history.forEach((version, index) => {
      if (index) {
        const hopValue = { type: "step", nodeId: version.id };
        const hop = button(
          ({ src: "S", tgt: "T", both: "S+T" }[version.side] || "") + " →",
          "hop-chip" + (isSelectedEdge(hopValue) ? " selected" : ""),
          () => select(hopValue),
        );
        hop.title = moveOf(version);
        hop.setAttribute("aria-label", `Inspect ${moveOf(version)}`);
        strip.append(hop);
      }

      const chip = button(
        `v${index}`,
        "version-chip" +
          (version.id === plan.goal.node ? " current" : "") +
          (version.id === picked ? " selected" : ""),
        () => select({ type: "node", nodeId: version.id }),
      );
      chip.title = `${short(version.src)} | ${short(version.tgt)} · event ${version.at}`;
      strip.append(chip);
    });
  }

  const witnesses = counterexamplesForNode(node.id);

  if (witnesses.length) {
    const latest = witnesses[witnesses.length - 1];
    const action = button("CE ↗", "hop-chip counterexample-action", () =>
      openCounterexample(latest.at),
    );
    action.title = `View counterexample reported at event ${latest.at}`;
    action.setAttribute("aria-label", action.title);
    strip.append(action);
  }

  card.append(main, strip);
  $("cards").append(card);

  if (!showAll) {
    requestAnimationFrame(() => {
      const target =
        strip.querySelector(".version-chip.selected") ||
        strip.querySelector(".version-chip.current");
      if (target) {
        strip.scrollLeft = Math.max(0, target.offsetLeft - strip.offsetLeft - 120);
      }
    });
  }
}

function placePlan(plan, x, y) {
  const center = x + plan.width / 2;

  plan.nodes.forEach((node, index) => {
    const top = y + index * (CARD_H + STEP_GAP);
    addCard(plan, node, center - CARD_W / 2, top);

    if (index) {
      addEdge(center, top - STEP_GAP, center, top, edgeCaption(node), {
        type: "step",
        nodeId: node.id,
      });
    }
  });

  if (!plan.kids.length) return;

  const value = splitSelection(plan);
  const junctionY = y + plan.ownHeight + 48;
  const junction = button(
    `◇ Split · ${plan.kids.length} subgoals`,
    "split-junction" + (isSelectedEdge(value) ? " selected" : ""),
    () => select(value),
  );
  Object.assign(junction.style, {
    left: `${center - JUNCTION_W / 2}px`,
    top: `${junctionY}px`,
    width: `${JUNCTION_W}px`,
    height: `${JUNCTION_H}px`,
  });
  $("cards").append(junction);

  addEdge(center, y + plan.ownHeight, center, junctionY, "", value);

  const totalWidth =
    plan.kids.reduce((sum, child) => sum + child.width, 0) + (plan.kids.length - 1) * SIBLING_GAP;
  let childX = center - totalWidth / 2;
  const childY = junctionY + JUNCTION_H + 86;

  for (const child of plan.kids) {
    const childCenter = childX + child.width / 2;
    addEdge(
      center,
      junctionY + JUNCTION_H,
      childCenter,
      childY,
      [child.goal.role, child.gid].filter(Boolean).join(" · "),
      value,
    );
    placePlan(child, childX, childY);
    childX += child.width + SIBLING_GAP;
  }
}

function drawGraph() {
  const forest = buildForest();
  const snapshot = currentSnapshot();
  const open = Object.values(snapshot).filter((goal) => goal.status === "open").length;

  $("graph-position").textContent = `Event ${at} · ${open} open`;
  $("cards").replaceChildren();
  $("wires").replaceChildren();

  const defs = svg("defs");
  const marker = svg("marker", {
    id: "arrow",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 5,
    markerHeight: 5,
    orient: "auto-start-reverse",
  });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#aebbd0" }));
  defs.append(marker);
  $("wires").append(defs);

  graphWidth = Math.max(
    400,
    PAD * 2 +
      forest.reduce((sum, plan) => sum + plan.width, 0) +
      Math.max(0, forest.length - 1) * SIBLING_GAP,
  );
  graphHeight = Math.max(180, PAD * 2 + Math.max(0, ...forest.map((plan) => plan.height)));

  $("wires").setAttribute("width", String(graphWidth));
  $("wires").setAttribute("height", String(graphHeight));
  $("wires").setAttribute("viewBox", `0 0 ${graphWidth} ${graphHeight}`);

  let x = PAD;
  for (const plan of forest) {
    placePlan(plan, x, PAD);
    x += plan.width + SIBLING_GAP;
  }

  if (!forest.length) {
    $("cards").append(el("div", "empty", "No goals at this event."));
  }
  applyZoom();
}

/* ---------- Inspector ---------- */

/*
 * Explicit language selection avoids guessing that diagnostics are code.
 * All source text enters the DOM via textContent, never raw HTML.
 */
function highlightCode(code) {
  const highlighter = window.hljs;
  const language = code.dataset.language;
  if (!highlighter || code.dataset.highlighted || !highlighter.getLanguage(language)) return;

  const text = code.textContent;
  try {
    highlighter.highlightElement(code);
  } catch {
    // Missing/broken CDN assets or grammar failures must not break inspection.
    code.textContent = text;
    code.classList.remove("hljs");
    delete code.dataset.highlighted;
  }
}

function highlightedCode(text, language) {
  const code = el("code", `syntax-code language-${language}`, text);
  code.dataset.language = language;
  highlightCode(code);
  return code;
}

function codeBlock(text, language, className = "") {
  const block = el("pre", className);
  block.append(highlightedCode(text, language));
  return block;
}

// Deferred CDN scripts finish before this event; catch any early renders.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("code.syntax-code").forEach(highlightCode);
});

function fullProgram(digest) {
  return codeBlock(data.programs[digest] || "; Program unavailable", "llvm");
}

function diffBlock(lines) {
  const block = el("div", "diff");
  if (!lines.length) {
    block.append(el("div", "diff-line", "No textual line differences."));
    return block;
  }
  for (const line of lines) {
    const kind = line.startsWith("@")
      ? "hunk"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "";
    const row = el("div", `diff-line ${kind}`);
    row.append(highlightedCode(line || " ", "diff"));
    block.append(row);
  }
  return block;
}

function fullDisclosure(title, digest) {
  const details = el("details", "program-full");
  details.append(el("summary", "", title), fullProgram(digest));
  return details;
}

/*
 * forceState is used for split inputs/outputs and event selections whose
 * focused node was created earlier. Those should not display an old diff
 * as if it were caused by the currently selected event.
 */
function pairView(node, forceState = false) {
  const pair = el("div", "pair-grid");
  const parent = byId.get(node.parent);
  const sameGoal = parent && parent.gid === node.gid;
  const changes = inspectorView === "changes" && !forceState;

  for (const side of ["src", "tgt"]) {
    const info = data.diffs[node.id]?.[side];
    const changed = Boolean(sameGoal && info?.changed);
    const panel = el("section", "program-panel");
    const heading = el("div", "program-heading");
    const name = el("span", "program-ref", short(node[side]));
    name.title = node[side];

    let caption = "Full program";
    if (changes) {
      caption = !sameGoal ? "Initial state" : changed ? `+${info.adds} −${info.dels}` : "Unchanged";
    }

    heading.append(
      el("strong", "", side === "src" ? "SOURCE" : "TARGET"),
      name,
      el("span", "change-label" + (changes && changed ? " changed" : ""), caption),
    );
    panel.append(heading);

    if (changes && changed) {
      panel.append(
        diffBlock(info.lines),
        fullDisclosure(`Before · ${short(parent[side])}`, parent[side]),
        fullDisclosure(`After · ${short(node[side])}`, node[side]),
      );
    } else {
      panel.append(fullProgram(node[side]));
    }
    pair.append(panel);
  }
  return pair;
}

function selectionHeading(title, description, eventIndex) {
  const heading = el("div", "selection-heading");
  const text = el("div");
  text.append(el("h3", "", title), el("p", "selection-description", description));
  heading.append(text);

  if (eventIndex !== at) {
    heading.append(
      button(`Jump to event ${eventIndex} →`, "small-button", () => {
        $("inspector-dialog").close();
        go(eventIndex);
      }),
    );
  }
  return heading;
}

function inspectorBody() {
  const body = el("div");
  if (!selection) {
    body.append(el("div", "empty", "Select an event, state, or transition."));
    return body;
  }

  const index = eventForSelection();
  const event = data.events[index];
  const node = byId.get(selection.nodeId);
  const snapshot = currentSnapshot();
  let title;
  let description;

  if (selection.type === "split") {
    title = `${selection.gid} · Split into ${selection.children.length} subgoals`;
    description = `Split recorded at event ${index}. Viewing the tree after event ${at}.`;
  } else if (selection.type === "event") {
    title = `Event ${index} · ${event?.kind || "event"}`;
    description = event?.label || "";
  } else {
    title = node
      ? `${node.gid} · v${revisionOf(node)} · ${selection.type === "step" ? "Transition" : "State"}`
      : "State unavailable";

    const active = node && snapshot[node.gid]?.node === node.id;
    description = node
      ? `${moveOf(node)} · created at event ${node.at}. ` +
        (active
          ? `Current revision; goal is ${snapshot[node.gid].status} at event ${at}.`
          : `Historical revision; viewing the tree at event ${at}.`)
      : "";
  }

  body.append(selectionHeading(title, description, index));

  if (inspectorView === "counterexample") {
    body.append(counterexampleView());
    return body;
  }

  if (inspectorView === "raw") {
    const raw = {
      selection,
      viewedAtEvent: at,
      state: node || null,
      entries: event?.entries || [],
    };
    body.append(codeBlock(JSON.stringify(raw, null, 2), "json", "raw-json"));
    return body;
  }

  if (selection.type === "split") {
    body.append(
      el(
        "div",
        "split-explanation",
        "Both subgoals are required: this replay marks the parent proved when all children are proved. " +
          "Child programs are new states, not rewrite diffs against the parent.",
      ),
    );

    if (node) {
      body.append(
        el("div", "split-section-title", `Input · ${node.gid} v${revisionOf(node)}`),
        pairView(node, true),
      );
    }

    for (const childId of selection.children) {
      const child = byId.get(childId);
      if (!child) continue;
      const role = snapshot[child.gid]?.role || child.tool;
      body.append(
        el("div", "split-section-title", `Output · ${child.gid} · ${role}`),
        pairView(child, true),
      );
    }
    return body;
  }

  if (node) {
    const unchangedEvent = selection.type === "event" && node.at !== at;
    if (unchangedEvent) {
      body.append(
        el(
          "p",
          "selection-description",
          `Focused state: ${node.gid} v${revisionOf(node)}, created at event ${node.at}. ` +
            "This event did not create that revision.",
        ),
      );
    }
    body.append(pairView(node, unchangedEvent));
  } else {
    body.append(el("div", "empty", "This event has no focused goal state."));
  }

  if (selection.type === "event") {
    const raw = el("details", "program-full");
    raw.append(
      el("summary", "", "Event payload"),
      codeBlock(JSON.stringify(event?.entries || [], null, 2), "json"),
    );
    body.append(raw);
  }
  return body;
}

function drawInspector() {
  syncInspectorTabs();

  if (!$("inspector-dialog").open) return;

  $("dialog-content").replaceChildren(inspectorBody());
}

/* ---------- Viewport ---------- */

function applyZoom() {
  const viewport = $("viewport");
  const scaledWidth = graphWidth * zoom;
  const scaledHeight = graphHeight * zoom;

  $("stage").style.width = `${Math.max(viewport.clientWidth, scaledWidth)}px`;
  $("stage").style.height = `${Math.max(viewport.clientHeight, scaledHeight)}px`;

  Object.assign($("canvas").style, {
    width: `${graphWidth}px`,
    height: `${graphHeight}px`,
    left: `${Math.max(0, (viewport.clientWidth - scaledWidth) / 2)}px`,
    transform: `scale(${zoom})`,
  });
  $("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(value) {
  const viewport = $("viewport");
  const previous = zoom;
  const oldLeft = parseFloat($("canvas").style.left) || 0;
  const worldX = (viewport.scrollLeft + viewport.clientWidth / 2 - oldLeft) / previous;
  const worldY = (viewport.scrollTop + viewport.clientHeight / 2) / previous;

  zoom = Math.max(0.08, Math.min(2, value));
  applyZoom();

  const newLeft = parseFloat($("canvas").style.left) || 0;
  viewport.scrollLeft = worldX * zoom + newLeft - viewport.clientWidth / 2;
  viewport.scrollTop = worldY * zoom - viewport.clientHeight / 2;
}

function fitGraph() {
  const viewport = $("viewport");
  setZoom(
    Math.min(
      1,
      (viewport.clientWidth - 20) / graphWidth,
      (viewport.clientHeight - 20) / graphHeight,
    ),
  );
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

let dragging = null;
$("viewport").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.pointerType === "touch") return;
  if (event.target.closest("button, .graph-edge, .goal-card")) return;

  dragging = {
    x: event.clientX,
    y: event.clientY,
    left: $("viewport").scrollLeft,
    top: $("viewport").scrollTop,
  };
  $("viewport").classList.add("dragging");
  $("viewport").setPointerCapture(event.pointerId);
});

$("viewport").addEventListener("pointermove", (event) => {
  if (!dragging) return;
  $("viewport").scrollLeft = dragging.left - (event.clientX - dragging.x);
  $("viewport").scrollTop = dragging.top - (event.clientY - dragging.y);
});

function stopDragging() {
  dragging = null;
  $("viewport").classList.remove("dragging");
}
$("viewport").addEventListener("pointerup", stopDragging);
$("viewport").addEventListener("pointercancel", stopDragging);
$("viewport").addEventListener("lostpointercapture", stopDragging);

$("viewport").addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoom * Math.exp(-event.deltaY * 0.004));
  },
  { passive: false },
);

new ResizeObserver(applyZoom).observe($("viewport"));

/* ---------- Wiring and startup ---------- */

$("search").oninput = drawTimeline;
$("scrubber").max = String(data.events.length - 1);
$("scrubber").oninput = () => go(Number($("scrubber").value));
$("previous").onclick = () => go(at - 1);
$("next").onclick = () => go(at + 1);

$("all-revisions").onchange = () => {
  showAll = $("all-revisions").checked;
  drawGraph();
};

$("zoom-in").onclick = () => setZoom(zoom * 1.2);
$("zoom-out").onclick = () => setZoom(zoom / 1.2);
$("fit").onclick = fitGraph;

for (const tab of document.querySelectorAll("[data-view]")) {
  tab.onclick = () => {
    inspectorView = tab.dataset.view;
    drawInspector();
    $("dialog-content").scrollTop = 0;
  };
}

$("inspect-event").onclick = () => {
  const focus = data.events[at]?.focus;

  selection = {
    type: "event",
    at,
    nodeId: focus && byId.has(focus) ? focus : null,
  };

  drawGraph();
  openInspector();
};
$("close-dialog").onclick = () => $("inspector-dialog").close();

document.addEventListener("keydown", (event) => {
  if ($("inspector-dialog").open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest("input, textarea, select, button, summary, a, [contenteditable]"))
    return;

  const target = {
    ArrowLeft: at - 1,
    ArrowRight: at + 1,
    Home: 0,
    End: data.events.length - 1,
  }[event.key];

  if (target === undefined) return;
  event.preventDefault();
  go(target);
});

const goalsEver = new Set(data.nodes.map((node) => node.gid));
$("summary").textContent =
  `${data.events.length} events · ${goalsEver.size} goals · ${data.nodes.length} states`;

$("verdict").textContent = `Final: ${data.verdict}`;
$("verdict").className =
  "badge " +
  ({
    verified: "proved",
    counterexample: "refuted",
  }[data.verdict] || "historical");

if (data.verdict === "counterexample") $("graph-heading").classList.add("refuted");
if (data.verdict === "counterexample") $("inspector-heading").classList.add("refuted");

/*
 * Prefer the recorded final verdict event. Its Counterexample view lists
 * root-refuting records reported up to that event.
 *
 * If no verdict event was recorded, use the latest root-refuting event.
 */
const counterexampleVerdictAt = data.events.reduce(
  (found, event, index) =>
    event.entries.some((entry) => entry.kind === "verdict" && entry.outcome === "counterexample")
      ? index
      : found,
  -1,
);

const rootCounterexamples = counterexamples.filter((record) => record.gids.includes("g1"));

const latestRootCounterexample = rootCounterexamples[rootCounterexamples.length - 1];

const finalCounterexampleAt =
  counterexampleVerdictAt >= 0 ? counterexampleVerdictAt : latestRootCounterexample?.at;

const counterexampleButton = $("view-counterexample");

if (data.verdict === "counterexample" && finalCounterexampleAt !== undefined) {
  counterexampleButton.hidden = false;
  counterexampleButton.classList.add("counterexample-action");
  counterexampleButton.onclick = () => openCounterexample(finalCounterexampleAt);
}

if (data.error) {
  $("warning").hidden = false;
  $("warning").textContent =
    `Replay warning: ${data.error}. Later events retain the last valid snapshot; ` +
    "do not treat the remainder as a validated derivation.";
}

drawTimeline();
go(at);

/* Initially fit the width, keeping the root readable rather than shrinking
 * a deep tree until the entire derivation is microscopic. */
requestAnimationFrame(() => {
  setZoom(Math.min(1, ($("viewport").clientWidth - 20) / graphWidth));
  $("viewport").scrollTop = 0;
});
