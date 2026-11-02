import { element } from "./dom.ts";

interface ReportActions {
  open(): void;
  save(): void;
  close(): void;
}

/** Present report controls and the iframe; the controller owns preparation and cancellation. */
export function reportsView(actions: ReportActions) {
  const open = element<HTMLButtonElement>("show-details");
  const save = element<HTMLButtonElement>("save-session");
  const dialog = element<HTMLDialogElement>("details");
  const frame = element<HTMLIFrameElement>("details-frame");
  const status = element("details-status");
  const saveError = element("save-error");
  open.onclick = actions.open;
  save.onclick = actions.save;
  element("close-details").onclick = actions.close;
  dialog.addEventListener("close", () => {
    // Close is queued: an older event must not cancel a newly reopened dialog.
    if (!dialog.open) actions.close();
  });

  return {
    availability(available: boolean, saving: boolean) {
      open.disabled = !available;
      save.disabled = !available || saving;
      save.textContent = saving ? "Saving…" : "Save";
    },
    prepare() {
      frame.srcdoc = "";
      frame.hidden = true;
      status.hidden = false;
      status.textContent = "Preparing the session snapshot…";
      if (!dialog.open) dialog.showModal();
    },
    display(html: string) {
      // The report worker combines the packaged template with JSON-escaped session data.
      frame.srcdoc = html;
      frame.hidden = false;
      status.hidden = true;
    },
    displayError(message: string) {
      status.textContent = message;
    },
    close() {
      dialog.close();
      frame.srcdoc = "";
    },
    saveError(message?: string) {
      saveError.hidden = message === undefined;
      saveError.textContent = message ?? "";
    },
  };
}

export type ReportsView = ReturnType<typeof reportsView>;
