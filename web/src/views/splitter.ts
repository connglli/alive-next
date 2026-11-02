import { element } from "./dom.ts";

export function bindSplitter() {
  const splitter = element("splitter");
  const workspace = element("workspace");
  let left = 50;
  const resize = (value: number) => {
    // Both input paths share bounds so neither pane can collapse.
    left = Math.max(25, Math.min(75, value));
    workspace.style.setProperty("--left", `${left}%`);
    splitter.setAttribute("aria-valuenow", String(Math.round(left)));
  };
  // Keep receiving drag events after the pointer leaves the thin separator.
  splitter.onpointerdown = (event) => splitter.setPointerCapture(event.pointerId);
  splitter.onpointermove = (event) => {
    if (splitter.hasPointerCapture(event.pointerId)) {
      const box = workspace.getBoundingClientRect();
      resize(((event.clientX - box.left) / box.width) * 100);
    }
  };
  splitter.onkeydown = (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      resize(left + (event.key === "ArrowLeft" ? -2 : 2));
    }
  };
}
