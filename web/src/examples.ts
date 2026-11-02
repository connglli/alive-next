export const examples = {
  "Strength reduction": `; Check whether @tgt refines @src.
; Values may be poison; undef is not supported.

define i32 @src(i32 %x) {
entry:
  %r = mul i32 %x, 2
  ret i32 %r
}

define i32 @tgt(i32 %x) {
entry:
  %r = shl i32 %x, 1
  ret i32 %r
}
`,
  "Overflow counterexample": `; Adding nsw introduces poison for signed overflow.

define i32 @src(i32 %x) {
  %r = add i32 %x, 1
  ret i32 %r
}

define i32 @tgt(i32 %x) {
  %r = add nsw i32 %x, 1
  ret i32 %r
}
`,
  "Branch simplification": `define i32 @src(i32 noundef %x) {
entry:
  %c = icmp eq i32 %x, 0
  br i1 %c, label %zero, label %other
zero:
  ret i32 0
other:
  ret i32 %x
}

define i32 @tgt(i32 noundef %x) {
  ret i32 %x
}
`,
  "Loop induction": `; The bound makes the loop increment non-wrapping.

define i32 @src(i32 noundef %n) {
entry:
  br label %head
head:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit
body:
  %next = add i32 %i, 1
  br label %head
exit:
  ret i32 %i
}

define i32 @tgt(i32 noundef %n) {
entry:
  br label %head
head:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit
body:
  %next = add nuw i32 %i, 1
  br label %head
exit:
  ret i32 %i
}
`,
};
