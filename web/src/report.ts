import type { ReportSource } from "./protocol.ts";

export type ReportRequest =
  | { kind: "view"; source: ReportSource }
  | { kind: "save"; source: ReportSource; module: string };

export type ReportResponse = { html: string } | { archive: ArrayBuffer };
type Reply = ReportResponse | { error: string };

/** Both views and downloads prepare a frozen snapshot outside the page's event loop. */
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
    worker.postMessage(request);
  });
  return {
    result: result.finally(() => worker.terminate()),
    cancel() {
      worker.terminate();
      cancel(new DOMException("Snapshot preparation cancelled", "AbortError"));
    },
  };
}
