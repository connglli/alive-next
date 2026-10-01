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

export interface FunctionParamMeta {
  index: number;
  type: string;
  attrs: Record<string, unknown>;
}

export interface FunctionMeta {
  defined: boolean;
  return_type: string;
  params: FunctionParamMeta[];
  fn_attrs: Record<string, unknown>;
  signature: string;
  bare: boolean;
}

export interface ValidateResult {
  conforms: boolean;
  /** Whether the body holds a loop. */
  cyclic: boolean;
  diagnostics: Diagnostic[];
  functions?: Record<string, FunctionMeta>;
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
  result?: { type: string; live: Ref[] };
}

/** What `detach` answers: an outline, the hypothesis, and which parameters were phis. */
export interface DetachResult extends OutlineResult {
  hypothesis?: string;
  phis?: number[];
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

/** Attributes dictionary for functions or parameters (e.g. { noundef: true, memory: "none", range: ... }). */
export type Attrs = Record<string, unknown>;

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
  | { op: "attrs"; fn: string; param?: number; attrs: Attrs }
  | { op: "flags"; v: Ref; flags: Record<string, boolean> };

/** One structural optimizer pass, as the `opt` subcommand takes it. */
export type OptOp =
  | { what: "simplify"; v: Ref }
  | { what: "instcombine"; max_iterations?: number; debug_counter?: number };

export type AssumeAnchor =
  | { at: "start"; fn: string }
  | { at: "before_calls"; fn: string }
  | { at: "before_inst"; inst: Ref };

/**
 * What an assumption names: `!N` for argument N of the call it goes before,
 * or of the function at its start, and `%x` for a value of the function.
 */
export type Name = string;

/** A comparison of two names, or a name and an integer, as one `icmp`. */
export type Comparison = {
  op: "eq" | "ne" | "slt" | "sle" | "sgt" | "sge" | "ult" | "ule" | "ugt" | "uge";
  lhs: Name | number;
  rhs: Name | number;
};

/** Lines of IR whose last line defines the i1 assumed, or one comparison. */
export type Predicate = { insts: string[] } | Comparison;

/** A fact about one value, in the vocabulary of `edit attrs`. */
export type FactAssertion = { fact: Attrs; of: Name };

export type Assertion = FactAssertion | Predicate;

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

  /** The module with each instruction marked `; #N`, for a reader. */
  number(module: Module): Promise<LlopsResult<ModuleResult>> {
    return this.run("number", { module });
  }

  edit(module: Module, op: EditOp): Promise<LlopsResult<ModuleResult>> {
    return this.run("edit", { module, ...op });
  }

  /** Cut the src side at `cut`, using `params` as the signature if given. */
  outlineSrc(
    module: Module,
    cut: Ref,
    callee: string,
    params?: OutlineParam[],
  ): Promise<LlopsResult<OutlineResult>> {
    return this.run("outline", { module, side: "src", cut, callee, ...(params ? { params } : {}) });
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

  /** Detach `block` and every block it reaches on the src side. */
  detachSrc(
    module: Module,
    block: Ref,
    callee: string,
    params?: OutlineParam[],
  ): Promise<LlopsResult<DetachResult>> {
    return this.run("detach", {
      module,
      side: "src",
      block,
      callee,
      ...(params ? { params } : {}),
    });
  }

  /** Detach the tgt side against the signature the src side produced. */
  detachTgt(
    module: Module,
    block: Ref,
    callee: string,
    params: OutlineParam[],
    valueMap: Record<Ref, Ref>,
  ): Promise<LlopsResult<DetachResult>> {
    return this.run("detach", { module, side: "tgt", block, callee, params, value_map: valueMap });
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

  /** Put a detached block back, the calls `detach` made becoming branches again. */
  reattach(
    outer: Module,
    callee: Module,
    calleeName: string,
    phis: number[],
    hypothesis?: string,
  ): Promise<LlopsResult<ModuleResult>> {
    const request = { outer, callee, callee_name: calleeName, phis };
    return this.run("reattach", hypothesis ? { ...request, hypothesis } : request);
  }

  /**
   * Put a detached loop's body at each call of its hypothesis. Given the
   * callee, put it at each call of the loop instead.
   */
  unfold(module: Module, hypothesis: string, callee?: Module): Promise<LlopsResult<ModuleResult>> {
    return this.run("unfold", callee ? { module, hypothesis, callee } : { module, hypothesis });
  }

  analyze(module: Module, kind: AnalyzeKind, point?: Ref): Promise<LlopsResult<AnalyzeResult>> {
    return this.run("analyze", point ? { module, kind, point } : { module, kind });
  }

  /** Apply one structural optimizer op to an instruction or the whole function. */
  opt(module: Module, op: OptOp): Promise<LlopsResult<ModuleResult>> {
    return this.run("opt", { module, ...op });
  }

  /**
   * State facts or predicates at a program anchor (before an instruction,
   * before a call, or at function entry).
   */
  assume(
    module: Module,
    anchor: AssumeAnchor,
    assertions: Assertion | Assertion[],
  ): Promise<LlopsResult<ModuleResult>> {
    const list = Array.isArray(assertions) ? assertions : [assertions];
    return this.run("assume", { module, anchor, assertions: list });
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

/** The one function's instructions, block by block, labels dropped, so an index is llops' `#N`. */
export function moduleBlocks(module: Module): string[][] | undefined {
  const lines = module.split("\n");
  const entry = lines.indexOf("entry:");
  if (entry < 0) return undefined;
  const end = lines.indexOf("}", entry);
  if (end < 0) return undefined;
  const blocks: string[][] = [[]];
  let open = false;
  for (const line of lines.slice(entry + 1, end).map((l) => l.trim())) {
    const block = blocks[blocks.length - 1] as string[];
    // A switch prints its cases on lines of their own, up to a closing `]`.
    if (open) block[block.length - 1] += ` ${line}`;
    else if (/^("[^"]*"|[\w.$-]+):(\s|$)/.test(line)) blocks.push([]);
    else if (line) block.push(line);
    open = (open || line.endsWith("[")) && line !== "]";
  }
  return blocks;
}

/** The instructions of a module's one function, in the order they are printed. */
export function moduleLines(module: Module): string[] | undefined {
  return moduleBlocks(module)?.flat();
}
