import { examples } from "../examples.ts";
import { highlight } from "../highlight.ts";
import { element } from "./dom.ts";

// Actions describe user intent. Rendering and locking the editor never emit them back.
interface EditorActions {
  changed(text: string): void;
  load(file: File): void;
  save(): void;
}
export interface EditorView {
  render(text: string): void;
  setRunning(running: boolean): void;
}

export function editorView(actions: EditorActions): EditorView {
  const editor = element<HTMLTextAreaElement>("ir");
  const lines = element<HTMLPreElement>("lines");
  const paint = element("highlight");
  const sample = element<HTMLSelectElement>("examples");
  const load = element<HTMLButtonElement>("load");
  const file = element<HTMLInputElement>("file");

  const synchronize = () => {
    // Include native scrollbar space so the overlay and gutter follow the editable text.
    paint.style.right = `${editor.offsetWidth - editor.clientWidth}px`;
    paint.style.bottom = `${editor.offsetHeight - editor.clientHeight}px`;
    paint.scrollTop = editor.scrollTop;
    paint.scrollLeft = editor.scrollLeft;
    lines.style.height = `${editor.clientHeight}px`;
    lines.scrollTop = editor.scrollTop;
  };

  for (const name of Object.keys(examples)) sample.add(new Option(name, name));
  sample.onchange = () => {
    if (sample.value in examples) actions.changed(examples[sample.value as keyof typeof examples]);
  };
  editor.oninput = () => actions.changed(editor.value);
  editor.onscroll = synchronize;
  new ResizeObserver(synchronize).observe(editor);
  editor.onkeydown = (event) => {
    if (event.key === "Tab" && !editor.readOnly) {
      event.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
      editor.dispatchEvent(new Event("input"));
    }
  };
  load.onclick = () => file.click();
  file.onchange = () => {
    if (file.files?.[0]) actions.load(file.files[0]);
  };
  element("save").onclick = actions.save;

  return {
    render(text) {
      // Preserve the native caret and selection when handling an input event.
      if (editor.value !== text) editor.value = text;
      // Preserve the final empty line in the textarea's visual scroll area.
      highlight(paint, `${text}\n`);
      lines.textContent = Array.from({ length: text.split("\n").length }, (_, i) =>
        String(i + 1),
      ).join("\n");
      element("size").textContent =
        `${new TextEncoder().encode(text).length.toLocaleString()} bytes`;
      synchronize();
    },
    setRunning(running) {
      editor.readOnly = running;
      sample.disabled = load.disabled = running;
    },
  };
}
