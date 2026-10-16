// A loop that tests a parameter in its body, against the loop unswitched.
//
// The tgt is the src after `-O3`'s loop unswitching, with its empty blocks
// merged and its values named: it tests `mode` once before the loop and keeps
// a version of the loop for each answer. One loop
// against two lines up under no cut, so the goal is cut by cases on `mode`:
// each case assumes its answer at the start of both programs, which decides
// every branch on `mode`, and `reshaped` proves each case with no step.
import { expect, type Scenario } from "../core/scenario.ts";

export const unswitch: Scenario = {
  name: "unswitch",
  about: "a loop unswitched on a parameter, proved by cases on it",
  verdict: "verified",

  src: `define void @scale(ptr %a, ptr %b, i32 noundef %n, i32 noundef %mode) {
entry:
  %some = icmp slt i32 0, %n
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %mode, 0
  br label %body

body:
  %i = phi i32 [ 0, %preheader ], [ %inc, %latch ]
  br i1 %zero, label %divide, label %multiply

multiply:
  %k = zext nneg i32 %i to i64
  %from = getelementptr inbounds nuw i32, ptr %b, i64 %k
  %x = load i32, ptr %from, align 4
  %y = mul nsw i32 %x, 3
  %to = getelementptr inbounds nuw i32, ptr %a, i64 %k
  store i32 %y, ptr %to, align 4
  br label %latch

divide:
  %k2 = zext nneg i32 %i to i64
  %from2 = getelementptr inbounds nuw i32, ptr %b, i64 %k2
  %x2 = load i32, ptr %from2, align 4
  %y2 = sdiv i32 %x2, 7
  %to2 = getelementptr inbounds nuw i32, ptr %a, i64 %k2
  store i32 %y2, ptr %to2, align 4
  br label %latch

latch:
  %inc = add nuw nsw i32 %i, 1
  %more = icmp slt i32 %inc, %n
  br i1 %more, label %body, label %end

end:
  ret void
}
`,

  tgt: `define void @scale(ptr %a, ptr %b, i32 noundef %n, i32 noundef %mode) {
entry:
  %some = icmp slt i32 0, %n
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %mode, 0
  br i1 %zero, label %body.us, label %body

body.us:
  %i.us = phi i32 [ 0, %preheader ], [ %inc.us, %latch.us ]
  %k.us = zext nneg i32 %i.us to i64
  %from.us = getelementptr inbounds nuw i32, ptr %b, i64 %k.us
  %x.us = load i32, ptr %from.us, align 4
  %y.us = sdiv i32 %x.us, 7
  %to.us = getelementptr inbounds nuw i32, ptr %a, i64 %k.us
  store i32 %y.us, ptr %to.us, align 4
  br label %latch.us

latch.us:
  %inc.us = add nuw nsw i32 %i.us, 1
  %more.us = icmp slt i32 %inc.us, %n
  br i1 %more.us, label %body.us, label %end

body:
  %i = phi i32 [ 0, %preheader ], [ %inc, %latch ]
  %k = zext nneg i32 %i to i64
  %from = getelementptr inbounds nuw i32, ptr %b, i64 %k
  %x = load i32, ptr %from, align 4
  %y = mul nsw i32 %x, 3
  %to = getelementptr inbounds nuw i32, ptr %a, i64 %k
  store i32 %y, ptr %to, align 4
  br label %latch

latch:
  %inc = add nuw nsw i32 %i, 1
  %more = icmp slt i32 %inc, %n
  br i1 %more, label %body, label %end

end:
  ret void
}
`,

  async prove(session) {
    // `mode` is parameter 3, which the src makes noundef.
    const split = await session.case("g1", { op: "eq", lhs: "!3", rhs: 0 });
    expect("cut by cases on mode", split.kind === "cased", split);
    if (split.kind !== "cased") return;

    for (const gid of [split.children.holds, split.children.fails]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
