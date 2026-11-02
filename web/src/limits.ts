export const INPUT_BYTES = 64 * 1024;
export const INPUT_LABEL = `${INPUT_BYTES / 1024} KiB`;
export const CHECK_MS = 1000;

export interface Budget {
  ms: number;
  cuts: number;
  unfolds: number;
}

export const DEFAULT_BUDGET: Budget = { ms: 60_000, cuts: 8, unfolds: 2 };
export const TIMEOUT_SECONDS = [5, 30, 60, 120, 300, 600];

// Browsers wrap larger setTimeout delays into an immediate timeout.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// Both the UI and worker validate budgets before passing them to the searcher.
export function validateBudget(value: unknown): Budget {
  const budget = value as Budget;
  if (!budget || !Number.isSafeInteger(budget.ms) || budget.ms <= 0 || budget.ms > MAX_TIMEOUT_MS)
    throw new Error(`Timeout must be positive and at most ${MAX_TIMEOUT_MS / 1000} seconds`);

  for (const key of ["cuts", "unfolds"] as const) {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0)
      throw new Error(`${key} must be a nonnegative whole number`);
  }

  return { ms: budget.ms, cuts: budget.cuts, unfolds: budget.unfolds };
}
