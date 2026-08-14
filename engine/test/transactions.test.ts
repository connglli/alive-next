// Transactions.
//
// llops is the real binary, since the edits have to be real ones, and the
// checker is a stand-in so that committing costs no solver. Skips when llops
// is not built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Goal, Tree } from "../core/state/goals.ts";
import { derive, head } from "../core/state/goals.ts";
import { Steps } from "../core/state/steps.ts";
import { Store } from "../core/state/store.ts";
import type { Entry, Event } from "../core/state/trajectory.ts";
import { TransactionError, Transactions } from "../core/state/transactions.ts";
import { toolchain } from "./toolchain-under-test.ts";

class FakeChecker {
  readonly calls: { src: string; tgt: string }[] = [];
  constructor(private outcomes: CheckOutcome[]) {}
  async check(src: string, tgt: string): Promise<CheckResult> {
    this.calls.push({ src, tgt });
    const outcome = this.outcomes.shift() ?? "unknown";
    return {
      outcome,
      detail: "",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 0 },
      stdout: "",
      ms: 1,
    };
  }
}

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const PROGRAM = `define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %x, %y
  %s = add i32 %m, %x
  ret i32 %s
}
`;

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-tx-"));
  store = new Store(join(dir, "store"), async (text) => {
    const result = await llops.canon(text);
    if (!result.ok) throw new Error(result.message);
    return result.module;
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The goal an id names, so the tests need no null checks of their own. */
function goal(goals: Tree, id: string): Goal {
  const found = goals.goals.get(id);
  if (!found) throw new Error(`no goal ${id}`);
  return found;
}

async function tree() {
  const src = await store.put(PROGRAM);
  const tgt = await store.put(PROGRAM.replace("%m, %x", "%x, %m"));
  const events: Event[] = [{ kind: "run_start", src, tgt, config: {}, versions: {} }];
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

describe.skipIf(!built)("transactions", () => {
  test("opens on the head of the side it names", async () => {
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    const transaction = transactions.begin(goals, "g1", "src");

    expect(transaction.from).toBe(head(goal(goals, "g1"), "src"));
    expect(transaction.text).toBe(store.get(transaction.from));
    expect(transactions.isEditing("g1", "src")).toBe(true);
    expect(transactions.isEditing("g1", "tgt")).toBe(false);
  });

  test("edits the scratch without touching the head", async () => {
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    const before = head(goal(goals, "g1"), "src");
    transactions.begin(goals, "g1", "src");

    const edited = await transactions.edit({ op: "commute", v: "%2" });
    if (edited.kind !== "applied") {
      throw new Error(edited.kind === "refused" ? edited.message : "edit unchanged");
    }
    expect(edited.text).toContain("mul i32 %1, %0");
    // The store still holds only what it held: scratch is not a program yet.
    expect(store.has(before)).toBe(true);
    expect(head(goal(goals, "g1"), "src")).toBe(before);
  });

  test("a refused edit leaves the scratch as it was", async () => {
    const transactions = new Transactions(store, llops);
    transactions.begin(await tree(), "g1", "src");
    const before = transactions.open()?.text;

    const refused = await transactions.edit({ op: "commute", v: "%nope" });
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.code).toBe("not_found");
    expect(transactions.open()?.text).toBe(before as string);
    expect(transactions.open()?.ops).toEqual([]);
  });

  test("commits the whole session as one step", async () => {
    const checker = new FakeChecker(["correct", "unknown"]);
    const steps = new Steps(store, checker);
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    const before = store.get(head(goal(goals, "g1"), "src"));

    transactions.begin(goals, "g1", "src");
    await transactions.edit({ op: "commute", v: "%2" });
    await transactions.edit({ op: "commute", v: "%3" });
    const result = await transactions.commit(goals, steps);

    if (result.kind !== "certified") throw new Error("expected the commit to land");
    // Two edits, one certified step: the pair alive2 saw is the whole session.
    expect(checker.calls[0]?.src).toBe(before);
    expect(checker.calls[0]?.tgt).toContain("mul i32 %1, %0");
    expect(result.effects[0]).toMatchObject({ effect: "step", gid: "g1", side: "src" });
    expect(transactions.open()).toBeUndefined();
  });

  test("a refused commit leaves the head alone and closes the session", async () => {
    const steps = new Steps(store, new FakeChecker(["incorrect"]));
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    const before = head(goal(goals, "g1"), "src");

    transactions.begin(goals, "g1", "src");
    await transactions.edit({ op: "commute", v: "%2" });
    const result = await transactions.commit(goals, steps);

    expect(result.kind).toBe("refused");
    expect(head(goal(goals, "g1"), "src")).toBe(before);
    // The answer is about the pair, so there is nothing to keep editing from.
    expect(transactions.open()).toBeUndefined();
  });

  test("committing with no edits is refused without a solver", async () => {
    const checker = new FakeChecker([]);
    const transactions = new Transactions(store, llops);
    const goals = await tree();

    transactions.begin(goals, "g1", "src");
    const result = await transactions.commit(goals, new Steps(store, checker));

    expect(result.kind).toBe("refused");
    expect(checker.calls).toHaveLength(0);
  });

  test("aborting throws the scratch away", async () => {
    const transactions = new Transactions(store, llops);
    transactions.begin(await tree(), "g1", "tgt");
    await transactions.edit({ op: "commute", v: "%2" });

    const aborted = transactions.abort();
    expect(aborted.ops).toHaveLength(1);
    expect(transactions.open()).toBeUndefined();
  });

  test("only one session at a time", async () => {
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    transactions.begin(goals, "g1", "src");
    expect(() => transactions.begin(goals, "g1", "tgt")).toThrow(TransactionError);
  });

  test("editing, committing and aborting need a session", async () => {
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    await expect(transactions.edit({ op: "commute", v: "%2" })).rejects.toThrow(
      /no transaction is open/,
    );
    await expect(transactions.commit(goals, new Steps(store, new FakeChecker([])))).rejects.toThrow(
      /no transaction is open/,
    );
    expect(() => transactions.abort()).toThrow(/no transaction is open/);
  });

  test("refuses to open on a goal that is not open", async () => {
    const transactions = new Transactions(store, llops);
    const goals = await tree();
    expect(() => transactions.begin(goals, "g9", "src")).toThrow(/no goal g9/);
  });
});
