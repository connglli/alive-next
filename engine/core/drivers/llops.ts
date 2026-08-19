// Driving llops, the native LLVM toolbox.
//
// One process per request, one JSON object each way, as docs/llops.md sets
// out. Everything llops can refuse is a value here rather than an exception:
// the codes are what a tool branches on, and a refusal is the normal case
// while an agent searches. Only a broken invocation throws, because a binary
// that will not run or will not answer in JSON is a bug in us, not a move the
// agent made.
import type { Ref } from "../refs.ts";

/** A program, as IR text. */
export type Module = string;

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
}

/** Every llops answer: the payload, or the code and message it refused with. */
export type LlopsResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

export interface ValidateResult {
  conforms: boolean;
  diagnostics: Diagnostic[];
}

export interface ModuleResult {
  module: Module;
}

/** One entry of the shared signature an outline produces. */
export interface OutlineParam {
  param: Ref;
  type: string;
  live: Ref;
}

export interface OutlineResult {
  outer: Module;
  callee: Module;
  params: OutlineParam[];
  /** The one value a window hands back, absent when nothing outside uses it. */
  result?: { type: string; live: Ref };
}

export type AnalyzeKind = "knownbits" | "ranges" | "pointer" | "defined";

/** A fact about one value. Which fields are present follows the kind. */
export interface Fact {
  value: Ref;
  type: string;
  zero_bits?: string;
  one_bits?: string;
  unknown_bits?: string;
  signed_min?: string;
  signed_max?: string;
  unsigned_min?: string;
  unsigned_max?: string;
  align?: number;
  dereferenceable?: number;
  nonnull?: boolean;
  /** Neither undef nor poison, in the sense the attribute has. */
  noundef?: boolean;
  not_undef?: boolean;
  not_poison?: boolean;
}

/** One argument for a harness, matched to the entry's parameter by position. */
export type HarnessArg =
  | { kind: "int"; value: string }
  | { kind: "bytes"; bytes: number[]; align?: number }
  | { kind: "null" };

export interface HarnessResult {
  module: Module;
  /** The names to look for in llubi's trace, in the order they are produced. */
  observations: Ref[];
}

export interface AnalyzeResult {
  kind: AnalyzeKind;
  point: Ref;
  facts: Fact[];
}

/** The edit catalog, one member per op, as docs/llops.md lists it. */
export type EditOp =
  | { op: "swap"; a: Ref; b: Ref }
  | { op: "move"; v: Ref; where: "before" | "after"; w: Ref }
  | { op: "substitute"; a: Ref; b: Ref }
  | { op: "replace"; v: Ref; insts: string[] }
  | { op: "insert"; where: "before" | "after"; w: Ref; insts: string[] }
  | { op: "erase"; v: Ref; cascade?: boolean }
  | { op: "commute"; v: Ref }
  | { op: "retype"; v: Ref; ty: string; ext?: "zext" | "sext" }
  | { op: "dedup"; a: Ref; b: Ref }
  | { op: "set_body"; body: string }
  | { op: "attrs"; fn: string; param: number; attrs: Record<string, unknown> }
  | { op: "flags"; v: Ref; flags: Record<string, boolean> };

/** One structural optimizer pass, as the `opt` subcommand takes it. */
export type OptOp = { what: "simplify"; v: Ref } | { what: "instcombine"; max_iterations?: number };

/** Thrown when llops cannot be run or does not answer in JSON. */
export class LlopsCrash extends Error {
  constructor(
    readonly subcommand: string,
    message: string,
  ) {
    super(`llops ${subcommand}: ${message}`);
    this.name = "LlopsCrash";
  }
}

export class Llops {
  constructor(private readonly path: string = "llops") {}

  validate(module: Module): Promise<LlopsResult<ValidateResult>> {
    return this.run("validate", { module });
  }

  canon(module: Module): Promise<LlopsResult<ModuleResult>> {
    return this.run("canon", { module });
  }

  edit(module: Module, op: EditOp): Promise<LlopsResult<ModuleResult>> {
    return this.run("edit", { module, ...op });
  }

  /** Cut the src side at `cut`; the signature comes back in the response. */
  outlineSrc(module: Module, cut: Ref, callee: string): Promise<LlopsResult<OutlineResult>> {
    return this.run("outline", { module, side: "src", cut, callee });
  }

  /** Cut the tgt side against the signature the src side produced. */
  outlineTgt(
    module: Module,
    cut: Ref,
    callee: string,
    params: OutlineParam[],
    valueMap: Record<Ref, Ref>,
  ): Promise<LlopsResult<OutlineResult>> {
    return this.run("outline", {
      module,
      side: "tgt",
      cut,
      callee,
      params,
      value_map: valueMap,
    });
  }

  /**
   * Outline the window from `from` to `to`, leaving the rest where it is. A
   * window belongs to one program rather than to a pair of them, so it takes
   * no side and no value map: what says two of them line up is their outers
   * coming out the same.
   */
  outlineWindow(
    module: Module,
    from: Ref,
    to: Ref,
    callee: string,
  ): Promise<LlopsResult<OutlineResult>> {
    return this.run("outline", { module, cut: from, to, callee });
  }

  inline(outer: Module, callee: Module, calleeName: string): Promise<LlopsResult<ModuleResult>> {
    return this.run("inline", { outer, callee, callee_name: calleeName });
  }

  analyze(module: Module, kind: AnalyzeKind, point?: Ref): Promise<LlopsResult<AnalyzeResult>> {
    return this.run("analyze", point ? { module, kind, point } : { module, kind });
  }

  /** Apply one structural optimizer op to an instruction or the whole function. */
  opt(module: Module, op: OptOp): Promise<LlopsResult<ModuleResult>> {
    return this.run("opt", { module, ...op });
  }

  /**
   * State a fact about a value, either before an instruction or before a call
   * about one of its arguments. The two ways of saying where are exclusive.
   */
  assume(
    module: Module,
    where:
      | { before: Ref; value: Ref; fact: Record<string, unknown> }
      | { before_call: string; arg: number; fact: Record<string, unknown> },
  ): Promise<LlopsResult<ModuleResult>> {
    return this.run("assume", { module, ...where });
  }

  /** Wrap a function in the main llubi runs, with these argument values. */
  harness(module: Module, entry: string, args: HarnessArg[]): Promise<LlopsResult<HarnessResult>> {
    return this.run("harness", { module, entry, args });
  }

  /** The version line, which a run records to say what produced its programs. */
  async version(): Promise<string> {
    const child = Bun.spawn([this.path, "version"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (child.exitCode !== 0) throw new LlopsCrash("version", `exit ${child.exitCode}`);
    return out.trim();
  }

  private async run<T>(subcommand: string, request: unknown): Promise<LlopsResult<T>> {
    const spawn = () =>
      Bun.spawn([this.path, subcommand], {
        stdin: new TextEncoder().encode(JSON.stringify(request)),
        stdout: "pipe",
        stderr: "pipe",
      });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn();
    } catch (error) {
      throw new LlopsCrash(subcommand, `cannot run ${this.path}: ${(error as Error).message}`);
    }

    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      // Exit 2 is a command line llops did not understand, and anything else
      // without JSON means it died before it could answer.
      const detail = err.trim() || out.trim() || "no output";
      throw new LlopsCrash(subcommand, `exit ${child.exitCode}, ${detail}`);
    }

    const response = parsed as Record<string, unknown>;
    if (response.ok === true) return response as LlopsResult<T>;
    const error = (response.error ?? {}) as Record<string, unknown>;
    if (typeof error.code !== "string") {
      throw new LlopsCrash(subcommand, `answered without an error code: ${out.trim()}`);
    }
    return { ok: false, code: error.code, message: String(error.message ?? "") };
  }
}

/**
 * The instruction lines of a program's body block, terminator included.
 * Scans for entry: and closing brace. A body too small to be worth narrowing
 * is returned as-is: it is the callers, who know what they can outline, that
 * decline it.
 */
export function moduleLines(module: Module): string[] | undefined {
  const lines = module.split("\n");
  const entry = lines.indexOf("entry:");
  if (entry < 0) return undefined;
  const end = lines.indexOf("}", entry);
  if (end < 0) return undefined;
  return lines
    .slice(entry + 1, end)
    .map((l) => l.trim())
    .filter(Boolean);
}
