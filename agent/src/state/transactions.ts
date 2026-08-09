// Transactions: editing one side of one goal without certifying each edit.
//
// Between begin and commit the agent rewrites a scratch program and gets cheap
// feedback from llops, no solver involved. At commit the whole before and
// after pair is certified as a single step, which is why a checked rewrite
// needs no concept of its own: it is a transaction with one edit.
//
// The scratch never reaches the store. It is held here until commit, so a
// program only becomes something the certificate can refer to once alive2 has
// agreed to it. A run resumed from its trajectory therefore starts with no
// transaction open, and the log says one was.
//
// One transaction at a time, which is what lets edit, commit and abort take no
// target: the agent is editing one thing or nothing.
import type { EditOp, Llops } from "../drivers/llops.ts";
import { head, type Side, type Tree } from "./goals.ts";
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
  ops: EditOp[];
}

/** An edit that took, or the diagnostic llops refused it with. */
export type EditResult =
  | { kind: "applied"; text: string; ops: number }
  | { kind: "refused"; code: string; message: string };

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

  /** Whether a goal side is being edited, and so closed to other tools. */
  isEditing(gid: string, side: Side): boolean {
    return this.current?.gid === gid && this.current.side === side;
  }

  begin(tree: Tree, gid: string, side: Side): Transaction {
    if (this.current) {
      throw new TransactionError(
        `a transaction is already open on ${this.current.gid} ${this.current.side}`,
      );
    }
    const goal = tree.goals.get(gid);
    if (!goal) throw new TransactionError(`no goal ${gid}`);
    if (goal.status !== "open") {
      throw new TransactionError(`${gid} is ${goal.status}, not open`);
    }
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
    if (!result.ok) return { kind: "refused", code: result.code, message: result.message };
    transaction.text = result.module;
    transaction.ops.push(op);
    return { kind: "applied", text: result.module, ops: transaction.ops.length };
  }

  /**
   * Certify the whole session as one step. The head advances only if alive2
   * agrees; either way the transaction is over, because a failed commit is an
   * answer about the pair rather than a state to keep editing from.
   */
  async commit(tree: Tree, steps: Steps): Promise<StepResult> {
    const transaction = this.require();
    this.current = undefined;
    return steps.step(tree, transaction.gid, transaction.side, transaction.text);
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
