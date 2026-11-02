import { sessionArchive } from "./archive.ts";
import type { ReportRequest } from "./report.ts";
import { visualizerData } from "./visualizer-data.ts";

self.onmessage = async (event: MessageEvent<ReportRequest>) => {
  try {
    const response = await fetch(new URL(VISUALIZER_TEMPLATE_FILE, self.location.href));
    if (!response.ok) throw new Error(`Cannot load the visualizer: HTTP ${response.status}`);
    const template = await response.text();
    // JSON is embedded in a script element; an IR string must never close that tag.
    const data = visualizerData(event.data.source);
    const payload = JSON.stringify(data).replace(/</g, "\\u003c");
    const html = template
      .replaceAll("__TITLE__", "Browser session")
      .replace("__DATA__", () => payload);
    if (event.data.kind === "view") postMessage({ html });
    else {
      let checker = "";
      if (data.verdict !== "unknown") {
        const response = await fetch(new URL(CERTIFICATE_CHECKER_FILE, self.location.href));
        if (!response.ok)
          throw new Error(`Cannot load the certificate checker: HTTP ${response.status}`);
        checker = await response.text();
      }
      const archive = sessionArchive(event.data.source, event.data.module, html, checker)
        .buffer as ArrayBuffer;
      postMessage({ archive }, { transfer: [archive] });
    }
  } catch (error) {
    postMessage({ error: String(error instanceof Error ? error.message : error) });
  }
};
