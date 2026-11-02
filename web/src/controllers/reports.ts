import type { ReportSource } from "../protocol.ts";
import { download } from "../services/download.ts";
import { requestReport } from "../services/report.ts";
import type { ReportsView } from "../views/reports.ts";

type Job = ReturnType<typeof requestReport>;

/** Report requests own their cancellation; the view only displays their results. */
export class ReportsController {
  // Viewing and saving are independent requests; closing the dialog only cancels viewing.
  private viewing?: Job;
  private saving?: Job;
  private available = false;

  constructor(
    private readonly view: ReportsView,
    private readonly snapshot: () => { source: ReportSource; module: string },
  ) {}

  private publish() {
    this.view.availability(this.available, this.saving !== undefined);
  }

  setAvailable(available: boolean) {
    // Losing the input's recorded history invalidates every pending export of it.
    if (!available && this.available) this.reset();
    this.available = available;
    this.publish();
  }

  close() {
    this.viewing?.cancel();
    this.viewing = undefined;
    this.view.close();
  }

  reset() {
    this.close();
    this.saving?.cancel();
    this.saving = undefined;
    this.available = false;
    this.view.saveError();
    this.publish();
  }

  async open() {
    if (!this.available) return;
    this.viewing?.cancel();
    this.viewing = undefined;
    this.view.prepare();
    let job: Job | undefined;
    try {
      job = requestReport({ kind: "view", source: this.snapshot().source });
      this.viewing = job;
      const response = await job.result;
      // Reopening or changing input can replace this job while the worker is preparing HTML.
      if (this.viewing !== job) return;
      if (!("html" in response)) throw new Error("Cannot read the session details");
      this.view.display(response.html);
    } catch (error) {
      if (this.viewing === job)
        this.view.displayError(String(error instanceof Error ? error.message : error));
    } finally {
      if (this.viewing === job) this.viewing = undefined;
    }
  }

  async save() {
    if (!this.available || this.saving) return;
    this.view.saveError();
    let job: Job | undefined;
    try {
      job = requestReport({ kind: "save", ...this.snapshot() });
      // The session supplies its captured input rather than the editor's mutable DOM value.
      this.saving = job;
      this.publish();
      const response = await job.result;
      // A cancelled export must never download into a replacement input's UI.
      if (this.saving !== job) return;
      if (!("archive" in response)) throw new Error("Cannot read the session archive");
      download(new Blob([response.archive], { type: "application/zip" }), "alive-next-session.zip");
    } catch (error) {
      if (this.saving === job)
        this.view.saveError(String(error instanceof Error ? error.message : error));
    } finally {
      if (this.saving === job) {
        this.saving = undefined;
        this.publish();
      }
    }
  }
}
