"""Presentation layer for visualize.py.

Syntax highlighting loads Highlight.js and its theme from a pinned CDN.
The UI remains usable as plain text if those assets are unavailable.
"""

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/styles/github.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/highlight.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.12.0/languages/llvm.min.js"></script>
<style>__CSS__</style>
</head>
<body>
<header class="masthead">
  <div class="session-heading">
    <div class="eyebrow">ALIVE-NEXT EXPLORER</div>
    <h1>__TITLE__</h1>
  </div>
  <p id="summary"></p>
  <span id="verdict" class="badge"></span>
  <button id="view-counterexample" class="small-button" hidden>
    View counterexample ↗
  </button>
</header>

<div id="warning" class="warning" role="alert" hidden></div>

<main class="workspace">
  <aside class="panel trajectory-panel" aria-labelledby="trajectory-title">
    <header class="panel-heading trajectory-heading">
      <div>
        <div class="eyebrow">01 / SESSION HISTORY</div>
        <h2 id="trajectory-title">Trajectory</h2>
      </div>
      <span id="event-count" class="counter"></span>
    </header>

    <div class="trajectory-controls">
      <input id="search" type="search"
             placeholder="Search events, goals, rules…"
             aria-label="Search trajectory">

      <details class="filter-disclosure">
        <summary>Filter event types</summary>
        <div id="filters"></div>
      </details>

      <div class="playback">
        <button id="previous" class="icon-button"
                title="Previous event" aria-label="Previous event">←</button>
        <input id="scrubber" type="range" min="0" value="0"
               aria-label="Selected trajectory event">
        <button id="next" class="icon-button"
                title="Next event" aria-label="Next event">→</button>
      </div>

      <div class="playback-caption">
        <span id="position"></span>
        <span>← → to navigate</span>
      </div>

      <button id="inspect-event" class="small-button inspect-event-button">
        Inspect event ↗
      </button>
    </div>

    <ol id="timeline" aria-label="Trajectory events"></ol>
    <div id="no-events" class="empty" hidden>No matching events.</div>
  </aside>

  <div class="right-column">
    <section class="panel graph-panel" aria-labelledby="graph-title">
      <header class="panel-heading graph-heading" id="graph-heading">
        <div>
          <div class="eyebrow">02 / DERIVATION STRUCTURE</div>
          <h2 id="graph-title">Goal Tree</h2>
        </div>
        <span id="graph-position" class="counter"></span>
      </header>

      <div class="graph-toolbar">
        <label class="toggle">
          <input id="all-revisions" type="checkbox">
          Show every revision
        </label>

        <div class="legend" aria-label="Goal statuses">
          <span class="status open">Open</span>
          <span class="status split">Split</span>
          <span class="status proved">Proved</span>
          <span class="status refuted">Refuted</span>
        </div>

        <div class="zoom-controls">
          <button id="zoom-out" class="icon-button"
                  aria-label="Zoom out">−</button>
          <span id="zoom-value">100%</span>
          <button id="zoom-in" class="icon-button"
                  aria-label="Zoom in">+</button>
          <button id="fit" class="small-button">Fit</button>
        </div>
      </div>

      <div id="viewport" tabindex="0"
           aria-label="Goal graph. Scroll to navigate; select a state or transition to inspect it.">
        <div id="stage">
          <div id="canvas">
            <svg id="wires" class="wires"
                 xmlns="http://www.w3.org/2000/svg"
                 aria-label="Goal transitions"></svg>
            <div id="cards"></div>
          </div>
        </div>
      </div>

      <footer class="graph-footer">
        <span>Click a state or transition to inspect it</span>
        <span>Drag background to pan · Ctrl/⌘ + wheel to zoom</span>
      </footer>
    </section>
  </div>
</main>

<dialog id="inspector-dialog" aria-labelledby="dialog-title">
  <header class="panel-heading inspector-heading" id="inspector-heading">
    <div>
      <div class="eyebrow">SELECTED OBJECT / DETAILS</div>
      <h2 id="dialog-title">Inspector</h2>
    </div>
    <button id="close-dialog" class="small-button">
      Close ✕
    </button>
  </header>

  <nav class="inspector-tabs" aria-label="Inspector view">
    <button data-view="changes" aria-pressed="true">Changes</button>
    <button data-view="state" aria-pressed="false">Full state</button>
    <button data-view="counterexample" aria-pressed="false">Counterexample</button>
    <button data-view="raw" aria-pressed="false">Event JSON</button>
  </nav>

  <div id="dialog-content" class="inspector-content"></div>
</dialog>

<script id="data" type="application/json">__DATA__</script>
<script>__JS__</script>
</body>
</html>
"""


CSS = r"""
:root {
  color-scheme: light;
  --background: #f3f5fa;
  --surface: #ffffff;
  --text: #243047;
  --muted: #748096;
  --line: #e2e7f0;
  --purple: #7355c5;
  --purple-soft: #f2edfc;
  --blue: #3978b9;
  --blue-soft: #edf5fd;
  --green: #278466;
  --green-soft: #eaf7f1;
  --amber: #a57724;
  --amber-soft: #fcf4e4;
  --red: #ba5260;
  --red-soft: #fceef0;
  --shadow: 0 5px 20px #26345408, 0 1px 3px #26345405;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  color: var(--text);
  background: var(--background);
  font: 13px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
}
button, input { font: inherit; }
button { cursor: pointer; }
button, input { accent-color: var(--purple); }
button:focus-visible, input:focus-visible, summary:focus-visible,
#viewport:focus-visible, .graph-edge:focus-visible {
  outline: 3px solid #9a85dd;
  outline-offset: 3px;
}
button:disabled { opacity: .4; cursor: default; }
h1, h2, h3, p { margin: 0; }
h1 { font-size: 17px; font-weight: 650; }
h2 { font-size: 17px; font-weight: 700; letter-spacing: -.025em; }
h3 { font-size: 13px; font-weight: 650; }
.eyebrow {
  font-size: 9px;
  font-weight: 750;
  letter-spacing: .13em;
  opacity: .7;
}
.masthead {
  height: 76px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 22px;
}
.brand-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 1px solid #dfd6f5;
  border-radius: 13px;
  background: linear-gradient(140deg, #fff, #ece5fc);
  color: var(--purple);
  font-size: 34px;
}
.session-heading { min-width: 0; }
.session-heading h1 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#summary { margin-left: auto; color: var(--muted); font-size: 12px; }
.badge, .counter {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 11px;
  white-space: nowrap;
  background: #ffffffa8;
}
.warning {
  margin: 0 16px 10px;
  padding: 10px 14px;
  border: 1px solid #edcad0;
  border-radius: 10px;
  color: var(--red);
  background: var(--red-soft);
}
.workspace {
  height: calc(100dvh - 76px);
  min-height: 560px;
  padding: 0 16px 16px;
  display: grid;
  grid-template-columns: clamp(290px, 27vw, 410px) minmax(0, 1fr);
  gap: 14px;
}
body:has(.warning:not([hidden])) .workspace {
  height: calc(100dvh - 132px);
}
.panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 15px;
  box-shadow: var(--shadow);
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 12px 17px;
  border-bottom: 1px solid var(--line);
}
.trajectory-heading {
  color: #5f4a9b;
  background: linear-gradient(105deg, #eee8fa, #faf8fe);
}
.graph-heading {
  color: #356b99;
  background: linear-gradient(105deg, #e9f2fb, #f8fbfe);
}
.graph-heading.refuted {
  color: var(--red);
  background: linear-gradient(105deg, #f8e7eb, #fdf7f8);
}
.inspector-heading {
  color: #42746c;
  background: linear-gradient(105deg, #e9f4ef, #f8fcfa);
}
.inspector-heading.refuted {
  color: var(--red);
  background: linear-gradient(105deg, #f8e7eb, #fdf7f8);
}
.trajectory-panel { display: flex; flex-direction: column; }
.trajectory-controls { padding: 13px; border-bottom: 1px solid var(--line); }
#search {
  width: 100%;
  padding: 9px 11px;
  color: var(--text);
  background: #f8f9fc;
  border: 1px solid var(--line);
  border-radius: 8px;
}
.filter-disclosure { margin-top: 9px; font-size: 11px; color: var(--muted); }
summary { cursor: pointer; }
#filters { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 9px; }
#filters label {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  background: #f7f8fc;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--text);
}
.playback { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
#scrubber { flex: 1; min-width: 0; }
.playback-caption {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  color: var(--muted);
  font-size: 10px;
}
.icon-button, .small-button {
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text);
  background: #ffffffc9;
}
.icon-button { width: 29px; height: 28px; padding: 0; }
.small-button { padding: 5px 10px; font-size: 11px; }
.icon-button:hover, .small-button:hover { background: #f1eef8; }
#timeline {
  flex: 1;
  min-height: 0;
  overflow: auto;
  list-style: none;
  padding: 9px;
  margin: 0;
}
#timeline li { position: relative; margin-bottom: 4px; }
.event-button {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 8px;
  text-align: left;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text);
  background: transparent;
  cursor: pointer;
}
.event-button:hover { background: #f7f8fc; }
.event-button.selected {
  background: var(--purple-soft);
  border-color: #ddd2f3;
}
.event-number {
  flex-shrink: 0;
  width: 29px;
  padding: 3px 0;
  text-align: center;
  font: 10px/1.5 var(--mono);
  color: #8c95a7;
  background: #eef1f6;
  border-radius: 7px;
}
.selected .event-number { background: var(--purple); color: white; }
.event-text { flex: 1; min-width: 0; }
.event-top { display: flex; justify-content: space-between; gap: 8px; }
.event-kind { font-size: 12px; font-weight: 650; }
.event-time { color: var(--muted); font-size: 10px; white-space: nowrap; }
.event-description {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  margin-top: 3px;
  color: var(--muted);
  font: 10px/1.6 var(--mono);
}
.right-column {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.graph-panel, .inspector-panel { display: flex; flex-direction: column; }
.graph-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 13px;
  border-bottom: 1px solid var(--line);
  font-size: 11px;
}
.toggle { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.legend { display: flex; flex-wrap: wrap; gap: 5px; }
.status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 999px;
  font: 10px/1.5 ui-sans-serif, system-ui, sans-serif;
  white-space: nowrap;
}
.status::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.open { color: var(--blue); background: var(--blue-soft); }
.split { color: var(--amber); background: var(--amber-soft); }
.proved { color: var(--green); background: var(--green-soft); }
.refuted { color: var(--red); background: var(--red-soft); }
.historical { color: #8790a2; background: #f1f3f7; }
.zoom-controls { display: flex; align-items: center; gap: 5px; margin-left: auto; }
#zoom-value { width: 38px; text-align: center; color: var(--muted); }
#viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
  background-color: #fafbfe;
  background-image: radial-gradient(#dfe5ef 1px, transparent 1px);
  background-size: 18px 18px;
  cursor: grab;
}
#viewport.dragging { cursor: grabbing; user-select: none; }
#stage { position: relative; min-width: 100%; min-height: 100%; }
#canvas { position: absolute; transform-origin: top left; }
.wires { position: absolute; inset: 0; overflow: visible; }
.graph-edge { cursor: pointer; }
.edge-line { fill: none; stroke: #b7c2d4; stroke-width: 1.8; }
.edge-hit { fill: none; stroke: transparent; stroke-width: 18; }
.graph-edge:hover .edge-line, .graph-edge.selected .edge-line {
  stroke: var(--purple);
  stroke-width: 2.6;
}
.edge-label-bg { fill: #fafbfe; stroke: #e1e6ef; }
.edge-label { fill: #748096; font: 10px var(--mono); text-anchor: middle; }
.graph-edge:hover .edge-label,
.graph-edge.selected .edge-label { fill: var(--purple); }
.goal-card {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #dce3ee;
  border-top: 3px solid #81a7cc;
  border-radius: 12px;
  background: white;
  box-shadow: 0 4px 14px #24304709;
}
.goal-card[data-status="proved"] { border-top-color: #66a991; }
.goal-card[data-status="split"] { border-top-color: #cfac67; }
.goal-card[data-status="refuted"] { border-top-color: #d17c87; }
.goal-card[data-status="historical"] { border-top-color: #c4ccda; }
.goal-card.selected {
  border-color: #9d86d7;
  box-shadow: 0 0 0 3px #aa91df27, 0 6px 18px #654aa018;
}
.node-main {
  flex: 1;
  min-height: 0;
  display: block;
  width: 100%;
  padding: 8px 12px 6px;
  border: 0;
  text-align: left;
  color: inherit;
  background: transparent;
}
.node-main:hover { background: #fbfaff; }
.node-heading { display: flex; align-items: center; gap: 7px; }
.goal-name { font-size: 20px; font-weight: 750; line-height: 1.2; text-transform: uppercase; }
.revision-name, .goal-role { color: var(--muted); font-size: 10px; }
.node-heading .status { margin-left: auto; }
.node-pair { display: grid; grid-template-columns: 1fr 1fr; margin-top: 6px; }
.node-side { display: block; min-width: 0; }
.node-side + .node-side {
  margin-left: 10px;
  padding-left: 10px;
  border-left: 1px solid var(--line);
}
.side-label {
  display: flex;
  gap: 5px;
  align-items: center;
  font-size: 9px;
  font-weight: 750;
  letter-spacing: .06em;
  color: var(--muted);
}
.program-name { margin-left: auto; font: 10px var(--mono); color: #526783; }
.version-strip {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  min-height: 28px;
  overflow: auto;
  padding: 3px 10px;
  border-top: 1px solid #edf0f6;
  background: #fafbfe;
}
.version-chip, .hop-chip {
  flex-shrink: 0;
  border: 0;
  border-radius: 5px;
  padding: 2px 5px;
  background: transparent;
  color: var(--muted);
  font: 9px/1.5 var(--mono);
}
.version-chip { background: #eef1f7; }
.version-chip.current { color: #405a7c; font-weight: 700; }
.version-chip.selected, .hop-chip.selected {
  color: white;
  background: var(--purple);
}
.hop-chip:hover { background: #ece5f8; color: var(--purple); }
.version-caption { font-size: 10px; color: var(--muted); }
.split-junction {
  position: absolute;
  border: 1px solid #ddc997;
  border-radius: 10px;
  color: #926e2b;
  background: #fff9ed;
  box-shadow: 0 3px 10px #71582708;
  font-size: 11px;
}
.split-junction:hover, .split-junction.selected {
  border-color: var(--purple);
  color: var(--purple);
  background: var(--purple-soft);
}
.graph-footer {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 6px 13px;
  border-top: 1px solid var(--line);
  font-size: 10px;
  color: var(--muted);
}
.inspector-tabs {
  display: flex;
  gap: 4px;
  padding: 7px 13px;
  border-bottom: 1px solid var(--line);
}
.inspector-tabs button {
  border: 0;
  border-radius: 6px;
  padding: 5px 10px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
}
.inspector-tabs button[aria-pressed="true"] {
  background: #edf3f0;
  color: #356d5f;
  font-weight: 650;
}
.inspector-content { flex: 1; min-height: 0; overflow: auto; padding: 15px; }
.inspect-event-button {
  width: 100%;
  margin-top: 10px;
  padding: 7px 10px;
  color: var(--purple);
  border-color: #dfd6f2;
  background: #faf8fe;
}
.inspect-event-button:hover {
  background: var(--purple-soft);
}
#inspector-dialog > .panel-heading,
#inspector-dialog > .inspector-tabs {
  flex-shrink: 0;
}
.inspector-tabs { flex-wrap: wrap; }
.counterexample-action {
  color: var(--red);
  border-color: #edcad0;
  background: var(--red-soft);
}
.counterexample-action:hover {
  color: var(--red);
  background: #f8dfe4;
}
.counterexample-card {
  min-width: 0;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid #edcad0;
  border-radius: 10px;
  background: #fffafb;
}
.counterexample-card .selection-heading {
  margin-bottom: 8px;
}
.counterexample-note {
  margin: 8px 0 12px;
  color: var(--muted);
  font-size: 11px;
}
.counterexample-field {
  margin-top: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: white;
}
.counterexample-field-heading {
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  background: #f8f9fc;
  overflow-wrap: anywhere;
  color: var(--muted);
  font: 10px/1.5 var(--mono);
}
.counterexample-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.counterexample-payload {
  margin-top: 12px;
}
.counterexample-payload > summary {
  padding: 6px 0;
  color: var(--muted);
  font-size: 11px;
}
.counterexample-link {
  appearance: none;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--red);
  text-align: left;
  text-decoration: underline;
  text-decoration-color: #ba526066;
  text-underline-offset: 3px;
}
.counterexample-link:hover {
  color: var(--red);
  text-decoration-color: currentColor;
}
.event-select {
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  text-align: left;
}
.event-select:hover {
  color: var(--text);
}
.selection-heading { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
.selection-heading > div { flex: 1; min-width: 0; }
.selection-heading h3 { overflow-wrap: anywhere; }
.selection-description { margin-top: 4px; color: var(--muted); font-size: 11px; }
.pair-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.program-panel { min-width: 0; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.program-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  background: #f8f9fc;
  font-size: 11px;
}
.program-heading strong { font-size: 10px; letter-spacing: .05em; }
.program-heading .program-ref { font-family: var(--mono); }
.change-label { margin-left: auto; color: var(--muted); font-size: 10px; }
.change-label.changed { color: var(--purple); }
pre, .diff {
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  color: #46556d;
  font: 11px/1.7 var(--mono);
  white-space: pre;
  tab-size: 2;
}
/* Retain our spacing, wrapping, and diff-row backgrounds over the CDN theme. */
.syntax-code { font: inherit; }
.syntax-code.hljs {
  display: inline;
  padding: 0;
  overflow: visible;
  color: inherit;
  background: transparent;
}
.diff .hljs-addition, .diff .hljs-deletion { color: inherit; background: transparent; }
.diff { padding: 6px 0; }
.diff-line { min-height: 19px; padding: 0 12px; }
.diff-line.add { color: #256449; background: #eaf6ed; }
.diff-line.del { color: #a04855; background: #fbecee; }
.diff-line.hunk { color: #8471aa; background: #f5f1fc; }
.program-full { border-top: 1px solid var(--line); }
.program-full summary { padding: 7px 10px; color: var(--muted); font-size: 11px; }
.split-section-title {
  margin: 15px 0 7px;
  color: var(--muted);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .07em;
  text-transform: uppercase;
}
.split-explanation {
  padding: 9px 12px;
  border-radius: 8px;
  color: #856726;
  background: var(--amber-soft);
  font-size: 11px;
}
.empty { padding: 25px; text-align: center; color: var(--muted); }
.raw-json { border: 1px solid var(--line); border-radius: 9px; background: #fafbfe; }
dialog {
  width: min(1250px, 94vw);
  height: min(860px, 90dvh);
  padding: 0;
  border: 1px solid #d9e1eb;
  border-radius: 16px;
  color: var(--text);
  background: white;
  box-shadow: 0 25px 100px #17233838;
}
dialog[open] { display: flex; flex-direction: column; }
dialog::backdrop { background: #24304760; backdrop-filter: blur(4px); }

@media (max-width: 1150px) {
  .legend { display: none; }
  #summary { display: none; }
  #verdict { margin-left: auto; }
}
@media (max-width: 850px) {
  .masthead { padding: 10px 14px; }
  .workspace, body:has(.warning:not([hidden])) .workspace {
    height: auto;
    min-height: 0;
    grid-template-columns: 1fr;
    padding: 0 10px 10px;
  }
  .trajectory-panel { height: 330px; }
  .right-column {
    grid-template-rows: minmax(490px, 70dvh);
  }
  .pair-grid { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: no-preference) {
  button { transition: background .12s, border-color .12s, box-shadow .12s; }
}
"""


JS = r"""
"use strict";

const data = JSON.parse(document.getElementById("data").textContent);
const $ = id => document.getElementById(id);
const byId = new Map(data.nodes.map(node => [node.id, node]));
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
  const gids = [...new Set(
    event.entries.flatMap(entry =>
      (entry.effects || [])
        .filter(effect =>
          effect.effect === "refuted" &&
          typeof effect.gid === "string"
        )
        .map(effect => effect.gid)
    )
  )];

  if (!gids.length) return [];

  /*
   * Only attach evidence to revisions confirmed refuted in this snapshot.
   * With a broken replay, keep event evidence accessible but avoid claiming
   * a validated association with the graph.
   */
  const nodeIds = data.error ? [] : gids.flatMap(gid => {
    const goal = data.snapshots[index]?.[gid];
    return goal?.status === "refuted" && byId.has(goal.node)
      ? [goal.node]
      : [];
  });

  return [{
    at: index,
    gids,
    nodeIds,
    entries: event.entries,
  }];
});

const counterexampleByEvent = new Map(
  counterexamples.map(record => [record.at, record])
);

function counterexamplesForNode(nodeId) {
  return counterexamples.filter(record =>
    record.at <= at && record.nodeIds.includes(nodeId)
  );
}

function counterexamplesForSelection() {
  if (!selection) return [];

  if (selection.type === "event") {
    const direct = counterexampleByEvent.get(selection.at);
    if (direct) return [direct];

    const event = data.events[selection.at];
    const isCounterexampleVerdict = event?.entries.some(entry =>
      entry.kind === "verdict" && entry.outcome === "counterexample"
    );

    if (isCounterexampleVerdict) {
      // A refuted child alone is not evidence for the final root verdict.
      return counterexamples.filter(record =>
        record.at <= selection.at && record.gids.includes("g1")
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
    tab.setAttribute(
      "aria-pressed",
      String(tab.dataset.view === inspectorView)
    );

    if (tab.dataset.view === "counterexample") {
      tab.hidden = count === 0;
      tab.textContent = count
        ? `Counterexample (${count})`
        : "Counterexample";
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
  const lines = Object.keys(observations).map(key => {
    const shown = typeof observations[key] === "string"
      ? observations[key]
      : JSON.stringify(observations[key]);
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
    result.push({path: `${path}["observations"]`, text: sideText(value)});
    return result;
  }

  // Include input even when it isn't a multiline string.
  // Preserve structured values rather than extracting guessed fields.
  if (isInput) {
    result.push({
      path,
      language: typeof value === "string" ? null : "json",
      text: typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2),
    });
    return result;
  }

  if (typeof value === "string") {
    if (/[\r\n]/.test(value)) {
      result.push({path, text: value});
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      multilineFields(item, `${path}[${index}]`, result)
    );
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      multilineFields(
        item,
        `${path}[${JSON.stringify(key)}]`,
        result
      );
    }
  }

  return result;
}

function counterexampleFieldLabel(path) {
  if (/\["inputs?"\]$/.test(path)) {
    return "INPUT (LLUBI)";
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
  const isInput = field => /\["inputs?"\]$/.test(field.path);

  // Source and target share the same input. Display it once, first.
  const input = collected.find(isInput);
  const fields = [
    ...(input ? [input] : []),
    ...collected.filter(field => !isInput(field)),
  ];

  for (const field of fields) {
    const section = el("section", "counterexample-field");
    const heading = el(
      "div",
      "counterexample-field-heading",
      counterexampleFieldLabel(field.path)
    );
    heading.title = field.path;

    section.append(
      heading,
      field.language
        ? codeBlock(field.text, field.language, "counterexample-text")
        : el("pre", "counterexample-text", field.text)
    );
    body.append(section);
  }

  const raw = el("details", "counterexample-payload");
  // With no multiline fields, show the complete payload immediately.
  raw.open = fields.length === 0;
  raw.append(
    el("summary", "", "Complete recorded event payload"),
    codeBlock(
      JSON.stringify(entries, null, 2),
      "json",
      "raw-json counterexample-text"
    )
  );
  body.append(raw);

  return body;
}

function counterexampleView() {
  const body = el("div");
  const records = counterexamplesForSelection();

  if (!records.length) {
    body.append(el(
      "div",
      "empty",
      "No counterexample-reporting event is linked to this selection " +
      "at the current trajectory position."
    ));

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
          "a refuted effect are not automatically classified as counterexamples."
        ),
        recordedPayloadView(event.entries)
      );
    }

    return body;
  }

  body.append(el(
    "p",
    "counterexample-note",
    "Complete recorded event data. Multiline fields are expanded for " +
    "readability; the original payload is preserved below. " +
    "These records describe the check that refuted the run, whatever " +
    "tool (llubi or alive2) reported it."
  ));

  for (const record of records) {
    const card = el("section", "counterexample-card");
    const revisions = record.nodeIds.map(nodeId => {
      const node = byId.get(nodeId);
      return `${node.gid} v${revisionOf(node)}`;
    });

    card.append(
      selectionHeading(
        `Counterexample · ${record.gids.join(", ")}`,
        `Reported at event ${record.at} · ${data.events[record.at].kind}` +
          (revisions.length ? ` · ${revisions.join(", ")}` : ""),
        record.at
      ),
      recordedPayloadView(record.entries)
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
 * This avoids mixing separate incarnations if an unsplit removes children
 * and a later split reuses their goal IDs.
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
  const side = {src: "SRC", tgt: "TGT", both: "BOTH"}[node.side];
  // A commit records a transaction, so the edge says what it was. A
  // strengthen's attributes stay in the footers, so its edge says one word.
  let move = node.note || node.tool;
  if (node.tool === "commit") move = "transaction";
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

const kinds = [...new Set(data.events.map(event => event.kind))];

$("filters").append(...kinds.map(kind => {
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
}));

function drawTimeline() {
  const query = $("search").value.trim().toLowerCase();
  let visible = 0;
  const fragment = document.createDocumentFragment();

  data.events.forEach((event, index) => {
    if (hiddenKinds.has(event.kind)) return;
    if (query && !(
      event.label + " " + JSON.stringify(event.entries)
    ).toLowerCase().includes(query)) return;

    visible++;
    const row = el("li");

    // A reported counterexample has two independent actions:
    //   kind → open counterexample
    //   description → select trajectory event
    // Which tool reported it does not matter: a report_cex row and one
    // from a check or the start check read the same.
    const reported = event.kind === "report_cex" ||
      event.entries.some(entry => entry.tool === "report_cex") ||
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

    const number = el(
      "span",
      "event-number",
      String(index).padStart(3, "0")
    );
    const body = el("span", "event-text");
    const top = el("span", "event-top");

    if (reported) {
      const kind = button(
        event.kind,
        "event-kind counterexample-link",
        () => openCounterexample(index)
      );
      kind.title = "Open counterexample";
      kind.setAttribute(
        "aria-label",
        `Open counterexample reported at event ${index}`
      );
      top.append(kind);
    } else {
      top.append(el("span", "event-kind", event.kind));
    }

    if (event.ms !== undefined) {
      top.append(el("span", "event-time", `${event.ms} ms`));
    }

    const description = reported
      ? button(
          event.label,
          "event-description event-select",
          () => go(index)
        )
      : el("span", "event-description", event.label);

    if (reported) {
      description.title = event.label;
      description.setAttribute(
        "aria-label",
        `Select event ${index}: ${event.label}`
      );
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
    $("timeline").querySelector(".selected")?.scrollIntoView({block: "nearest"});
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
  const children = new Map(Object.keys(snapshot).map(gid => [gid, []]));
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
    const ownHeight = nodes.length * CARD_H +
      Math.max(0, nodes.length - 1) * STEP_GAP;

    const childWidth = kids.reduce((sum, child) => sum + child.width, 0) +
      Math.max(0, kids.length - 1) * SIBLING_GAP;

    return {
      gid, goal, history, nodes, kids, ownHeight,
      width: Math.max(CARD_W, childWidth),
      height: ownHeight + (
        kids.length
          ? 48 + JUNCTION_H + 86 + Math.max(...kids.map(child => child.height))
          : 0
      ),
    };
  }

  return roots.map(build);
}

function splitSelection(plan) {
  const children = plan.kids.map(child => child.history[0]).filter(Boolean);
  return {
    type: "split",
    gid: plan.gid,
    nodeId: children[0]?.parent || plan.goal.node,
    children: children.map(node => node.id),
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
    svg("path", {d: path, class: "edge-hit"}),
    svg("path", {d: path, class: "edge-line", "marker-end": "url(#arrow)"})
  );

  if (label) {
    const text = clip(label, 35);
    const width = text.length * 6.2 + 18;
    const x = (x1 + x2) / 2;

    group.append(svg("rect", {
      x: x - width / 2,
      y: middle - 12,
      width,
      height: 24,
      rx: 7,
      class: "edge-label-bg",
    }));

    const caption = svg("text", {
      x,
      y: middle + 3.5,
      class: "edge-label",
    });
    caption.textContent = text;
    group.append(caption);
  }

  group.onclick = () => select(value);
  group.onkeydown = event => {
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
  const selected = node.id === picked ||
    (!showAll && plan.history.some(version => version.id === picked));

  const card = el("article", "goal-card" + (selected ? " selected" : ""));
  card.dataset.status = status;
  Object.assign(card.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${CARD_W}px`,
    height: `${CARD_H}px`,
  });

  const main = button("", "node-main", () => select({type: "node", nodeId: node.id}));
  main.setAttribute(
    "aria-label",
    `${node.gid} revision ${revisionOf(node)}, ${status}, ` +
    `source ${short(node.src)}, target ${short(node.tgt)}`
  );

  const heading = el("span", "node-heading");
  heading.append(
    el("span", "goal-name", node.gid),
    el("span", "revision-name", `v${revisionOf(node)}`)
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
    const info = button(
      `Event ${node.at} · ${clip(moveOf(node), 42)}`,
      "hop-chip",
      () => select({type: node.parent ? "step" : "node", nodeId: node.id})
    );
    info.title = moveOf(node);
    strip.append(info);
  } else {
    plan.history.forEach((version, index) => {
      if (index) {
        const hopValue = {type: "step", nodeId: version.id};
        const hop = button(
          ({src: "S", tgt: "T", both: "S+T"}[version.side] || "") + " →",
          "hop-chip" + (isSelectedEdge(hopValue) ? " selected" : ""),
          () => select(hopValue)
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
        () => select({type: "node", nodeId: version.id})
      );
      chip.title = `${short(version.src)} | ${short(version.tgt)} · event ${version.at}`;
      strip.append(chip);
    });
  }

  const witnesses = counterexamplesForNode(node.id);

  if (witnesses.length) {
    const latest = witnesses[witnesses.length - 1];
    const action = button(
      "CE ↗",
      "hop-chip counterexample-action",
      () => openCounterexample(latest.at)
    );
    action.title = `View counterexample reported at event ${latest.at}`;
    action.setAttribute("aria-label", action.title);
    strip.append(action);
  }

  card.append(main, strip);
  $("cards").append(card);

  if (!showAll) {
    requestAnimationFrame(() => {
      const target = strip.querySelector(".version-chip.selected") ||
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
      addEdge(
        center, top - STEP_GAP,
        center, top,
        edgeCaption(node),
        {type: "step", nodeId: node.id}
      );
    }
  });

  if (!plan.kids.length) return;

  const value = splitSelection(plan);
  const junctionY = y + plan.ownHeight + 48;
  const junction = button(
    `◇ Split · ${plan.kids.length} subgoals`,
    "split-junction" + (isSelectedEdge(value) ? " selected" : ""),
    () => select(value)
  );
  Object.assign(junction.style, {
    left: `${center - JUNCTION_W / 2}px`,
    top: `${junctionY}px`,
    width: `${JUNCTION_W}px`,
    height: `${JUNCTION_H}px`,
  });
  $("cards").append(junction);

  addEdge(center, y + plan.ownHeight, center, junctionY, "", value);

  const totalWidth = plan.kids.reduce((sum, child) => sum + child.width, 0) +
    (plan.kids.length - 1) * SIBLING_GAP;
  let childX = center - totalWidth / 2;
  const childY = junctionY + JUNCTION_H + 86;

  for (const child of plan.kids) {
    const childCenter = childX + child.width / 2;
    addEdge(
      center, junctionY + JUNCTION_H,
      childCenter, childY,
      [child.goal.role, child.gid].filter(Boolean).join(" · "),
      value
    );
    placePlan(child, childX, childY);
    childX += child.width + SIBLING_GAP;
  }
}

function drawGraph() {
  const forest = buildForest();
  const snapshot = currentSnapshot();
  const open = Object.values(snapshot).filter(goal => goal.status === "open").length;

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
  marker.append(svg("path", {d: "M 0 0 L 10 5 L 0 10 z", fill: "#aebbd0"}));
  defs.append(marker);
  $("wires").append(defs);

  graphWidth = Math.max(
    400,
    PAD * 2 + forest.reduce((sum, plan) => sum + plan.width, 0) +
      Math.max(0, forest.length - 1) * SIBLING_GAP
  );
  graphHeight = Math.max(180, PAD * 2 + Math.max(0, ...forest.map(plan => plan.height)));

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
  if (!highlighter || code.dataset.highlighted ||
      !highlighter.getLanguage(language)) return;

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
    const kind = line.startsWith("@") ? "hunk" :
      line.startsWith("+") ? "add" :
      line.startsWith("-") ? "del" : "";
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
      caption = !sameGoal ? "Initial state" :
        changed ? `+${info.adds} −${info.dels}` : "Unchanged";
    }

    heading.append(
      el("strong", "", side === "src" ? "SOURCE" : "TARGET"),
      name,
      el("span", "change-label" + (changes && changed ? " changed" : ""), caption)
    );
    panel.append(heading);

    if (changes && changed) {
      panel.append(
        diffBlock(info.lines),
        fullDisclosure(`Before · ${short(parent[side])}`, parent[side]),
        fullDisclosure(`After · ${short(node[side])}`, node[side])
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
  text.append(
    el("h3", "", title),
    el("p", "selection-description", description)
  );
  heading.append(text);

  if (eventIndex !== at) {
    heading.append(button(
      `Jump to event ${eventIndex} →`,
      "small-button",
      () => {
        $("inspector-dialog").close();
        go(eventIndex);
      }
    ));
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
    body.append(el(
      "div",
      "split-explanation",
      "Both subgoals are required: this replay marks the parent proved when all children are proved. " +
      "Child programs are new states, not rewrite diffs against the parent."
    ));

    if (node) {
      body.append(
        el("div", "split-section-title", `Input · ${node.gid} v${revisionOf(node)}`),
        pairView(node, true)
      );
    }

    for (const childId of selection.children) {
      const child = byId.get(childId);
      if (!child) continue;
      const role = snapshot[child.gid]?.role || child.tool;
      body.append(
        el("div", "split-section-title", `Output · ${child.gid} · ${role}`),
        pairView(child, true)
      );
    }
    return body;
  }

  if (node) {
    const unchangedEvent = selection.type === "event" && node.at !== at;
    if (unchangedEvent) {
      body.append(el(
        "p",
        "selection-description",
        `Focused state: ${node.gid} v${revisionOf(node)}, created at event ${node.at}. ` +
        "This event did not create that revision."
      ));
    }
    body.append(pairView(node, unchangedEvent));
  } else {
    body.append(el("div", "empty", "This event has no focused goal state."));
  }

  if (selection.type === "event") {
    const raw = el("details", "program-full");
    raw.append(
      el("summary", "", "Event payload"),
      codeBlock(JSON.stringify(event?.entries || [], null, 2), "json")
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

  zoom = Math.max(.08, Math.min(2, value));
  applyZoom();

  const newLeft = parseFloat($("canvas").style.left) || 0;
  viewport.scrollLeft = worldX * zoom + newLeft - viewport.clientWidth / 2;
  viewport.scrollTop = worldY * zoom - viewport.clientHeight / 2;
}

function fitGraph() {
  const viewport = $("viewport");
  setZoom(Math.min(
    1,
    (viewport.clientWidth - 20) / graphWidth,
    (viewport.clientHeight - 20) / graphHeight
  ));
  viewport.scrollLeft = 0;
  viewport.scrollTop = 0;
}

let dragging = null;
$("viewport").addEventListener("pointerdown", event => {
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

$("viewport").addEventListener("pointermove", event => {
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

$("viewport").addEventListener("wheel", event => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  setZoom(zoom * Math.exp(-event.deltaY * .004));
}, {passive: false});

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

document.addEventListener("keydown", event => {
  if ($("inspector-dialog").open || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest(
    "input, textarea, select, button, summary, a, [contenteditable]"
  )) return;

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

const goalsEver = new Set(data.nodes.map(node => node.gid));
$("summary").textContent =
  `${data.events.length} events · ${goalsEver.size} goals · ${data.nodes.length} states`;

$("verdict").textContent = `Final: ${data.verdict}`;
$("verdict").className = "badge " + ({
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
    event.entries.some(entry =>
      entry.kind === "verdict" &&
      entry.outcome === "counterexample"
    )
      ? index
      : found,
  -1
);

const rootCounterexamples = counterexamples.filter(record =>
  record.gids.includes("g1")
);

const latestRootCounterexample =
  rootCounterexamples[rootCounterexamples.length - 1];

const finalCounterexampleAt = counterexampleVerdictAt >= 0
  ? counterexampleVerdictAt
  : latestRootCounterexample?.at;

const counterexampleButton = $("view-counterexample");

if (
  data.verdict === "counterexample" &&
  finalCounterexampleAt !== undefined
) {
  counterexampleButton.hidden = false;
  counterexampleButton.classList.add("counterexample-action");
  counterexampleButton.onclick = () =>
    openCounterexample(finalCounterexampleAt);
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
"""
