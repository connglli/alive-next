; Example 2 — multi-instr catalog dispatch (Phase 2).
;
; Source: real corpus slice. The interesting diff is at v3+v4: two
; consecutive instructions change in lockstep, neither sensible alone.
;
;   v1: sdiv exact i64 _, 8  → ashr exact i64 _, 3       (catalog L1)
;   v3,v4 (PAIR): zext+sub-nsw  → sext+add-nsw           (catalog L4 multi-line)
;     pre:  v3 = zext i1 v2 to i64 ; v4 = sub nsw v1, v3
;     post: v3.neg = sext i1 v2 to i64 ; v4 = add nsw v1, v3.neg
;     L4: ∀ b:i1, x:i64. sub nsw x, (zext b to i64) ≡ add nsw x, (sext b to i64)
;     (Argument: sext(b) = -zext(b) on i1; nsw poison conditions coincide
;     on the boundary case x=INT64_MIN ∧ b=1.)
;   v5: mul nsw i64 a, b     → mul nsw i64 b, a          (catalog L3 mul-comm)
;
; alive-tv-next target: per-line cut at v1; multi-line cut grouping v3+v4
; (operand chain crosses the diff); per-line cut at v5.

define i64 @src(i64 %p0, i64 %p1, ptr %p2, i64 %p3, i64 %p4) {
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

define i64 @tgt(i64 %p0, i64 %p1, ptr %p2, i64 %p3, i64 %p4) {
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
