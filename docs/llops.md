# llops: the native LLVM toolbox

llops is the half of alive-next that touches LLVM. It is stateless: IR text in, IR text or JSON facts out, one request per process, nothing kept between calls. The language split in [implementation.md](./implementation.md) is why it is a separate binary.

The subcommands the certificate checker runs are verdict-critical. The others are tier 2 in the sense of [design.md](./design.md): a bug in one wastes search time and cannot corrupt a verdict. All of them share one library, so the line is documented here rather than enforced by separate binaries.

## Invocation

```sh
llops <subcommand> < request.json > response.json
```

The request is one JSON object on stdin, the response one JSON object on stdout. `llops version` and `llops help` take no request and answer in plain text.

A successful response carries `"ok": true` and the subcommand's payload. A failed one carries `"ok": false` and an error, whose code is the stable part and whose message is free text for whoever reads the result:

```json
{ "ok": false, "error": { "code": "not_found", "message": "..." } }
```

The exit status repeats that answer, 0 when ok and 1 when not, so a caller can branch on it without parsing the body. A command line llops cannot make sense of exits 2 and writes usage to stderr.

## The program shape

A program is a module with exactly one defined function, whose body has no loop and ends every block in `ret`, `br`, `switch` or `unreachable`. Declarations and global variables are free, calls must name a declared function, and inline assembly and indirect calls are refused.

`validate` reports a departure from that shape as a diagnostic. Every subcommand that rewrites a program reports the first departure other than `cyclic` as an error instead, and changes nothing.

The LLVM verifier decides what the shape rules do not cover, so a module that comes out of llops parses, has the program shape, and verifies. A refusal is the normal case while an agent searches, not an error path: the diagnostic is the feedback.

## Value references

A value is named by the token that names it in printed IR, so a request can quote back what the caller read. Three forms are accepted wherever a request takes a reference:

* `%3` or `3`, an unnamed value by its slot number.
* `%x` or `x`, a named value; a name LLVM prints quoted is written `%"a b"`.
* `#7`, the instruction at index 7 of the body, counting from 0 at the first instruction of the entry block, through the blocks in the order they are printed, terminators included.

The index form is the only one that reaches an instruction defining no value, such as a store, a void call, or the terminator.

Only `canon` renumbers. Every other subcommand answers with the names it was given, which is what lets one edit address the values the previous edit created.

Slot numbers move whenever a program is edited, so a caller reads the module back out of each response rather than holding references across calls.

## validate

Request `{ "module": "<ir text>" }`, response `{ "ok": true, "conforms": bool, "diagnostics": [ ... ], "functions": { ... } }`, where each diagnostic is `{ "severity": "error", "code": "...", "message": "..." }`.

A response is ok when the module parses. `conforms` says whether it is a program in the sense above. `functions` maps each declared and defined function to its parsed structure: `defined`, `return_type`, `params` (with types and parameter attributes like `noundef`, `range`, `align`), `fn_attrs` (such as `memory`, `nounwind`, `willreturn`), and normalized `signature`.

| code | what it means |
| --- | --- |
| `no_define` | the module defines no function |
| `too_many_defines` | the module defines more than one |
| `cyclic` | the body has a loop |
| `no_terminator` | a block does not end in a terminator |
| `unsupported_terminator` | a block ends in something other than `ret`, `br`, `switch` or `unreachable` |
| `inline_asm` | the body contains inline assembly |
| `indirect_call` | the body calls through a pointer |
| `recursive_call` | the body calls the defined function |
| `dominance` | a value is used before its definition |
| `invalid_ir` | the LLVM verifier rejected the module |

## canon

Request `{ "module": "<ir text>" }`, response `{ "ok": true, "module": ... }`.

Every local name is dropped, so LLVM numbers values in definition order with the arguments first, and blocks, laid out in reverse postorder from the entry, are named by position starting at `entry`. Two programs that differ only in names canonicalize to identical bytes, which is what makes a content hash a program's identity, and canon over its own output changes nothing.

A module holding an `undef` value is refused with the error code `undef`. Canon is the gate text passes through to become a stored program, and every program is reasoned about under the [no-`undef` model](./design.md), so the refusal keeps what is stored inside what any later question can be about. The value, not the word, is what is refused: poison is a value of its own and passes, a local called `%undef` is an ordinary name, and metadata passes, since none of them put an `undef` into a runtime state.

## edit

Request `{ "module": ..., "op": "<op>", ... }`, response `{ "ok": true, "module": ... }`. One op per call.

| op | arguments | effect |
| --- | --- | --- |
| `swap` | `a`, `b` | exchange the positions of two instructions |
| `move` | `v`, `where`, `w` | move `v` before or after `w` |
| `substitute` | `a`, `b` | every use of `a` becomes `b` |
| `replace` | `v`, `insts` | redefine `v` with an instruction sequence |
| `insert` | `where`, `w`, `insts` | insert instructions around `w` |
| `erase` | `v`, `cascade` | delete an instruction |
| `commute` | `v` | swap the operands of an operation |
| `retype` | `v`, `ty`, `ext` | give a value another integer type |
| `dedup` | `a`, `b` | erase `b`, its uses become `a` |
| `set_body` | `body` | replace the whole body |
| `attrs` | `fn`, optional `param`, `attrs` | put attributes on a function or parameter |
| `flags` | `v`, `flags` | put or remove the flags an instruction can carry |

`where` is `"before"` or `"after"`. The terminator cannot be moved, erased or replaced, and nothing can be inserted after it.

`replace` and `insert` take `insts`, an array of instruction lines. The snippet is parsed against the values in scope, so it may use them by reference and define names of its own, which survive the edit.

A snippet may not shadow a name that already exists. `replace` may reuse the name of the value it replaces, and may not use the value itself.

A snippet that calls a function the module does not declare gets a declaration, which is how `llvm.assume` reaches a body. A type the module declares cannot be named from a snippet, because the throwaway function it is parsed in cannot declare it, whereas `set_body` reparses the whole module and can.

`erase` refuses a value that still has users, leaving the caller to erase or rewrite them first. With `"cascade": true` the operands that become dead go with it, stopping at anything with a side effect; a plain load has none, so a dead one goes.

`commute` swaps the operands of a commutative operation. On a comparison it swaps the predicate as well, so any predicate can be commuted.

`retype` keeps the definition computing in the old type, converts it under the old name, and converts back at every use, with `ext` choosing `zext` or `sext` where the conversion widens. Whether the conversions lose nothing is a claim for the caller's alive2 check.

`attrs` puts attributes on a parameter when `param` is given, or on the function itself when omitted. On a parameter it accepts `noundef`, `nonnull`, `noalias`, `align`, `dereferenceable` and `range`. The last two carry a byte count and a `{ "min": n, "max": m }` pair, the range being the half-open interval `[min, max)`. On a function it accepts `nounwind`, `nofree`, `nosync`, `willreturn`, `norecurse`, `mustprogress` (each boolean `true`), and `memory` (a string such as `"none"`, `"read"`, `"write"`, or `"argmem: readwrite"`).

`flags` names instruction flags with `true` or `false`, so the same op puts and removes: `{ "nuw": true }` puts `nuw` on and `{ "nsw": false }` takes `nsw` off. `nuw` and `nsw` apply to `add`, `sub`, `mul`, `shl` and `trunc`, `exact` to the divisions and shifts that carry it, `disjoint` to `or`, `nneg` to `zext` and `uitofp`, and `fast`, `nnan`, `ninf`, `nsz`, `arcp`, `contract`, `afn` and `reassoc` to floating-point instructions. A flag the instruction cannot carry is refused rather than ignored, so the agent never guesses what the IR keeps.

## opt

Request `{ "module": ..., "what": "<op>", ... }`, response `{ "ok": true, "module": ... }`. One op per call, each one LLVM's own machinery, so a simplification is the same algebra alive2 reasons about rather than a second set of rules that could drift. An opt is still a proposal: the agent certifies the result with alive2 like any other edit.

| op | arguments | effect |
| --- | --- | --- |
| `simplify` | `v` | fold one instruction with `simplifyInstruction` |
| `instcombine` | optional `max_iterations`, `debug_counter` | run LLVM's InstCombine pass over the function |

`simplify` rewrites the instruction's uses to the simplified value and erases the instruction; nothing else in the body moves, so the step stays as small as it was asked to be, and an instruction with nothing to fold comes back unchanged. The terminator cannot be simplified.

`instcombine` combines instructions across the function. `max_iterations` is a positive integer and defaults to LLVM's default of one. `debug_counter` is a non-negative integer selecting the only zero-based `instcombine-visit` to execute; without it every visit executes. Invalid values are refused.

## outline

Moves part of a body into a fresh function and leaves a call where it was. Without a `to` the part is everything the cut reaches, which no block outside it may enter (`not_single_entry`), and is how a goal is cut in two; with one it is the window between them, which is how a local edit is asked about locally.

The instructions before the cut stay in the outer function, which gains a call, and the instructions from the cut onwards become the body of a fresh function. The cut instruction itself is the first instruction of the callee.

The src side is cut on its own:

```json
{ "module": "...", "side": "src", "cut": "%4", "callee": "g" }
```

The response carries the two modules and the signature:

```json
{ "ok": true, "outer": "...", "callee": "...",
  "params": [ { "param": "%p0", "type": "i32", "live": "%3" } ] }
```

The signature is the src side's live-in set, the values the moved instructions use from before them: instructions in the order they are printed, then arguments.

The tgt side is cut against that same signature, with a value map naming the tgt value that stands in for each src live value:

```json
{ "module": "...", "side": "tgt", "cut": "%sum", "callee": "g",
  "params": [ { "param": "%p0", "type": "i32", "live": "%3" } ],
  "value_map": { "%3": "%prod" } }
```

Both sides answer with the same `params`, so a caller can compare them. Whether the map is right is for the outer alive2 check to settle; what outline checks is structural, that every live value is covered and every mapped value is in scope at the cut and has the type the signature gives.

The callee is declared with no attributes. An attribute is an assumption the call site has to honour, so adding one is a proof obligation that belongs to the strengthen flow rather than to the cut.

### A window rather than a suffix

`to` names the far end, in the same block, and the outlined instructions are the ones from `cut` to there. The terminator stays where it is, and the callee hands back what the rest of the body still uses:

```json
{ "module": "...", "cut": "%v1", "to": "%v2", "callee": "r" }
```

```json
{ "ok": true, "outer": "...", "callee": "...",
  "params": [ { "param": "%p0", "type": "i32", "live": "%p1" } ],
  "result": { "type": "i32", "live": [ "%v2" ] } }
```

`result` is absent when nothing outside the window uses what it defines, and the callee then answers with `void`; several values come back as a struct, in the order the window defines them, which the outer takes apart right after the call. A window that takes a phi or the terminator is refused: leaving `to` out is how the rest is cut away.

What a window is for is asking about a local edit locally. Two versions of a body that differ only inside one window come out as the same outer and two small functions, so the small pair is the whole question, and the outers being byte-identical is what says the difference is confined to the window. Neither the instruction count nor the names have to line up for that. This is one program's own business rather than an agreement between two, so a window takes no `side`, `params` or `value_map`, and is refused if it is given one.

A window may hold memory. Its pair is then asked about an arbitrary entry state, which is conservative rather than unsound: the cost is that fewer such pairs prove.

## inline

Request `{ "outer": ..., "callee": ..., "callee_name": "g" }`, response `{ "ok": true, "module": ... }`.

The call is replaced by the callee's body in place, the parts of a struct it answered with going back to their uses, and the declaration that carried it is dropped once nothing uses it. A call that carries anything of its own, such as an attribute, metadata or a tail marker, is refused with `invalid`, and so are halves that declare a shared symbol differently: either way the module built would not be what the halves were checked as. So `outline`, then `inline`, then `canon` reproduces the module the outline started from, byte for byte, whatever the window was. That roundtrip is how the certificate checker tests a split for faithfulness, and it is why `outline` is tier 2: what a checker reruns is the inlining, not the cutting.

## detach

Moves a block and every block it reaches into a fresh function, and turns every branch to the block into a call of it. A goal is cut this way at a join or at a loop header.

Request `{ "module": ..., "side": "src", "block": "%bb2", "callee": "k" }`; the tgt side adds `params` and `value_map` as `outline` takes them. Response `{ "ok": true, "outer": ..., "callee": ..., "params": [ ... ], "phis": [ 0, 1 ], "hypothesis": "k.ih" }`.

The signature is the block's phis, then the values the moved blocks use from outside, in definition order; a tgt side takes the src's, and `phis` gives the positions of the block's phis in it. Every edge into the block becomes an edge into a fresh block that only calls the callee and returns what it answers. An edge from a moved block, which exists when the block heads a loop, calls the declared `hypothesis` instead, passing each parameter that is not a phi on as itself, so the callee's body does not loop through it; `hypothesis` is absent when there is no such edge. The module may loop, and so may either half when the moved blocks hold a loop of their own. A block entered from outside other than through the named one is refused with `not_single_entry`, and so is the entry block.

## reattach

Request `{ "outer": ..., "callee": ..., "callee_name": "k", "phis": [ 0, 1 ], "hypothesis": "k.ih" }`, response `{ "ok": true, "module": ... }`.

The inverse of `detach` on `inline`'s terms, which the certificate checker runs. Every block that only calls the callee or its hypothesis and returns what it answers is removed, its predecessors branch to the callee's entry instead, and the callee's parameters become phis there. Those `phis` names stay phis, and each other one has to be passed as one value or as itself, and becomes that value. `canon` of the result is `canon` of the module `detach` started from.

## analyze

Request `{ "module": ..., "kind": ..., "point": ... }`, response `{ "ok": true, "kind": ..., "point": ..., "facts": [ ... ] }`.

Facts are reported for every argument and every value that dominates the point that the analysis applies to, and they hold just before the point runs. The point defaults to the end of a body of one block.

The point is also the context for assumptions, so an `llvm.assume` that dominates it counts, and one at the point itself does not, because it has not run yet.

Every fact carries `value` and `type`. The kind decides the rest:

* `knownbits` adds `zero_bits`, `one_bits` and `unknown_bits`, hexadecimal masks over the value's width.
* `ranges` adds `signed_min`, `signed_max`, `unsigned_min` and `unsigned_max`, decimal, each interpretation computed separately.
* `pointer` adds `align`, `dereferenceable` and `nonnull`.
* `defined` adds `noundef`, `not_undef` and `not_poison`, and applies to every type. `noundef` is the conjunction of the other two, in the sense the attribute has.

Analyses only propose; [design.md](./design.md) is where that stands in the trust base.

## harness

Wraps a function in a `main` that llubi can run, which is what replaying a counterexample needs: llubi runs `@main` and nothing else, its signature has to be `i32 @main(i32, ptr)`, and no command line sets an argument.

Request `{ "module": ..., "entry": "f", "args": [ ... ] }`, one argument per parameter of the entry function, in order:

* `{ "kind": "int", "value": "42" }` for an integer parameter of any width, the value as text so that a width beyond 64 bits survives JSON. A leading `-` is read as a sign, and a value the parameter's width cannot hold is refused rather than truncated.
* `{ "kind": "bytes", "bytes": [1, 2], "align": 4 }` for a pointer, which is allocated and filled with those bytes before the call.
* `{ "kind": "null" }` for a null pointer.

Response `{ "ok": true, "module": ..., "observations": [ ... ] }`.

Everything worth judging the run on is loaded back under a name beginning `obs.`, because llubi's verbose trace prints each instruction with its result and that is the only channel wide enough: the exit code is the return value truncated to eight bits. The return value goes through memory for the same reason the final bytes do, so every observation is one trace line of the shape `%obs.something = load ... -> value`. `observations` lists those names in the order the harness produces them: the result first when the entry returns one, then the bytes of each pointer argument.

The harness does not have the program shape, since it defines a second function, so `validate` will refuse what this produces. It is an artifact for the interpreter rather than a program under proof.

## assume

States facts about values or relational comparisons between values at a program anchor. This is the first half of interface strengthening: an attribute or precondition on an outlined callee is an assumption its caller has to honour, so it may only be assumed once the caller has been shown to satisfy it, and an assume is how that is shown. If the assertion were false the assume would add UB the program did not have, and the alive2 check of the insertion refuses it.

Request `{ "module": ..., "anchor": { ... }, "assertions": [ ... ] }`, response `{ "ok": true, "module": ... }`.

`anchor` specifies the insertion point:
* `{ "at": "entry", "fn": "<name>" }`: at the start of the defined function's entry block.
* `{ "at": "before_call", "fn": "<name>" }`: immediately before the unique call to `<name>`.
* `{ "at": "before_inst", "inst": "<ref>" }`: immediately before the instruction `<ref>`.

`assertions` is a list of assertions to assume at the anchor:
* Unary fact on an argument or local value: `{ "fact": { ... }, "arg": <n> }` or `{ "fact": { ... }, "val": "<ref>" }`. Facts use the vocabulary of `edit attrs` (`range`, `noundef`, `nonnull`, `align`, `dereferenceable`). `noalias` is refused.
* Relational comparison: `{ "op": "<icmp_pred>", "lhs": <operand>, "rhs": <operand> }`, where `op` is an integer comparison (`eq`, `ne`, `slt`, `sle`, `sgt`, `sge`, `ult`, `ule`, `ugt`, `uge`), and operands are `{ "arg": n }`, `{ "val": "<ref>" }`, or `{ "const": n }`. Mismatched operand types are refused with `type_mismatch`.

A request that asks for conditions and operand bundles produces two assumes, because an assume carrying operand bundles has to have `true` as its condition.

## Error codes

`validate` reports the codes above as diagnostics. Everywhere else they arrive as errors, alongside these:

| code | what it means |
| --- | --- |
| `bad_json` | the request is not JSON |
| `bad_request` | a field is missing, or has the wrong type |
| `parse_error` | the module does not parse |
| `shape_error` | the module does not define exactly one function |
| `undef` | the module holds an `undef` value |
| `not_found` | a reference names nothing |
| `invalid` | the operation does not apply here |
| `type_mismatch` | two types had to agree and did not |
| `used` | an instruction still has users |
| `name_taken` | a snippet defines a name that exists |
| `undefined_value` | a snippet uses a value that is not in scope |
| `named_type` | a snippet names a type it cannot declare |
| `snippet_parse_error` | the snippet or the new body does not parse |
| `empty_snippet` | the snippet defines no instructions |
| `snippet_terminator` | a snippet carries a terminator; the block's own stays |
| `set_body_contract` | a set_body body is module text, not the body's instructions |
| `not_single_entry` | a block a cut would move is entered other than where the cut is made |

## Building and testing

`make llops` builds the binary and installs it into the prefix, against the LLVM that [implementation.md](./implementation.md) pins.

`make test-llops` runs [llops_test.py](../llops/test/llops_test.py), which drives the binary over the protocol above.
