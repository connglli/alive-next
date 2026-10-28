// Small pairs for the simple searcher. Those in `pairs` resist a whole-function
// check within 300 seconds. `e4` is not a refinement: when %p0 is poison and %p2
// is 0, the src returns 0 and the tgt returns poison.

export interface Pair {
  /** What changed. */
  about: string;
  src: string;
  tgt: string;
  refines: boolean;
}

/** The same division with a shared return or separate returns. */
export const JOINED = {
  src: `define i32 @f(i1 noundef %c, i32 noundef %x, i32 noundef %y, i32 noundef %z) {
entry:
  br i1 %c, label %work, label %other
work:
  %p = mul i32 %x, %y
  %q = udiv i32 %p, %z
  br label %join
other:
  br label %join
join:
  %r = phi i32 [ %q, %work ], [ 0, %other ]
  ret i32 %r
}
`,
  tgt: `define i32 @f(i1 noundef %c, i32 noundef %x, i32 noundef %y, i32 noundef %z) {
entry:
  br i1 %c, label %work, label %other
work:
  %p = mul i32 %x, %y
  %q = udiv i32 %p, %z
  ret i32 %q
other:
  ret i32 0
}
`,
};

/** A loop's state in a stack slot or a phi, with different users after the loop. */
export const SLOTTED = {
  src: `define i32 @f(i32 %a, i32 %b, i1 noundef %again) {
entry:
  %slot = alloca i32
  store i32 %a, ptr %slot
  br label %head
head:
  %unused = load i32, ptr %slot
  %value = load i32, ptr %slot
  br i1 %again, label %body, label %exit
body:
  store i32 %b, ptr %slot
  br label %head
exit:
  %result = mul i32 %value, 2
  ret i32 %result
}
`,
  tgt: `define i32 @f(i32 %a, i32 %b, i1 noundef %again) {
entry:
  br label %head
head:
  %value = phi i32 [ %a, %entry ], [ %b, %body ]
  br i1 %again, label %body, label %exit
body:
  br label %head
exit:
  %result = shl i32 %value, 1
  ret i32 %result
}
`,
};

export const pairs: Record<string, Pair> = {
  e1: {
    about: "single-instruction substitutions and a commuted mul",
    refines: true,
    src: `define i64 @f(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = sub i64 %p0, %p1
  %v1 = sdiv exact i64 %v0, 8
  %v2 = sub nsw i64 %v1, %p2
  %v3 = mul nsw i64 %p3, %v2
  %v4 = sdiv exact i64 %p4, 16
  %v5 = add nsw i64 %v3, %v4
  %v6 = sdiv exact i64 %p5, 16
  %v7 = add nsw i64 %v5, %v6
  ret i64 %v7
}
`,
    tgt: `define i64 @f(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = sub i64 %p0, %p1
  %v1 = ashr exact i64 %v0, 3
  %v2 = sub nsw i64 %v1, %p2
  %v3 = mul nsw i64 %v2, %p3
  %v4 = ashr exact i64 %p4, 4
  %v5 = add nsw i64 %v3, %v4
  %v6 = ashr exact i64 %p5, 4
  %v7 = add nsw i64 %v5, %v6
  ret i64 %v7
}
`,
  },
  e1alt: {
    about: "the same substitutions after a ptrtoint, and a commuted add",
    refines: true,
    src: `define i64 @f(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = ptrtoint ptr %p0 to i64
  %v1 = sub i64 %p1, %v0
  %v2 = sdiv exact i64 %v1, 8
  %v3 = sub nsw i64 %v2, %p2
  %v4 = mul nsw i64 %p3, %v3
  %v5 = sub i64 %p4, %p5
  %v6 = sdiv exact i64 %v5, 16
  %v7 = add nsw i64 %v4, %v6
  ret i64 %v7
}
`,
    tgt: `define i64 @f(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = ptrtoint ptr %p0 to i64
  %v1 = sub i64 %p1, %v0
  %v2 = ashr exact i64 %v1, 3
  %v3 = sub nsw i64 %v2, %p2
  %v4 = mul nsw i64 %v3, %p3
  %v5 = sub i64 %p4, %p5
  %v6 = ashr exact i64 %v5, 4
  %v7 = add nsw i64 %v6, %v4
  ret i64 %v7
}
`,
  },
  e2: {
    about: "sub nsw of a zext rewritten as add nsw of a sext",
    refines: true,
    src: `define i64 @f(i64 %p0, i64 %p1, ptr %p2, i64 %p3, i64 %p4) {
entry:
  %v0 = sub i64 %p0, %p1
  %v1 = sdiv exact i64 %v0, 8
  %v2 = icmp ne ptr %p2, null
  %v3 = zext i1 %v2 to i64
  %v4 = sub nsw i64 %v1, %v3
  %v5 = mul nsw i64 %p3, %v4
  %v6 = add nsw i64 %v5, %p4
  ret i64 %v6
}
`,
    tgt: `define i64 @f(i64 %p0, i64 %p1, ptr %p2, i64 %p3, i64 %p4) {
entry:
  %v0 = sub i64 %p0, %p1
  %v1 = ashr exact i64 %v0, 3
  %v2 = icmp ne ptr %p2, null
  %v3.neg = sext i1 %v2 to i64
  %v4 = add nsw i64 %v1, %v3.neg
  %v5 = mul nsw i64 %v4, %p3
  %v6 = add nsw i64 %v5, %p4
  ret i64 %v6
}
`,
  },
  e3: {
    about: "two scalar divisions fused into one vector division",
    refines: true,
    src: `define i64 @f(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = sdiv exact i64 %p0, 8
  %v1 = sub nsw i64 %v0, %p1
  %v2 = mul nsw i64 %p2, %v1
  %v3 = sub i64 %p3, %p4
  %v4 = sdiv exact i64 %v3, 24
  %v5 = add nsw i64 %v2, %v4
  %v6 = sdiv exact i64 %p5, 24
  %v7 = add nsw i64 %v5, %v6
  ret i64 %v7
}
`,
    tgt: `define i64 @f(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
entry:
  %v0 = ashr exact i64 %p0, 3
  %v1 = sub nsw i64 %v0, %p1
  %v2 = mul nsw i64 %p2, %v1
  %0 = insertelement <2 x i64> poison, i64 %p3, i64 0
  %1 = insertelement <2 x i64> %0, i64 %p5, i64 1
  %2 = insertelement <2 x i64> <i64 poison, i64 0>, i64 %p4, i64 0
  %3 = sub <2 x i64> %1, %2
  %4 = sdiv exact <2 x i64> %3, splat (i64 24)
  %5 = extractelement <2 x i64> %4, i64 0
  %v5 = add nsw i64 %5, %v2
  %6 = extractelement <2 x i64> %4, i64 1
  %v7 = add nsw i64 %v5, %6
  ret i64 %v7
}
`,
  },
  e4: {
    about: "a freeze dropped",
    refines: false,
    src: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = and i64 %p0, 31
  %v1 = shl i64 %p1, %v0
  %v2 = freeze i64 %v1
  %v3 = mul nsw i64 %v2, %p2
  ret i64 %v3
}
`,
    tgt: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = and i64 %p0, 31
  %v1 = shl i64 %p1, %v0
  %v3 = mul nsw i64 %v1, %p2
  ret i64 %v3
}
`,
  },
  varA: {
    about: "nsw added to a mul of two sexts",
    refines: true,
    src: `define ptr @f(i32 %p0, i32 %p1, i64 %p2, ptr %p3) {
entry:
  %v0 = sext i32 %p0 to i64
  %v1 = sext i32 %p1 to i64
  %v2 = mul i64 %v0, %v1
  %v3 = mul i64 %v2, %p2
  %v4 = getelementptr inbounds i8, ptr %p3, i64 %v3
  ret ptr %v4
}
`,
    tgt: `define ptr @f(i32 %p0, i32 %p1, i64 %p2, ptr %p3) {
entry:
  %v0 = sext i32 %p0 to i64
  %v1 = sext i32 %p1 to i64
  %v2 = mul nsw i64 %v1, %v0
  %v3 = mul i64 %v2, %p2
  %v4 = getelementptr inbounds i8, ptr %p3, i64 %v3
  ret ptr %v4
}
`,
  },
  varB: {
    about: "strength reduction, with the flags relaxed where they no longer hold",
    refines: true,
    src: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = add nsw i64 %p0, 1
  %v1 = mul nsw i64 4, %v0
  %v2 = sdiv i64 %p1, %v1
  %v3 = mul nsw i64 4, %v2
  %v4 = sub nsw i64 %p2, %v3
  ret i64 %v4
}
`,
    tgt: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = shl i64 %p0, 2
  %v1 = add i64 %v0, 4
  %v2 = sdiv i64 %p1, %v1
  %v3 = shl nsw i64 %v2, 2
  %v4 = sub nsw i64 %p2, %v3
  ret i64 %v4
}
`,
  },
};

/** The paper's straight-line pair, which alive2 alone does not decide in ten minutes. */
export const PAPER: Pair = {
  about: "a total reassociated around a division, and the and dropped",
  refines: true,
  src: `define i64 @f(i64 noundef %p0, i64 noundef %p1, i64 noundef %p2) {
entry:
  %a = mul i64 %p0, 4
  %v1 = sub i64 %p1, %a
  %e = sdiv i64 %v1, 2
  %v3 = mul i64 %e, 2
  %v4 = add i64 %a, %v3
  %v5 = mul i64 %p2, 2
  %t = add i64 %v4, %v5
  %v7 = sub i64 %p1, %t
  %v8 = sdiv i64 %v7, 2
  %v9 = mul i64 %v8, 2
  %r = add i64 %t, %v9
  %h = and i64 %r, -2
  ret i64 %h
}
`,
  tgt: `define i64 @f(i64 noundef %p0, i64 noundef %p1, i64 noundef %p2) {
entry:
  %a = shl i64 %p0, 2
  %v1 = sub i64 %p1, %a
  %e = sdiv i64 %v1, 2
  %s = add i64 %e, %p2
  %s2 = shl i64 %s, 1
  %q = add i64 %a, %s2
  %v7 = sub i64 %p1, %q
  %v8 = sdiv i64 %v7, 2
  %k = add i64 %v8, %s
  %k2 = shl i64 %k, 1
  %r = add i64 %k2, %a
  ret i64 %r
}
`,
};
