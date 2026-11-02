import { examples } from "../examples.ts";
import { INPUT_BYTES, INPUT_LABEL } from "../limits.ts";
import { download } from "../services/download.ts";
import type { EditorView } from "../views/editor.ts";

interface EditorEvents {
  changed(): void;
  failed(error: unknown): void;
}

/** Own draft persistence and asynchronous file reads independently of DOM painting. */
export class EditorController {
  private value: string;
  // File.text() cannot be cancelled, so newer input or a run invalidates its revision.
  private revision = 0;
  private running = false;

  constructor(
    private readonly view: EditorView,
    private readonly events: EditorEvents,
  ) {
    let draft: string | null = null;
    try {
      draft = localStorage.getItem("alive-next-ir");
    } catch {
      /* Storage may be disabled. */
    }
    this.value = draft ?? examples["Strength reduction"];
    // Initial painting preserves the static page's introductory output.
    this.paint();
  }

  get text() {
    return this.value;
  }

  private paint() {
    this.view.render(this.value);
    try {
      localStorage.setItem("alive-next-ir", this.value);
    } catch {
      /* Storage may be disabled. */
    }
  }

  change(text: string) {
    this.revision++;
    this.value = text;
    this.paint();
    this.events.changed();
  }

  setRunning(running: boolean) {
    if (this.running === running) return;
    this.running = running;
    if (running) this.revision++;
    this.view.setRunning(running);
  }

  async load(file: File) {
    // A file-picker event can arrive after its Load button has been disabled.
    if (this.running) return;
    const revision = ++this.revision;
    if (file.size > INPUT_BYTES) {
      this.events.failed(new Error(`The input limit is ${INPUT_LABEL}.`));
      return;
    }
    try {
      const text = await file.text();
      if (revision === this.revision && !this.running) this.change(text);
    } catch (error) {
      if (revision === this.revision) this.events.failed(error);
    }
  }

  save() {
    download(new Blob([this.value], { type: "text/plain" }), "module.ll");
  }
}
