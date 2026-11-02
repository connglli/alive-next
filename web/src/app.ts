import { detailsView } from "./details.ts";
import { download } from "./download.ts";
import { examples } from "./examples.ts";
import { highlight } from "./highlight.ts";
import {
  type Budget,
  DEFAULT_BUDGET,
  INPUT_BYTES,
  INPUT_LABEL,
  MAX_TIMEOUT_MS,
  TIMEOUT_SECONDS,
  validateBudget,
} from "./limits.ts";
import type {
  Execution,
  ProcessResult,
  ReportSource,
  Standing,
  Verdict,
  WorkerMessage,
} from "./protocol.ts";
import { requestReport } from "./report.ts";
import { Runtime } from "./runtime.ts";

interface Check extends ProcessResult {
  checker: "alive2" | "llops respected" | "llops reshaped";
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element ${id}`);
  return found as T;
}

const editor = element<HTMLTextAreaElement>("ir");
const lines = element<HTMLPreElement>("lines");
const run = element<HTMLButtonElement>("run");
const stop = element<HTMLButtonElement>("stop");
const sample = element<HTMLSelectElement>("examples");
const output = element<HTMLPreElement>("output");
const timeout = element<HTMLSelectElement>("budget");
const customTimeout = element<HTMLInputElement>("custom-budget");
const cuts = element<HTMLInputElement>("cuts");
const unfolds = element<HTMLInputElement>("unfolds");
const showDetails = element<HTMLButtonElement>("show-details");
const saveSession = element<HTMLButtonElement>("save-session");
const saveError = element("save-error");
let saving: ReturnType<typeof requestReport> | undefined;
const details = detailsView(
  element<HTMLDialogElement>("details"),
  element<HTMLIFrameElement>("details-frame"),
  element("details-status"),
);
let report: ReportSource = { trajectory: [], programs: {} };
showDetails.onclick = () => details.open(report);
element("close-details").onclick = () => details.close();

function saveControl() {
  saveSession.disabled = !report.trajectory.length || saving !== undefined;
  saveSession.textContent = saving ? "Saving…" : "Save";
}

saveSession.onclick = async () => {
  saveError.hidden = true;
  let current: ReturnType<typeof requestReport> | undefined;
  try {
    current = requestReport({ kind: "save", source: report, module: editor.value });
    saving = current;
    saveControl();
    const response = await current.result;
    if (saving !== current) return;
    if (!("archive" in response)) throw new Error("Cannot read the session archive");
    download(new Blob([response.archive], { type: "application/zip" }), "alive-next-session.zip");
  } catch (error) {
    if (saving === current) {
      saveError.textContent = String(error instanceof Error ? error.message : error);
      saveError.hidden = false;
    }
  } finally {
    if (saving === current) {
      saving = undefined;
      saveControl();
    }
  }
};

// Use the same defaults and bounds as the worker's budget validation.
for (const seconds of TIMEOUT_SECONDS)
  timeout.add(new Option(`${seconds} s`, String(seconds * 1000)));
timeout.add(new Option("Custom…", "custom"));
timeout.value = String(DEFAULT_BUDGET.ms);
customTimeout.value = String(DEFAULT_BUDGET.ms / 1000);
customTimeout.max = String(MAX_TIMEOUT_MS / 1000);
cuts.value = String(DEFAULT_BUDGET.cuts);
unfolds.value = String(DEFAULT_BUDGET.unfolds);
cuts.max = unfolds.max = String(Number.MAX_SAFE_INTEGER);

function timeoutControl() {
  const custom = timeout.value === "custom";
  element("custom-budget-control").hidden = !custom;
  customTimeout.disabled = busy || !custom;
}

timeout.onchange = () => {
  timeoutControl();
  if (timeout.value === "custom") customTimeout.focus();
};

let worker: Worker | undefined;
let busy = false;
let started = 0;
let deadline: ReturnType<typeof setTimeout> | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let state: Standing = { goals: [] };
const checks: Check[] = [];
const runtime = new Runtime((message) => {
  if (busy) status("running", "Running", message);
});

function status(kind: string, title: string, detail: string) {
  element("status").className = `status ${kind}`;
  element("verdict").textContent = title;
  element("status-detail").textContent = detail;
}

function release() {
  worker?.terminate();
  worker = undefined;
  runtime.cancel();
  controls(false);
  element<HTMLDialogElement>("inspector").close();
}

function clearResults() {
  details.close();
  saving?.cancel();
  saving = undefined;
  report = { trajectory: [], programs: {} };
  saveControl();
  saveError.hidden = true;
  showDetails.disabled = true;
  checks.length = 0;
  element("checks").replaceChildren();
  element("check-count").textContent = "0";
  element("no-checks").hidden = false;
  element("elapsed").textContent = "Ctrl/⌘ + Enter";
  renderTree({ goals: [] });
}

let editRevision = 0;

// Results belong to one input revision, including reads still waiting on a file.
function changed() {
  editRevision++;
  release();
  clearResults();
  updated();
  status("ready", "Ready", "Run to check this input.");
  output.textContent = "; Does @tgt refine @src?\n; Run to check this input.";
  element("activity").textContent = "No undef · poison supported";
}

function updated() {
  // The extra empty line keeps the overlay aligned with a trailing editor line.
  highlight(element("highlight"), `${editor.value}\n`);
  lines.textContent = Array.from({ length: editor.value.split("\n").length }, (_, i) =>
    String(i + 1),
  ).join("\n");
  element("size").textContent =
    `${new TextEncoder().encode(editor.value).length.toLocaleString()} bytes`;

  try {
    localStorage.setItem("alive-next-ir", editor.value);
  } catch {
    /* Storage may be disabled. */
  }

  synchronizeEditor();
}

// The editable text, syntax overlay and gutter must share scroll offsets.
function synchronizeEditor() {
  const paint = element("highlight");
  paint.style.right = `${editor.offsetWidth - editor.clientWidth}px`;
  paint.style.bottom = `${editor.offsetHeight - editor.clientHeight}px`;
  paint.scrollTop = editor.scrollTop;
  paint.scrollLeft = editor.scrollLeft;
  lines.style.height = `${editor.clientHeight}px`;
  lines.scrollTop = editor.scrollTop;
}

function controls(running: boolean) {
  busy = running;
  run.disabled = running;
  stop.disabled = !running;
  editor.readOnly = running;
  sample.disabled = running;
  element<HTMLButtonElement>("load").disabled = running;
  timeout.disabled = cuts.disabled = unfolds.disabled = running;
  timeoutControl();

  if (!running) {
    clearTimeout(deadline);
    clearInterval(ticker);
  }
}

function show(view: string) {
  for (const name of ["result", "checks", "goals"]) element(`view-${name}`).hidden = name !== view;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  if (view === "goals") renderTree(state);
}

function renderTree(next: Standing) {
  state = next;
  element("goal-count").textContent = String(state.goals.length);
  // Retain progress while hidden, and defer rebuilding the goal buttons.
  if (element("view-goals").hidden) return;

  const target = element("goals");
  target.replaceChildren();
  const goals = new Map(state.goals.map((goal) => [goal.id, goal]));
  for (const goal of state.goals) {
    let depth = 0,
      parent = goal.parent;
    while (parent && depth < state.goals.length) {
      depth++;
      parent = goals.get(parent)?.parent;
    }

    const button = document.createElement("button");
    button.className = `goal ${goal.status}`;
    button.style.setProperty("--indent", `${Math.min(depth, 8) * 18}px`);
    button.textContent = `${goal.id}${goal.role ? ` / ${goal.role}` : " / root"}`;
    const label = document.createElement("small");
    label.textContent = goal.status;
    button.append(label);
    button.disabled = !worker;
    button.onclick = () => worker?.postMessage({ type: "inspect", gid: goal.id });
    target.append(button);
  }
}

function addCheck(request: Execution, result: ProcessResult) {
  // Trace certification attempts, including refusals, without logging IR edits or analysis.
  const command = request.args[0];
  const checker: Check["checker"] | undefined =
    request.tool === "alive-tv"
      ? "alive2"
      : command === "respected" || command === "reshaped"
        ? `llops ${command}`
        : undefined;
  if (!checker) return;

  checks.push({ ...result, checker });
  element("check-count").textContent = String(checks.length);
  element("no-checks").hidden = true;

  const item = document.createElement("li");
  const button = document.createElement("button");
  const counts = /Summary:\s*([\s\S]*)/.exec(result.stdout)?.[1]?.trim();
  const label = document.createElement("span");
  label.textContent = `#${checks.length} ${checker}${result.exit ? ` · exit ${result.exit}` : ""}`;
  const time = document.createElement("span");
  time.textContent = `${Math.round(result.ms)} ms`;
  button.append(label, time);
  if (counts) button.title = counts;

  const raw = document.createElement("pre");
  raw.hidden = true;
  raw.textContent = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
  button.onclick = () => {
    raw.hidden = !raw.hidden;
  };
  item.append(button, raw);
  element("checks").append(item);
}

function finished(verdict: Verdict) {
  // Keep the completed session worker available for goal inspection.
  controls(false);
  const proved = state.goals.filter((goal) => goal.status === "proved").length;
  const open = state.goals.filter((goal) => goal.status === "open").length;
  const titles = { verified: "Verified", counterexample: "Refuted", unknown: "Unknown" };
  const detail =
    verdict === "verified"
      ? "@tgt refines @src. Every remaining goal is proved."
      : verdict === "counterexample"
        ? "alive2 refuted the original pair. See its counterexample below."
        : "No conclusion. Open goals remain within this search budget.";
  status(verdict, titles[verdict], detail);

  const evidence =
    verdict === "counterexample"
      ? [...checks]
          .reverse()
          .find(
            (check) =>
              check.checker === "alive2" &&
              /^\s*[1-9]\d* incorrect transformations$/m.test(check.stdout),
          )
      : checks.at(-1);
  const fallback =
    verdict === "verified" ? "The goal closed by structural identity." : "No check completed.";
  output.textContent = `${proved} proved goals · ${open} open goals · ${checks.length} checks\n\n${evidence ? `Last ${evidence.checker} check:\n\n${evidence.stdout}` : fallback}`;
  show("result");
}

function failure(message: string) {
  release();
  status("error", "Error", "The input or checker could not complete the run.");
  output.textContent = message;
  renderTree(state);
  show("result");
}

function cancel(reason: string) {
  if (!busy) return;
  release();
  status("unknown", "Unknown", reason);
  output.textContent = `${reason}\nNo verification or refutation is claimed.\n\n${checks.length} checks completed.`;
  renderTree(state);
  show("result");
}

function start() {
  if (busy) return;

  for (const input of [cuts, unfolds, ...(timeout.value === "custom" ? [customTimeout] : [])])
    if (!input.reportValidity()) return;

  let budget: Budget;
  try {
    budget = validateBudget({
      ms:
        timeout.value === "custom"
          ? Math.round(customTimeout.valueAsNumber * 1000)
          : Number(timeout.value),
      cuts: cuts.valueAsNumber,
      unfolds: unfolds.valueAsNumber,
    });
  } catch (error) {
    failure(String(error instanceof Error ? error.message : error));
    return;
  }

  release();
  clearResults();
  if (new TextEncoder().encode(editor.value).length > INPUT_BYTES) {
    failure(`The input limit is ${INPUT_LABEL}.`);
    return;
  }

  let current: Worker;
  try {
    current = new Worker(new URL(SEARCH_WORKER_FILE, import.meta.url), { type: "module" });
  } catch (error) {
    failure(String(error instanceof Error ? error.message : error));
    return;
  }

  worker = current;
  controls(true);
  status("running", "Running", "Preparing the refinement search…");
  output.textContent = "Running alive-simple…";
  show("result");

  // The page's deadline includes checker loading and can interrupt blocked Wasm.
  started = performance.now();
  deadline = setTimeout(() => cancel("The run reached its wall-clock budget."), budget.ms);
  ticker = setInterval(() => {
    element("elapsed").textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
  }, 100);

  current.onerror = (event) => {
    if (worker === current) failure(event.message);
  };

  current.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    // Check worker identity again after awaits: Stop or an edit may replace it.
    if (worker !== current) return;

    const message = event.data;
    if (message.type === "program") {
      report.programs[message.hash] = message.text;
    } else if (message.type === "trajectory") {
      report.trajectory.push(message.line);
      showDetails.disabled = false;
      saveControl();
    } else if (message.type === "exec") {
      try {
        const result = await runtime.execute(message.id, message.request);
        if (worker !== current) return;

        addCheck(message.request, result);
        current.postMessage({ type: "execution", id: message.id, result });
      } catch (error) {
        if (worker === current)
          current.postMessage({
            type: "execution",
            id: message.id,
            error: String(error instanceof Error ? error.message : error),
          });
      }
    } else if (message.type === "kill") runtime.kill(message.id);
    else if (message.type === "progress") {
      renderTree(message.state);
      element("activity").textContent = `Searching · ${message.activity}`;
    } else if (message.type === "result") {
      renderTree(message.state);
      finished(message.verdict);
      element("activity").textContent = "Search complete";
    } else if (message.type === "error") failure(message.message);
    else if (message.type === "inspection") {
      element("inspect-title").textContent = `Goal ${message.gid}`;
      highlight(element("inspect-src"), message.src);
      highlight(element("inspect-tgt"), message.tgt);

      const dialog = element<HTMLDialogElement>("inspector");
      if (!dialog.open) dialog.showModal();
    }
  };

  current.postMessage({ type: "run", module: editor.value, budget });
}

// Restore a local draft when storage is available, otherwise start with an example.
for (const name of Object.keys(examples)) {
  const option = document.createElement("option");
  option.textContent = name;
  sample.append(option);
}

let draft: string | null = null;
try {
  draft = localStorage.getItem("alive-next-ir");
} catch {
  /* Storage may be disabled. */
}

editor.value = draft ?? examples["Strength reduction"];
timeoutControl();
element("limit").textContent = `${INPUT_LABEL} input limit`;
updated();

sample.onchange = () => {
  if (sample.value in examples) {
    editor.value = examples[sample.value as keyof typeof examples];
    changed();
  }
};

editor.oninput = changed;
editor.onscroll = synchronizeEditor;
new ResizeObserver(synchronizeEditor).observe(editor);
editor.onkeydown = (event) => {
  if (event.key === "Tab" && !busy) {
    event.preventDefault();
    editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input"));
  }
};

run.onclick = start;
stop.onclick = () => cancel("Stopped by user.");
document.onkeydown = (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    start();
  }
};

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
  button.onclick = () => show(button.dataset.view ?? "result");
element("close-inspector").onclick = () => element<HTMLDialogElement>("inspector").close();

element("load").onclick = () => element<HTMLInputElement>("file").click();
element<HTMLInputElement>("file").onchange = async () => {
  const file = element<HTMLInputElement>("file").files?.[0];
  if (!file) return;

  const revision = ++editRevision;
  if (file.size > INPUT_BYTES) {
    failure(`The input limit is ${INPUT_LABEL}.`);
    return;
  }

  try {
    const text = await file.text();
    // A slow file read must not overwrite a newer edit or selected example.
    if (revision !== editRevision) return;

    editor.value = text;
    changed();
  } catch (error) {
    if (revision === editRevision) failure(String(error));
  }
};

element("save").onclick = () => {
  download(new Blob([editor.value], { type: "text/plain" }), "module.ll");
};

const splitter = element("splitter");
let left = 50;

function resize(value: number) {
  left = Math.max(25, Math.min(75, value));
  element("workspace").style.setProperty("--left", `${left}%`);
  splitter.setAttribute("aria-valuenow", String(Math.round(left)));
}

splitter.onpointerdown = (event) => {
  splitter.setPointerCapture(event.pointerId);
};

splitter.onpointermove = (event) => {
  if (splitter.hasPointerCapture(event.pointerId)) {
    const box = element("workspace").getBoundingClientRect();
    resize(((event.clientX - box.left) / box.width) * 100);
  }
};

splitter.onkeydown = (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    resize(left + (event.key === "ArrowLeft" ? -2 : 2));
  }
};

if (location.protocol === "file:")
  failure("Serve this directory over HTTP: python3 -m http.server 8000 --directory web/dist");
