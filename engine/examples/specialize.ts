// A loop that tests a parameter in its body, against the loop unswitched and
// one of its versions simplified.
//
// The tgt is the src after `-O3`, without the attributes it infers. As in
// `unswitch`, it tests `mode` once before the loop and keeps a version of the
// loop for each answer, and in the version for mode = 0 it folds `x + mode`
// to `x`. The goal is split by cases on mode. Where mode is not 0, `reshaped`
// proves the case with no step. Where mode is 0, a step on each side drops
// the code the case never reaches, and the loops that are left are cut at
// their exits and then at their headers, as in `rotated`. The fold holds only
// where mode is 0, so the cut's interface is strengthened with mode = 0. The
// case's assumption proves it where the loop is entered.
import { expect, type Scenario } from "../core/scenario.ts";

export const specialize: Scenario = {
  name: "specialize",
  about: "an unswitched loop simplified where a parameter is 0, proved by cases and cuts",
  verdict: "verified",

  src: `define void @scale(ptr %a, i32 noundef %n, i32 noundef %mode) {
entry:
  %some = icmp sgt i32 %n, 0
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %mode, 0
  br label %body

body:
  %i = phi i32 [ 0, %preheader ], [ %inc, %latch ]
  %k = zext nneg i32 %i to i64
  %p = getelementptr inbounds nuw i32, ptr %a, i64 %k
  %x = load i32, ptr %p, align 4
  br i1 %zero, label %plain, label %divide

divide:
  %y = sdiv i32 %x, %mode
  store i32 %y, ptr %p, align 4
  br label %latch

plain:
  %z = add nsw i32 %x, %mode
  %w = shl nsw i32 %z, 1
  store i32 %w, ptr %p, align 4
  br label %latch

latch:
  %inc = add nuw nsw i32 %i, 1
  %more = icmp slt i32 %inc, %n
  br i1 %more, label %body, label %end

end:
  ret void
}
`,

  tgt: `define void @scale(ptr %a, i32 noundef %n, i32 noundef %mode) {
entry:
  %some = icmp sgt i32 %n, 0
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %mode, 0
  br i1 %zero, label %body.us, label %body

body.us:
  %i.us = phi i32 [ %inc.us, %body.us ], [ 0, %preheader ]
  %k.us = zext nneg i32 %i.us to i64
  %p.us = getelementptr inbounds nuw i32, ptr %a, i64 %k.us
  %x.us = load i32, ptr %p.us, align 4
  %w.us = shl nsw i32 %x.us, 1
  store i32 %w.us, ptr %p.us, align 4
  %inc.us = add nuw nsw i32 %i.us, 1
  %more.us = icmp slt i32 %inc.us, %n
  br i1 %more.us, label %body.us, label %end

body:
  %i = phi i32 [ %inc, %body ], [ 0, %preheader ]
  %k = zext nneg i32 %i to i64
  %p = getelementptr inbounds nuw i32, ptr %a, i64 %k
  %x = load i32, ptr %p, align 4
  %y = sdiv i32 %x, %mode
  store i32 %y, ptr %p, align 4
  %inc = add nuw nsw i32 %i, 1
  %more = icmp slt i32 %inc, %n
  br i1 %more, label %body, label %end

end:
  ret void
}
`,

  async prove(session) {
    // `mode` is parameter 2, which the src makes noundef.
    const split = await session.case("g1", { op: "eq", lhs: "!2", rhs: 0 });
    expect("split by cases on mode", split.kind === "cased", split);
    if (split.kind !== "cased") return;
    const { holds, fails } = split.children;

    const checked = await session.check(fails);
    expect("where mode is not 0, both divide", checked.outcome === "proved", checked);

    // Canon names a, n and mode `%0`, `%1` and `%2`, and `%3` is the
    // comparison the case assumes at the start. Each step only redirects a
    // branch and drops the blocks it no longer reaches. It keeps `%zero`,
    // although nothing uses it now, so that `reshaped` certifies the step.
    await session.begin(holds, "src");
    const plain = await session.edit({
      op: "set_body",
      body: `  %3 = icmp eq i32 %2, 0
  call void @llvm.assume(i1 %3)
  %some = icmp sgt i32 %1, 0
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %2, 0
  br label %body

body:
  %i = phi i32 [ 0, %preheader ], [ %inc, %latch ]
  %k = zext nneg i32 %i to i64
  %p = getelementptr inbounds nuw i32, ptr %0, i64 %k
  %x = load i32, ptr %p, align 4
  br label %plain

plain:
  %z = add nsw i32 %x, %2
  %w = shl nsw i32 %z, 1
  store i32 %w, ptr %p, align 4
  br label %latch

latch:
  %inc = add nuw nsw i32 %i, 1
  %more = icmp slt i32 %inc, %1
  br i1 %more, label %body, label %end

end:
  ret void`,
    });
    expect("send the src's body straight to plain", plain.kind === "applied", plain);
    const src = await session.commit();
    expect("where mode is 0, the src never divides", src.kind === "certified", src);

    await session.begin(holds, "tgt");
    const us = await session.edit({
      op: "set_body",
      body: `  %3 = icmp eq i32 %2, 0
  call void @llvm.assume(i1 %3)
  %some = icmp sgt i32 %1, 0
  br i1 %some, label %preheader, label %end

preheader:
  %zero = icmp eq i32 %2, 0
  br label %body.us

body.us:
  %i.us = phi i32 [ %inc.us, %body.us ], [ 0, %preheader ]
  %k.us = zext nneg i32 %i.us to i64
  %p.us = getelementptr inbounds nuw i32, ptr %0, i64 %k.us
  %x.us = load i32, ptr %p.us, align 4
  %w.us = shl nsw i32 %x.us, 1
  store i32 %w.us, ptr %p.us, align 4
  %inc.us = add nuw nsw i32 %i.us, 1
  %more.us = icmp slt i32 %inc.us, %1
  br i1 %more.us, label %body.us, label %end

end:
  ret void`,
    });
    expect("send the tgt's preheader straight to body.us", us.kind === "applied", us);
    const tgt = await session.commit();
    expect("where mode is 0, the tgt never divides", tgt.kind === "certified", tgt);

    // The exits are the src's `%bb5` and the tgt's `%bb3`, and nothing crosses.
    const exit = await session.cut(holds, "%bb5", "%bb3", {});
    expect("detach the exit", exit.kind === "cut", exit);
    if (exit.kind !== "cut") return;

    // In the outer, the headers are `%bb3` on both sides: i (`%6`), a, n and
    // mode cross.
    const header = await session.cut(exit.children.outer, "%bb3", "%bb3", {
      "%6": "%6",
      "%0": "%0",
      "%1": "%1",
      "%2": "%2",
    });
    expect(
      "detach the header",
      header.kind === "cut" && header.detach?.hypothesis !== undefined,
      header,
    );
    if (header.kind !== "cut") return;

    // mode is parameter 3 of the loop.
    const kept = await session.strengthen(exit.children.outer, {
      predicates: [{ op: "eq", lhs: "!3", rhs: 0 }],
    });
    expect("mode is 0 on entry and on each iteration", kept.kind === "strengthened", kept);

    const done = await session.check(exit.children.callee);
    expect("what follows the loop is the same", done.outcome === "proved", done);
  },
};
