; Example 3 — vectorization with per-lane lifting + poison-flow assume
; (Phase 4). The hardest case in the test set.
;
; Source: real corpus slice. SLP vectorizer fuses two scalar
; `sdiv exact _, 24` operations into a single vector `sdiv exact <2 x i64>`.
; Pre and post sides have different instruction counts in the changed
; region (3 scalar instrs ↔ 7 vector instrs).
;
; Diff:
;   v0: sdiv exact i64 _, 8   → ashr exact i64 _, 3   (catalog L1)
;   v3,v4,v6 region: 3 scalar instrs (sub, sdiv exact, sdiv exact)
;     → 7 vector instrs (3 inserts, vector sub, vector sdiv,
;        2 extracts) on the post side. Multi-side rewrite.
;   v5: add nsw a, b           → add nsw b, a         (catalog L3 add-comm)
;
; Per-lane lifting:
;   Lane 0 of post's %4 = sdiv exact ((p3 - p4), 24) — equals pre's v4.
;   Lane 1 of post's %4 = sdiv exact ((p5 - 0), 24) — equals pre's v6
;     modulo the trivial identity sub x, 0 ≡ x.
;
; LLM-guessed assume:
;   A_lane0: lane 0 of post's %2 equals %p4 (non-poison).
;     The initial constant <i64 poison, i64 0> has poison in lane 0, but
;     the next insertelement at index 0 overwrites it before any read.
;     Verified standalone on the insertelement chain.
;
; Lemmas:
;   L_vec: sub <N x T> a,b decomposes lane-wise; same for sdiv exact.
;     (Structural axiom about LLVM vector arithmetic.)
;   L_subzero: sub i64 x, 0 ≡ x. Trivial.
;   L1, L3: as in the catalog.
;
; alive-tv-next target: identify the multi-side region; emit two per-lane
; equivalence subproblems; verify A_lane0 standalone; dispatch each per-
; lane problem via L1/L3/L_subzero.

define i64 @src(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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

define i64 @tgt(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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
