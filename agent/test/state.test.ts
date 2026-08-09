// The store and the trajectory: content addressing and the hash chain.
//
// Both are about detecting a file that changed underneath us, so the tests
// that matter are the ones that alter a file and expect a complaint.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/state/hash.ts";
import { Store, StoreCorrupt } from "../src/state/store.ts";
import { parse, Trajectory, TrajectoryBroken } from "../src/state/trajectory.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stands in for `llops canon`: enough to tell canonical text from raw. */
const canonicalize = async (text: string) => `${text.trim()}\n`;

describe("the store", () => {
  test("names a program by the hash of its canonical text", async () => {
    const store = new Store(join(dir, "store"), canonicalize);
    const hash = await store.put("  define void @f() {}  ");
    expect(hash).toBe(sha256("define void @f() {}\n"));
    expect(store.get(hash)).toBe("define void @f() {}\n");
  });

  test("gives two spellings of one program the same hash", async () => {
    const store = new Store(join(dir, "store"), canonicalize);
    const first = await store.put("define void @f() {}");
    const second = await store.put("\ndefine void @f() {}\n\n");
    expect(second).toBe(first);
    expect(store.hashes()).toEqual([first]);
  });

  test("notices a program that changed underneath it", async () => {
    const store = new Store(join(dir, "store"), canonicalize);
    const hash = await store.put("define void @f() {}");
    writeFileSync(join(dir, "store", `${hash}.ll`), "define void @g() {}\n");
    expect(() => store.get(hash)).toThrow(StoreCorrupt);
  });

  test("knows what it holds", async () => {
    const store = new Store(join(dir, "store"), canonicalize);
    const hash = await store.put("define void @f() {}");
    expect(store.has(hash)).toBe(true);
    expect(store.has(sha256("something else"))).toBe(false);
  });
});

describe("the trajectory", () => {
  const path = () => join(dir, "trajectory.jsonl");

  test("chains each line to the one before it", () => {
    const log = new Trajectory(path());
    log.append({ kind: "message", message: "first" });
    log.append({ kind: "message", message: "second" });

    const lines = readFileSync(path(), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).prev).toBe("");
    expect(JSON.parse(lines[1] as string).prev).toBe(sha256(lines[0] as string));
  });

  test("reads back what it wrote, in order", () => {
    const log = new Trajectory(path());
    log.append({ kind: "run_start", src: "aa", tgt: "bb", config: {}, versions: {} });
    log.append({ kind: "tool_call", id: "1", tool: "check", args: { gid: "g1" } });
    log.append({ kind: "tool_result", id: "1", tool: "check", result: "proved", ms: 12 });

    const entries = log.read();
    expect(entries.map((entry) => entry.kind)).toEqual(["run_start", "tool_call", "tool_result"]);
    expect(entries[0]?.time).toBeGreaterThan(0);
  });

  test("continues the chain of a file it did not start", () => {
    const first = new Trajectory(path());
    first.append({ kind: "message", message: "before the crash" });

    const resumed = new Trajectory(path());
    resumed.append({ kind: "message", message: "after it" });

    expect(resumed.read()).toHaveLength(2);
  });

  test("says which line an alteration broke", () => {
    const log = new Trajectory(path());
    log.append({ kind: "message", message: "one" });
    log.append({ kind: "message", message: "two" });
    log.append({ kind: "message", message: "three" });

    const lines = readFileSync(path(), "utf8").split("\n").filter(Boolean);
    const tampered = lines.map((line) => line.replace('"two"', '"TWO"'));
    writeFileSync(path(), `${tampered.join("\n")}\n`);

    // The altered line still follows its predecessor; the one after it does
    // not, which is where the chain reports the break.
    expect(() => new Trajectory(path()).read()).toThrow(TrajectoryBroken);
    try {
      new Trajectory(path()).read();
    } catch (error) {
      expect((error as TrajectoryBroken).line).toBe(3);
    }
  });

  test("notices a line that was removed", () => {
    const log = new Trajectory(path());
    log.append({ kind: "message", message: "one" });
    log.append({ kind: "message", message: "two" });
    log.append({ kind: "message", message: "three" });

    const lines = readFileSync(path(), "utf8").split("\n").filter(Boolean);
    writeFileSync(path(), `${[lines[0], lines[2]].join("\n")}\n`);

    expect(() => new Trajectory(path()).read()).toThrow(TrajectoryBroken);
  });

  test("parses text without a session on disk", () => {
    const log = new Trajectory(path());
    log.append({ kind: "verdict", outcome: "unknown" });
    expect(parse(readFileSync(path(), "utf8"))[0]?.kind).toBe("verdict");
  });

  test("reads an absent trajectory as no events", () => {
    expect(new Trajectory(join(dir, "fresh", "trajectory.jsonl")).read()).toEqual([]);
  });
});
