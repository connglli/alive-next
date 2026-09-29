// A search along a string, whose tgt tests for the key before the end.
//
// The loop has no counter: a pointer walks the string until the byte it
// loads is the key or the terminating zero, and the two exits answer
// differently. Testing the key first is wrong for a key of 0, which the src
// finds as the end; the guard before the loop is what excludes it. Detached at
// its header, the callee is refuted on its own, so `key != 0` goes in as an
// invariant: the guard proves it on entry, and each iteration passes the key
// on unchanged.
import { expect, type Scenario } from "../core/scenario.ts";

export const strchr: Scenario = {
  name: "strchr",
  about: "a string search whose tgt reorders its exits, under an invariant the guard proves",
  verdict: "verified",

  src: `define ptr @find(ptr noundef %s, i8 noundef %key) {
entry:
  %zero = icmp eq i8 %key, 0
  br i1 %zero, label %nul, label %head

nul:
  ret ptr null

head:
  %p = phi ptr [ %s, %entry ], [ %p.next, %next ]
  %c = load i8, ptr %p, align 1
  %end = icmp eq i8 %c, 0
  br i1 %end, label %none, label %test

test:
  %hit = icmp eq i8 %c, %key
  br i1 %hit, label %found, label %next

next:
  %p.next = getelementptr i8, ptr %p, i64 1
  br label %head

found:
  ret ptr %p

none:
  ret ptr null
}
`,

  tgt: `define ptr @find(ptr noundef %s, i8 noundef %key) {
entry:
  %zero = icmp eq i8 %key, 0
  br i1 %zero, label %nul, label %head

nul:
  ret ptr null

head:
  %p = phi ptr [ %s, %entry ], [ %p.next, %next ]
  %c = load i8, ptr %p, align 1
  %hit = icmp eq i8 %c, %key
  br i1 %hit, label %found, label %test

test:
  %end = icmp eq i8 %c, 0
  br i1 %end, label %none, label %next

next:
  %p.next = getelementptr i8, ptr %p, i64 1
  br label %head

found:
  ret ptr %p

none:
  ret ptr null
}
`,

  async prove(session) {
    // The pointer (`%3`) and the key (`%1`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%3": "%3", "%1": "%1" });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    const kept = await session.strengthen("g1", {
      predicates: [{ op: "ne", lhs: "!1", rhs: 0 }],
    });
    expect("the key is not 0, on entry and each time around", kept.kind === "strengthened", kept);
  },
};
