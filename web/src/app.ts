import { EditorController } from "./controllers/editor.ts";
import { ReportsController } from "./controllers/reports.ts";
import { BrowserSession } from "./controllers/session.ts";
import type { SessionState } from "./state.ts";
import { controlsView } from "./views/controls.ts";
import { editorView } from "./views/editor.ts";
import { goalsView } from "./views/goals.ts";
import { reportsView } from "./views/reports.ts";
import { resultsView } from "./views/results.ts";
import { bindSplitter } from "./views/splitter.ts";

// Callbacks run after initialization and close over the composed controllers.
// Keeping these connections here makes the direction of each state update explicit.
const editor = new EditorController(
  editorView({
    changed: (text) => editor.change(text),
    load: (file) => {
      void editor.load(file);
    },
    save: () => editor.save(),
  }),
  {
    changed: () => {
      // A new input invalidates both the proof and exports still being prepared.
      reports.reset();
      session.reset();
    },
    failed: (error) => session.fail(error),
  },
);
const controls = controlsView({ run: start, stop: () => session.stop() });
const goals = goalsView((gid) => session.inspect(gid));
const results = resultsView(() => goals.render(session.state.standing, session.state.inspectable));
const reportView = reportsView({
  open: () => {
    void reports.open();
  },
  save: () => {
    void reports.save();
  },
  close: () => reports.close(),
});
const session = new BrowserSession({ changed: render, inspected: goals.inspect });
const reports = new ReportsController(reportView, () => session.snapshot);
bindSplitter();

function render(state: Readonly<SessionState>) {
  // Views receive the same session state; none has to query another view for it.
  const running = state.status.kind === "running";
  editor.setRunning(running);
  controls.setRunning(running);
  results.render(state);
  goals.render(state.standing, state.inspectable);
  reports.setAvailable(state.hasReport);
}

function start() {
  if (session.running) return;
  const budget = controls.budget();
  // Invalid HTML fields report their own errors before a search is started.
  if (!budget) return;
  reports.reset();
  session.start(editor.text, budget);
}

// Static markup supplies the initial empty result; state updates begin with a user action.
if (location.protocol === "file:")
  session.fail("Serve this directory over HTTP: python3 -m http.server 8000 --directory web/dist");
