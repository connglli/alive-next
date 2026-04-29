; Example 1' — variant of Example 1 with ptrtoint and add commutativity.
;
; Source: real corpus slice; nearly isomorphic to Example 1 but adds:
;   - a ptrtoint at v0 that's identical between src and tgt (identity path)
;   - add-commutativity at v7 (sibling of mul-comm)
;
; Diff:
;   v2: sdiv exact i64 _, 8  → ashr exact i64 _, 3       (catalog L1)
;   v4: mul nsw i64 a, b     → mul nsw i64 b, a          (catalog L3 mul-comm)
;   v6: sdiv exact i64 _, 16 → ashr exact i64 _, 4       (catalog L2)
;   v7: add nsw i64 a, b     → add nsw i64 b, a          (catalog add-comm)
;
; alive-tv-next target: same as Example 1 plus add-comm catalog entry; the
; ptrtoint at v0 takes the identity path (no cut needed).

define i64 @src(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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

define i64 @tgt(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) {
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
