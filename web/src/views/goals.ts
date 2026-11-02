import { highlight } from "../highlight.ts";
import type { Standing } from "../protocol.ts";
import { element } from "./dom.ts";

/** Draw goal summaries and display the programs supplied by the session controller. */
export function goalsView(inspect: (gid: string) => void) {
  const target = element("goals");
  const dialog = element<HTMLDialogElement>("inspector");
  let drawn: Standing | undefined;
  let enabled = false;
  element("close-inspector").onclick = () => dialog.close();

  return {
    render(state: Standing, inspectable: boolean) {
      if (!inspectable) dialog.close();
      element("goal-count").textContent = String(state.goals.length);
      // Cache only drawn snapshots, so hidden progress is rendered when the tab opens.
      if (element("view-goals").hidden || (drawn === state && enabled === inspectable)) return;
      drawn = state;
      enabled = inspectable;
      target.replaceChildren();
      const goals = new Map(state.goals.map((goal) => [goal.id, goal]));
      for (const goal of state.goals) {
        let depth = 0,
          parent = goal.parent;
        while (parent && depth < state.goals.length) {
          depth++;
          parent = goals.get(parent)?.parent;
        }
        const button = document.createElement("button");
        button.className = `goal ${goal.status}`;
        button.style.setProperty("--indent", `${Math.min(depth, 8) * 18}px`);
        button.textContent = `${goal.id}${goal.role ? ` / ${goal.role}` : " / root"}`;
        const label = document.createElement("small");
        label.textContent = goal.status;
        button.append(label);
        button.disabled = !inspectable;
        button.onclick = () => inspect(goal.id);
        target.append(button);
      }
    },
    inspect(gid: string, src: string, tgt: string) {
      element("inspect-title").textContent = `Goal ${gid}`;
      highlight(element("inspect-src"), src);
      highlight(element("inspect-tgt"), tgt);
      if (!dialog.open) dialog.showModal();
    },
  };
}
