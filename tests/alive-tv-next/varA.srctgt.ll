; Variant A — flag-addition with no-overflow assume (Phase 3).
;
; Source: real corpus slice. The interesting bit at v2:
;   pre:  mul i64 v0, v1            (no flag, full wraparound, never poison)
;   post: mul nsw i64 v1, v0        (operand swap + nsw added)
;
; Adding nsw is normally MORE poison (post poison on overflow; pre is
; wraparound), which is the wrong direction for refinement — sound only
; when the multiplication provably never signed-overflows.
;
; What alive-tv-next must derive (internally, not part of this input):
;   The mul-nsw-add catalog rule has a precondition "no signed overflow."
;   Both v0 and v1 are sext from i32, so each is in [-2^31, 2^31-1]; their
;   product is bounded by 2^62, well inside i64 — overflow is impossible.
;
;   alive-tv-next (Phase 3+) proposes the assume "v0 * v1 does not signed-
;   overflow" (e.g., via `llvm.smul.with.overflow.i64` + extracted
;   overflow bit), verifies it standalone using the sext-derived range
;   bounds, then injects `llvm.assume` into the per-cut alive2 query so
;   the nsw addition verifies cleanly.

define ptr @src(i32 %p0, i32 %p1, i64 %p2, ptr %p3) {
entry:
  %v0 = sext i32 %p0 to i64
  %v1 = sext i32 %p1 to i64
  %v2 = mul i64 %v0, %v1
  %v3 = mul i64 %v2, %p2
  %v4 = getelementptr inbounds i8, ptr %p3, i64 %v3
  ret ptr %v4
}

define ptr @tgt(i32 %p0, i32 %p1, i64 %p2, ptr %p3) {
entry:
  %v0 = sext i32 %p0 to i64
  %v1 = sext i32 %p1 to i64
  %v2 = mul nsw i64 %v1, %v0
  %v3 = mul i64 %v2, %p2
  %v4 = getelementptr inbounds i8, ptr %p3, i64 %v3
  ret ptr %v4
}
