; Example 1 — single-instr catalog dispatch (Phase 1).
;
; Source: real corpus slice; alive-tv timed out on the whole-slice query
; in the original run. Diff is four single-instruction rewrites:
;   v1: sdiv exact i64 _, 8  → ashr exact i64 _, 3      (catalog L1)
;   v3: mul nsw i64 a, b     → mul nsw i64 b, a         (catalog L3, mul-comm)
;   v4: sdiv exact i64 _, 16 → ashr exact i64 _, 4      (catalog L2)
;   v6: sdiv exact i64 _, 16 → ashr exact i64 _, 4      (catalog L2)
;
; alive-tv-next target: cuts at v1, v3, v4, v6; each dispatches to a
; catalog rule. No assumes needed.

define i64 @src(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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

define i64 @tgt(i64 %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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
