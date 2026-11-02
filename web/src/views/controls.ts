import { type Budget, DEFAULT_BUDGET, MAX_TIMEOUT_MS, TIMEOUT_SECONDS } from "../limits.ts";
import { element } from "./dom.ts";

/** Handle browser field constraints; controllers and workers validate the resulting budget. */
export function controlsView(actions: { run(): void; stop(): void }) {
  const run = element<HTMLButtonElement>("run");
  const stop = element<HTMLButtonElement>("stop");
  const timeout = element<HTMLSelectElement>("budget");
  const custom = element<HTMLInputElement>("custom-budget");
  const cuts = element<HTMLInputElement>("cuts");
  const unfolds = element<HTMLInputElement>("unfolds");
  let running = false;

  for (const seconds of TIMEOUT_SECONDS)
    timeout.add(new Option(`${seconds} s`, String(seconds * 1000)));
  timeout.add(new Option("Custom…", "custom"));
  timeout.value = String(DEFAULT_BUDGET.ms);
  custom.value = String(DEFAULT_BUDGET.ms / 1000);
  custom.max = String(MAX_TIMEOUT_MS / 1000);
  cuts.value = String(DEFAULT_BUDGET.cuts);
  unfolds.value = String(DEFAULT_BUDGET.unfolds);
  cuts.max = unfolds.max = String(Number.MAX_SAFE_INTEGER);

  const customControl = () => {
    element("custom-budget-control").hidden = timeout.value !== "custom";
    custom.disabled = running || timeout.value !== "custom";
  };
  customControl();
  timeout.onchange = () => {
    customControl();
    if (timeout.value === "custom") custom.focus();
  };
  run.onclick = actions.run;
  stop.onclick = actions.stop;
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      actions.run();
    }
  });

  return {
    budget(): Budget | undefined {
      for (const input of [cuts, unfolds, ...(timeout.value === "custom" ? [custom] : [])])
        if (!input.reportValidity()) return;
      return {
        ms:
          timeout.value === "custom"
            ? Math.round(custom.valueAsNumber * 1000)
            : Number(timeout.value),
        cuts: cuts.valueAsNumber,
        unfolds: unfolds.valueAsNumber,
      };
    },
    setRunning(value: boolean) {
      running = value;
      run.disabled = value;
      stop.disabled = !value;
      timeout.disabled = cuts.disabled = unfolds.disabled = value;
      customControl();
    },
  };
}
