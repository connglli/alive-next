; Variant B — multi-instr rewrite combining algebraic rearrangement,
; strength reduction, and flag relaxation (Phase 2).
;
; Source: real corpus slice.
;
; Diff:
;   v0,v1 (PAIR): add-nsw + mul-nsw  → shl + add         (catalog L_v0v1)
;     pre:  v0 = add nsw p0, 1  ; v1 = mul nsw 4, v0     ; computes 4*(p0+1)
;     post: v0 = shl p0, 2      ; v1 = add v0, 4         ; computes 4*p0+4
;     Same value modulo arithmetic identity. Post drops nsw (more defined →
;     refinement direction). Strength reduction *4 → shl 2 also folded in.
;     Verified standalone as a small i64 query.
;   v3: mul nsw 4, x  → shl nsw x, 2                     (catalog mul-pow2-shl
;     with operand swap; nsw preserved here unlike v0/v1)
;
; alive-tv-next target: multi-line cut at v0+v1 (different opcodes on each
; side, operand chain crosses); single-instr cut at v3.

define i64 @src(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = add nsw i64 %p0, 1
  %v1 = mul nsw i64 4, %v0
  %v2 = sdiv i64 %p1, %v1
  %v3 = mul nsw i64 4, %v2
  %v4 = sub nsw i64 %p2, %v3
  ret i64 %v4
}

define i64 @tgt(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = shl i64 %p0, 2
  %v1 = add i64 %v0, 4
  %v2 = sdiv i64 %p1, %v1
  %v3 = shl nsw i64 %v2, 2
  %v4 = sub nsw i64 %p2, %v3
  ret i64 %v4
}
