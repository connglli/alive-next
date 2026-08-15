// Transactions: editing one side of one goal without certifying each edit.
//
// Between begin and commit the agent rewrites a scratch program and gets cheap
// feedback from llops, no solver involved. At commit the whole before and
// after pair is certified as a single step, which is why a checked rewrite
// needs no concept of its own: it is a transaction with one edit.
//
// The scratch never reaches the store. A caller chooses whether a rejected
// commit discards it; certification is always the only way it reaches the
// store. A run resumed from its trajectory therefore starts with no
// transaction open, and the log says one was.
//
// One transaction at a time, which is what lets edit, commit and abort take no
// target: the agent is editing one thing or nothing.
import type { EditOp, Llops, OptOp } from "../drivers/llops.ts";
import { head, type Side, type Tree, workable } from "./goals.ts";
import { narrow, narrowAt, type Window } from "./narrow.ts";
import type { StepResult, Steps } from "./steps.ts";
import type { Store } from "./store.ts";
import type { Hash } from "./trajectory.ts";

export interface Transaction {
  gid: string;
  side: Side;
  /** The head it opened on, which is the before half of the commit. */
  from: Hash;
  /** The scratch program as it stands. */
  text: string;
  /** The ops applied so far, in order. */
  ops: (EditOp | OptOp)[];
}

/** A tree move cannot proceed until the open scratch is committed or aborted. */
export interface EditingRefusal {
  kind: "editing";
  message: string;
}

/**
 * An edit that took, or the diagnostic llops refused it with.
 *
 * Both carry the scratch program: after an edit it is what the next op works
 * on, and after a refusal it is what the refused op was addressing, which is
 * where a caller looks to find the reference it meant.
 */
export type EditResult =
  | { kind: "applied"; text: string; ops: number }
  | { kind: "unchanged"; text: string; ops: number }
  | { kind: "refused"; code: string; message: string; text: string };

/** Thrown when the agent asks for something the session cannot mean. */
export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionError";
  }
}

export class Transactions {
  private current?: Transaction;

  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
  ) {}

  /** The transaction in progress, if the agent has one open. */
  open(): Transaction | undefined {
    return this.current;
  }

  /** Whether a goal, or one side of it, is being edited and closed to other tools. */
  isEditing(gid: string, side?: Side): boolean {
    return this.current?.gid === gid && (side === undefined || this.current.side === side);
  }

  /** Whether undoing `gid`'s subtree would discard the open transaction. */
  isEditingBelow(tree: Tree, gid: string): boolean {
    if (!this.current) return false;
    for (let goal = tree.goals.get(this.current.gid); goal; ) {
      if (goal.id === gid) return true;
      goal = goal.parent === undefined ? undefined : tree.goals.get(goal.parent);
    }
    return false;
  }

  begin(tree: Tree, gid: string, side: Side): Transaction {
    if (this.current) {
      throw new TransactionError(
        `a transaction is already open on ${this.current.gid} ${this.current.side}`,
      );
    }
    const goal = workable(tree, gid);
    const from = head(goal, side);
    this.current = { gid, side, from, text: this.store.get(from), ops: [] };
    return this.current;
  }

  /**
   * Apply one op to the scratch program. A refusal leaves the scratch as it
   * was, so the agent can try something else without starting over.
   */
  async edit(op: EditOp): Promise<EditResult> {
    const transaction = this.require();
    const result = await this.llops.edit(transaction.text, op);
    if (!result.ok) {
      return {
        kind: "refused",
        code: result.code,
        message: result.message,
        text: transaction.text,
      };
    }
    transaction.text = result.module;
    transaction.ops.push(op);
    return { kind: "applied", text: result.module, ops: transaction.ops.length };
  }

  /**
   * Apply one structural optimizer pass to the scratch program. A refusal
   * leaves the scratch as it was, exactly as a refused edit does.
   */
  async opt(op: OptOp): Promise<EditResult> {
    const transaction = this.require();
    const result = await this.llops.opt(transaction.text, op.what, op.v);
    if (!result.ok) {
      return {
        kind: "refused",
        code: result.code,
        message: result.message,
        text: transaction.text,
      };
    }
    if (result.module === transaction.text) {
      return { kind: "unchanged", text: transaction.text, ops: transaction.ops.length };
    }
    transaction.text = result.module;
    transaction.ops.push(op);
    return { kind: "applied", text: result.module, ops: transaction.ops.length };
  }

  /**
   * Certify the scratch program as one step. `imm_abort` keeps the core's
   * one-shot behavior by discarding scratch before validation; callers that
   * set it false retain rejected candidates for further edits.
   */
  async commit(
    tree: Tree,
    steps: Steps,
    options?: {
      window?: Window;
      preconditions?: Record<string, Record<string, unknown>>;
    },
    imm_abort: boolean = true,
  ): Promise<StepResult> {
    const transaction = this.require();
    if (imm_abort) this.current = undefined;
    // A commit is the step that is usually local, so it is the one that looks
    // for the window it touched: a rewrite of two instructions should not be
    // asked as a question about the whole function.
    const goal = workable(tree, transaction.gid);
    const before = this.store.get(head(goal, transaction.side));
    const narrowed = options?.window
      ? await narrowAt(this.llops, before, transaction.text, options.window)
      : await narrow(this.llops, before, transaction.text);
    // An agent-named window is a request, not a hint: when the search finds no
    // window it is right to fall back to the whole function, but a window the
    // caller named and that will not outline means the caller asked for
    // something this pair cannot express, which is worth saying rather than
    // silently proving something larger.
    if (options?.window && !narrowed) {
      return {
        kind: "refused",
        check: {
          outcome: "error",
          detail: "the window it was asked to outline does not resolve",
          invocation: { binary: "", flags: [], timeoutMs: 0 },
          stdout: "",
          ms: 0,
        },
      };
    }
    const result = await steps.step(tree, transaction.gid, transaction.side, transaction.text, {
      narrowed,
      preconditions: options?.preconditions,
    });
    if (!imm_abort && result.kind === "certified") this.current = undefined;
    return result;
  }

  /** Throw the scratch away. Nothing was certified, so nothing is undone. */
  abort(): Transaction {
    const transaction = this.require();
    this.current = undefined;
    return transaction;
  }

  private require(): Transaction {
    if (!this.current) throw new TransactionError("no transaction is open");
    return this.current;
  }
}
