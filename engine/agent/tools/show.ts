// show: the text of a goal's two sides, or of one program.
//
// One tool for both because the two kinds of name cannot be confused: a goal
// is `g3` and a program is `p7`.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session, SideView } from "../../core/session.ts";
import { answer, program } from "./format.ts";

/** One side: what it is called now, what it has been, and what it says. */
function side(which: "src" | "tgt", view: SideView): string {
  const was = view.history.slice(0, -1);
  const earlier = was.length > 0 ? ` (was ${was.join(", ")})` : "";
  return program(`${which} ${view.id}${earlier}`, view.text);
}

export function showTool(session: Session) {
  return defineTool({
    name: "show",
    label: "Show",
    description:
      "The text of a goal's two sides, given a goal id like g3, or of one program, given a program id like p7. Value references are the program's own, so read a side before naming anything inside it.",
    parameters: Type.Object({
      ref: Type.String({ description: "A goal id such as g1, or a program id such as p4." }),
    }),
    execute: async (_id, { ref }) => {
      if (/^p\d+$/.test(ref)) {
        const view = await session.program(ref);
        return answer(true, program(view.id, view.text), view);
      }
      const view = await session.show(ref);
      const what = view.role ? `${view.role} of ${view.parent}, cut into @${view.callee}` : "root";
      return answer(
        true,
        [`${view.gid} ${what}, ${view.status}`, side("src", view.src), side("tgt", view.tgt)].join(
          "\n",
        ),
        view,
      );
    },
  });
}
