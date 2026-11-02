import { expect, test } from "bun:test";
import { DEFAULT_BUDGET, MAX_TIMEOUT_MS, validateBudget } from "../src/limits.ts";

test("budget validation preserves disabled cuts/unfolds and custom milliseconds", () => {
  expect(validateBudget({ ms: 137500, cuts: 0, unfolds: 0 })).toEqual({
    ms: 137500,
    cuts: 0,
    unfolds: 0,
  });
  expect(validateBudget(DEFAULT_BUDGET)).toEqual(DEFAULT_BUDGET);
});

test("budget validation rejects invalid or overflowing timer delays", () => {
  for (const ms of [0, -1, 1.5, NaN, Infinity, MAX_TIMEOUT_MS + 1])
    expect(() => validateBudget({ ...DEFAULT_BUDGET, ms })).toThrow("Timeout");
  expect(validateBudget({ ...DEFAULT_BUDGET, ms: MAX_TIMEOUT_MS }).ms).toBe(MAX_TIMEOUT_MS);
});

test("cut and unfold budgets must be nonnegative safe integers", () => {
  for (const key of ["cuts", "unfolds"] as const)
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => validateBudget({ ...DEFAULT_BUDGET, [key]: value })).toThrow(key);
});
