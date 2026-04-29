; Example 4 — purely scalar assume-needed: freeze drop with
; range-from-mask assume (Phase 3).
;
; Source: synthetic. Pedagogical illustration; the rewrite *family* (drop
; freeze whenever the operand is provably non-poison, often via an and-
; derived range) is common in real LLVM output (InstSimplify).
;
; Diff: single change — v2 = freeze v1 removed, v3 reads v1 directly.
;
; What alive-tv-next must derive (internally, not part of this input):
;   The freeze-drop catalog rule has a precondition "operand is non-poison."
;   v1 = shl i64 %p1, %v0 is non-poison iff %v0 < 64 (i64 bitwidth).
;   The fact %v0 < 64 is locally derivable from %v0 = and i64 %p0, 31
;   (which forces %v0 ∈ [0, 31]).
;
;   alive-tv-next (Phase 3+) proposes the assume `icmp ult i64 %v0, 64`,
;   verifies it standalone, then injects `llvm.assume` into the per-cut
;   alive2 query so the freeze drop verifies cleanly.

define i64 @src(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = and i64 %p0, 31
  %v1 = shl i64 %p1, %v0
  %v2 = freeze i64 %v1
  %v3 = mul nsw i64 %v2, %p2
  ret i64 %v3
}

define i64 @tgt(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = and i64 %p0, 31
  %v1 = shl i64 %p1, %v0
  %v3 = mul nsw i64 %v1, %p2
  ret i64 %v3
}
