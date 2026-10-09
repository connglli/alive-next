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

/** What `reshaped` answers: whether one function only reshapes another's control flow. */
export interface ReshapedResult {
  reshaped: boolean;
  why?: string;
}

/** What `respected` answers: whether one function only adds attributes it keeps. */
export interface RespectedResult {
  respected: boolean;
  why?: string;
}

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
  /** The attributes that change what the function's instructions may do. */
  body_attrs: string[];
  diagnostics: Diagnostic[];
  functions?: Record<string, FunctionMeta>;
}

/** One instruction as llops lists a body: the one at index N is in position N. */
export interface Instruction {
  /** Its block, as a reference such as `%bb1`. */
  block: string;
  /** Its text on one line. */
  text: string;
  opcode: string;
  /** Its result type, `void` when it defines no value. */
  type: string;
  /** Its flags in printed order, such as `nsw` or `nnan`. */
  flags: string[];
  /** Its operands in LLVM's order, as references or constants. */
  operands: string[];
  commutative: boolean;
  /**
   * Its text without the result, with `poison` for each operand the function
   * defines and `%_` for each block.
   */
  form: string;
  /** The value it defines, as `%3` or `%x`, if it defines one. */
  value?: string;
  phi: boolean;
  /** For a phi, the blocks its values come from, in order. */
  blocks?: string[];
  /** For a call, the function it calls by name. */
  calls?: string;
  /** For a call, its arguments as references or constants, such as `%3` or `poison`. */
  args?: string[];
}

/** The module after a pass of a pipeline that changed it. */
export interface Stage {
  /** The pass by its name in a pipeline, such as `instcombine`. */
  pass: string;
  module: Module;
}

export interface NumberResult extends ModuleResult {
  body: Instruction[];
}

export interface ModuleResult {
  module: Module;
}

/** One entry of the shared signature an outline produces. */
export interface OutlineParam {
  param: Ref;
  type: string;
  live: Ref;
  /** The tgt value this parameter passes, when only the tgt has it and `live` is poison. */
  tgt?: Ref;
}

/** An entry of the `params` outline and detach take: the value passed and its type. */
export type ParamSpec = Pick<OutlineParam, "live" | "type">;

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

export type AnalyzeKind = "knownbits" | "ranges" | "pointer" | "defined" | "scev";

/** An expression ScalarEvolution gives a value, with a constant or a value at a leaf. */
export interface Scev {
  op: string;
  type: string;
  value?: string;
  operands?: Scev[];
  /** The header of the loop a recurrence (`addrec`) is in. */
  loop?: string;
  flags?: string[];
}

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
  scev?: Scev;
}

/** One argument of a counterexample's input, matched to a parameter by position. */
export type InputArg =
  | { kind: "int"; value: string }
  | { kind: "bytes"; bytes: number[]; align?: number }
  | { kind: "null" };

export interface HarnessResult {
  module: Module;
  /** The names to look for in llubi's trace, in the order they are produced. */
  observations: Ref[];
  /** What in the entry llubi treats differently from alive2. */
  differences: string[];
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
  | { op: "drop_attrs" }
  | { op: "flags"; v: Ref; flags: Record<string, boolean> }
  | {
      op: "splice";
      from: Ref;
      to: Ref;
      with: { module: Module; from: Ref; to: Ref };
      value_map: Record<Ref, Ref>;
    };

/** One op of the `opt` subcommand; a pipeline also names the stage to take. */
export type OptOp =
  | { what: "simplify"; v: Ref }
  | { what: "instcombine"; max_iterations?: number; debug_counter?: number }
  | { what: "pipeline"; passes?: string; stage?: number };

/** The module an op makes, and for a pipeline, its stages and the one taken. */
export interface OptResult extends ModuleResult {
  stage?: number;
  stages?: string[];
}

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

/** A fact about one value, in the vocabulary of `attrs`. */
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

  /** The module with each instruction marked `; #N`, for a reader, and its instructions by index. */
  number(module: Module): Promise<LlopsResult<NumberResult>> {
    return this.run("number", { module });
  }

  edit(module: Module, op: EditOp): Promise<LlopsResult<ModuleResult>> {
    return this.run("edit", { module, ...op });
  }

  /** Put attributes on the function `fn`, or on its parameter `param` when given. */
  attrs(
    module: Module,
    fn: string,
    attrs: Attrs,
    param?: number,
  ): Promise<LlopsResult<ModuleResult>> {
    return this.run(
      "attrs",
      param === undefined ? { module, fn, attrs } : { module, fn, param, attrs },
    );
  }

  /** Cut the src side at `cut`, using `params` as the signature if given. */
  outlineSrc(
    module: Module,
    cut: Ref,
    callee: string,
    params?: ParamSpec[],
  ): Promise<LlopsResult<OutlineResult>> {
    return this.run("outline", { module, side: "src", cut, callee, ...(params ? { params } : {}) });
  }

  /** Cut the tgt side against the signature the src side produced. */
  outlineTgt(
    module: Module,
    cut: Ref,
    callee: string,
    params: ParamSpec[],
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
    params?: ParamSpec[],
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
    params: ParamSpec[],
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

  /**
   * Whether the function `after` defines is the one `before` defines with its
   * control flow reshaped and nothing else, so that `after` refines `before`.
   */
  reshaped(before: Module, after: Module): Promise<LlopsResult<ReshapedResult>> {
    return this.run("reshaped", { before, after });
  }

  /**
   * Whether the function `after` defines is the one `before` defines with
   * attributes added that its own instructions cannot break, so that `after`
   * refines `before`.
   */
  respected(before: Module, after: Module): Promise<LlopsResult<RespectedResult>> {
    return this.run("respected", { before, after });
  }

  analyze(module: Module, kind: AnalyzeKind, point?: Ref): Promise<LlopsResult<AnalyzeResult>> {
    return this.run("analyze", point ? { module, kind, point } : { module, kind });
  }

  /** Apply one optimizer op to an instruction or the whole function. */
  async opt(module: Module, op: OptOp): Promise<LlopsResult<OptResult>> {
    if (op.what !== "pipeline") return this.run("opt", { module, ...op });
    const result = await this.pipelineStages(module, op.passes);
    if (!result.ok) return result;
    const stages = result.stages.map((done) => done.pass);
    // A pipeline that changes nothing has no stage.
    if (stages.length === 0) return { ok: true, module, stages };
    const stage = op.stage ?? stages.length - 1;
    const taken = result.stages[stage];
    if (!taken) {
      const message = `the pipeline has stages 0 to ${stages.length - 1}, not ${stage}`;
      return { ok: false, code: "invalid", message };
    }
    return { ok: true, module: taken.module, stage, stages };
  }

  /** Run a pass pipeline, `default<O3>` unless `passes` names another, keeping each stage. */
  pipelineStages(module: Module, passes?: string): Promise<LlopsResult<{ stages: Stage[] }>> {
    const what = "pipeline";
    return this.run("opt", passes ? { module, what, passes } : { module, what });
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
  harness(module: Module, entry: string, args: InputArg[]): Promise<LlopsResult<HarnessResult>> {
    return this.run("harness", { module, entry, args });
  }

  /** Assume an input at the entry of both programs of a pair. */
  instantiate(
    src: Module,
    tgt: Module,
    args: InputArg[],
  ): Promise<LlopsResult<{ src: Module; tgt: Module }>> {
    return this.run("instantiate", { src, tgt, args });
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

/** The one function a program defines, or why a goal cannot hold it. */
export async function definedIn(
  llops: Llops,
  module: Module,
  what: string,
): Promise<{ name: string } | { why: string }> {
  const result = await llops.validate(module);
  if (!result.ok) return { why: `${what}: llops validate: ${result.message}` };
  if (!result.conforms) {
    const why = result.diagnostics.map((d) => `${d.code}, ${d.message}`).join("; ");
    return { why: `${what} is outside the program shape: ${why}` };
  }
  const functions = Object.entries(result.functions ?? {});
  const [name = ""] = functions.find(([, fn]) => fn.defined) ?? [];
  return { name };
}

/** Why a program's function may not be cut or narrowed, or nothing when it may. */
export async function unoutlinable(
  llops: Llops,
  module: Module,
  what: string,
): Promise<string | undefined> {
  const result = await llops.validate(module);
  if (!result.ok) return `${what}: llops validate: ${result.message}`;
  const held = [...new Set(result.body_attrs)];
  if (held.length === 0) return undefined;
  const kept = await undropped(llops, module, held);
  const remedy =
    kept.length === 0
      ? " until the drop_attrs edit removes them"
      : `, and no edit removes ${kept.join(", ")}`;
  return (
    `${what} has ${held.join(", ")}, which alive2 applies only to its own instructions, ` +
    `so none may move into another function${remedy}`
  );
}

/** Of the attributes `held`, those the drop_attrs edit leaves, which no edit removes. */
async function undropped(llops: Llops, module: Module, held: string[]): Promise<string[]> {
  const dropped = await llops.edit(module, { op: "drop_attrs" });
  const result = dropped.ok ? await llops.validate(dropped.module) : undefined;
  return result?.ok ? [...new Set(result.body_attrs)] : held;
}

/** A body's instructions, block by block, in index order. */
export function blocksOf(body: Instruction[]): Instruction[][] {
  const blocks: Instruction[][] = [];
  for (const instruction of body) {
    const last = blocks[blocks.length - 1];
    if (last?.[0]?.block === instruction.block) last.push(instruction);
    else blocks.push([instruction]);
  }
  return blocks;
}
