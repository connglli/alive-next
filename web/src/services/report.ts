import type { ReportRequest, ReportResponse } from "../protocol.ts";

type Reply = ReportResponse | { error: string };

/** Prepare a report outside the page's event loop, owning a fresh worker for each request. */
export function requestReport(request: ReportRequest) {
  const worker = new Worker(new URL(DETAILS_WORKER_FILE, import.meta.url));
  let cancel!: (error: Error) => void;
  const result = new Promise<ReportResponse>((resolve, reject) => {
    cancel = reject;
    worker.onmessage = (event: MessageEvent<Reply>) => {
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      reject(new Error(event.message));
    };
    worker.onmessageerror = () => reject(new Error("Cannot read the session snapshot"));
    // Structured cloning captures the current history while the search may continue.
    worker.postMessage(request);
  });
  return {
    result: result.finally(() => worker.terminate()),
    cancel() {
      worker.terminate();
      // Termination sends no reply; settle the promise so controller cleanup can finish.
      cancel(new DOMException("Snapshot preparation cancelled", "AbortError"));
    },
  };
}
