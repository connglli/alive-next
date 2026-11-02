import type { ReportSource } from "./protocol.ts";
import { requestReport } from "./report.ts";

// Prepare snapshots independently of the search so diffing cannot block Stop.
export function detailsView(
  dialog: HTMLDialogElement,
  frame: HTMLIFrameElement,
  status: HTMLElement,
) {
  let job: ReturnType<typeof requestReport> | undefined;

  const dispose = () => {
    job?.cancel();
    job = undefined;
    frame.srcdoc = "";
  };
  dialog.addEventListener("close", () => {
    if (!dialog.open) dispose();
  });

  return {
    close() {
      dialog.close();
      dispose();
    },
    async open(source: ReportSource) {
      dispose();
      frame.hidden = true;
      status.hidden = false;
      status.textContent = "Preparing the session snapshot…";
      dialog.showModal();

      let current: ReturnType<typeof requestReport> | undefined;
      try {
        // postMessage clones the history at this instant, while the run may continue.
        current = requestReport({ kind: "view", source });
        job = current;
        const response = await current.result;
        if (job !== current) return;
        if (!("html" in response)) throw new Error("Cannot read the session details");
        frame.srcdoc = response.html;
        frame.hidden = false;
        status.hidden = true;
      } catch (error) {
        if (job === current)
          status.textContent = String(error instanceof Error ? error.message : error);
      } finally {
        if (job === current) job = undefined;
      }
    },
  };
}
