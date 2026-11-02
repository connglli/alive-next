import { INPUT_LABEL } from "../limits.ts";
import { type Check, evidence, type RunStatus, type SessionState } from "../state.ts";
import { element } from "./dom.ts";

function checkRow(check: Check, index: number) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  const counts = /Summary:\s*([\s\S]*)/.exec(check.stdout)?.[1]?.trim();
  const label = document.createElement("span");
  label.textContent = `#${index + 1} ${check.checker}${check.exit ? ` · exit ${check.exit}` : ""}`;
  const time = document.createElement("span");
  time.textContent = `${Math.round(check.ms)} ms`;
  button.append(label, time);
  if (counts) button.title = counts;
  const raw = document.createElement("pre");
  raw.hidden = true;
  raw.textContent = check.stdout + (check.stderr ? `\n${check.stderr}` : "");
  button.onclick = () => {
    raw.hidden = !raw.hidden;
  };
  item.append(button, raw);
  return item;
}

/** Tabs are local presentation state; selecting one does not change the proof session. */
export function resultsView(goalsSelected: () => void) {
  const output = element("output");
  const checks = element("checks");
  let drawn: readonly Check[] = [];
  // Lifecycle transitions may select Output; timer and progress updates preserve the user's tab.
  let previous: RunStatus = { kind: "ready" };
  element("limit").textContent = `${INPUT_LABEL} input limit`;

  const status = (kind: string, title: string, detail: string) => {
    element("status").className = `status ${kind}`;
    element("verdict").textContent = title;
    element("status-detail").textContent = detail;
  };
  const show = (view: string) => {
    for (const name of ["result", "checks", "goals"])
      element(`view-${name}`).hidden = name !== view;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
      button.setAttribute("aria-pressed", String(button.dataset.view === view));
    if (view === "goals") goalsSelected();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]"))
    button.onclick = () => show(button.dataset.view ?? "result");

  return {
    render(state: Readonly<SessionState>) {
      if (drawn !== state.checks) {
        // Appended arrays share their existing check objects, preserving expanded row state.
        let from = drawn.length;
        if (drawn[0] !== state.checks[0] || state.checks.length < from) {
          checks.replaceChildren();
          from = 0;
        }
        for (let i = from; i < state.checks.length; i++)
          checks.append(checkRow(state.checks[i] as Check, i));
        drawn = state.checks;
        element("check-count").textContent = String(drawn.length);
        element("no-checks").hidden = drawn.length > 0;
      }
      const current = state.status;
      element("elapsed").textContent =
        current.kind === "ready" ? "Ctrl/⌘ + Enter" : `${(state.elapsedMs / 1000).toFixed(1)} s`;
      switch (current.kind) {
        case "ready":
          status("ready", "Ready", "Run to check this input.");
          output.textContent = "; Does @tgt refine @src?\n; Run to check this input.";
          element("activity").textContent = "No undef · poison supported";
          break;
        case "running":
          status(
            "running",
            "Running",
            current.loading ??
              (current.activity
                ? `Searching · ${current.activity}`
                : "Preparing the refinement search…"),
          );
          element("activity").textContent = current.activity
            ? `Searching · ${current.activity}`
            : "No undef · poison supported";
          if (previous.kind !== "running") {
            output.textContent = "Running alive-simple…";
            show("result");
          }
          break;
        case "finished": {
          const titles = { verified: "Verified", counterexample: "Refuted", unknown: "Unknown" };
          const detail =
            current.verdict === "verified"
              ? "@tgt refines @src. Every remaining goal is proved."
              : current.verdict === "counterexample"
                ? "alive2 refuted the original pair. See its counterexample below."
                : "No conclusion. Open goals remain within this search budget.";
          status(current.verdict, titles[current.verdict], detail);
          const proved = state.standing.goals.filter((goal) => goal.status === "proved").length;
          const open = state.standing.goals.filter((goal) => goal.status === "open").length;
          const last = evidence(state.checks, current.verdict);
          const fallback =
            current.verdict === "verified"
              ? "The goal closed by structural identity."
              : "No check completed.";
          output.textContent = `${proved} proved goals · ${open} open goals · ${state.checks.length} checks\n\n${last ? `Last ${last.checker} check:\n\n${last.stdout}` : fallback}`;
          element("activity").textContent = "Search complete";
          if (previous !== current) show("result");
          break;
        }
        case "stopped": {
          const reason =
            current.reason === "user"
              ? "Stopped by user."
              : "The run reached its wall-clock budget.";
          status("unknown", "Unknown", reason);
          output.textContent = `${reason}\nNo verification or refutation is claimed.\n\n${state.checks.length} checks completed.`;
          if (previous !== current) show("result");
          break;
        }
        case "error":
          status("error", "Error", "The input or checker could not complete the run.");
          output.textContent = current.message;
          if (previous !== current) show("result");
          break;
      }
      previous = current;
    },
  };
}
