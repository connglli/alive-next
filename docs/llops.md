# llops: the native LLVM toolbox

llops is the half of alive-next that touches LLVM. It is stateless: IR text in, IR text or JSON facts out, one request per process, nothing kept between calls. The language split in [implementation.md](./implementation.md) is why it is a separate binary.

`inline` and `canon` are verdict-critical, because the certificate checker runs them. The other subcommands are tier 2 in the sense of [design.md](./design.md): a bug in one wastes search time and cannot corrupt a verdict. All of them share one library, so the line is documented here rather than enforced by separate binaries.

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

A program is a module with exactly one defined function, whose body is a single block ending in `ret`. Declarations and global variables are free, calls must name a declared function, and inline assembly and indirect calls are refused.

`validate` reports a departure from that shape as a diagnostic. Every subcommand that rewrites a program reports the first departure as an error instead, and changes nothing.

The LLVM verifier decides what the shape rules do not cover, so a module that comes out of llops parses, is straightline, and verifies. A refusal is the normal case while an agent searches, not an error path: the diagnostic is the feedback.

## Value references

A value is named by the token that names it in printed IR, so a request can quote back what the caller read. Three forms are accepted wherever a request takes a reference:

* `%3` or `3`, an unnamed value by its slot number.
* `%x` or `x`, a named value; a name LLVM prints quoted is written `%"a b"`.
* `#7`, the instruction at index 7 of the body, counting from 0 at the first instruction after the block label and including the terminator.

The index form is the only one that reaches an instruction defining no value, such as a store, a void call, or the terminator.

Only `canon` renumbers. Every other subcommand answers with the names it was given, which is what lets one edit address the values the previous edit created.

Slot numbers move whenever a program is edited, so a caller reads the module back out of each response rather than holding references across calls.

## validate

Request `{ "module": "<ir text>" }`, response `{ "ok": true, "conforms": bool, "diagnostics": [ ... ] }`, where each diagnostic is `{ "severity": "error", "code": "...", "message": "..." }`.

A response is ok when the module parses. `conforms` says whether it is a program in the sense above.

| code | what it means |
| --- | --- |
| `no_define` | the module defines no function |
| `too_many_defines` | the module defines more than one |
| `not_straightline` | the body has more than one block |
| `no_terminator` | the body does not end in a terminator |
| `unsupported_terminator` | the body ends in something other than `ret` |
| `inline_asm` | the body contains inline assembly |
| `indirect_call` | the body calls through a pointer |
| `recursive_call` | the body calls the defined function |
| `dominance` | a value is used before its definition |
| `invalid_ir` | the LLVM verifier rejected the module |

## canon

Request `{ "module": "<ir text>" }`, response `{ "ok": true, "module": ... }`.

Every local name is dropped, so LLVM numbers values in definition order with the arguments first, and blocks are named by position starting at `entry`. Two programs that differ only in names canonicalize to identical bytes, which is what makes a content hash a program's identity, and canon over its own output changes nothing.

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
| `attrs` | `fn`, `param`, `attrs` | put attributes on a parameter |

`where` is `"before"` or `"after"`. The terminator cannot be moved, erased or replaced, and nothing can be inserted after it.

`replace` and `insert` take `insts`, an array of instruction lines. The snippet is parsed against the values in scope, so it may use them by reference and define names of its own, which survive the edit.

A snippet may not shadow a name that already exists. `replace` may reuse the name of the value it replaces, and may not use the value itself.

A snippet that calls a function the module does not declare gets a declaration, which is how `llvm.assume` reaches a body. A type the module declares cannot be named from a snippet, because the throwaway function it is parsed in cannot declare it, whereas `set_body` reparses the whole module and can.

`erase` refuses a value that still has users, leaving the caller to erase or rewrite them first. With `"cascade": true` the operands that become dead go with it, stopping at anything with a side effect; a plain load has none, so a dead one goes.

`commute` swaps the operands of a commutative operation. On a comparison it swaps the predicate as well, so any predicate can be commuted.

`retype` keeps the definition computing in the old type, converts it under the old name, and converts back at every use, with `ext` choosing `zext` or `sext` where the conversion widens. Whether the conversions lose nothing is a claim for the caller's alive2 check.

`attrs` takes `noundef`, `nonnull`, `noalias`, `align`, `dereferenceable` and `range`. The last two carry a byte count and a `{ "min": n, "max": m }` pair, the range being the half-open interval `[min, max)`.

## outline

Moves part of a body into a fresh function and leaves a call where it was. Without a `to` the part is the suffix from the cut, which is how a goal is cut in two; with one it is the window between them, which is how a local edit is asked about locally.

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

The signature is the src side's live-in set, the values the suffix uses from the prefix or from the arguments, in the order they are defined.

The tgt side is cut against that same signature, with a value map naming the tgt value that stands in for each src live value:

```json
{ "module": "...", "side": "tgt", "cut": "%sum", "callee": "g",
  "params": [ { "param": "%p0", "type": "i32", "live": "%3" } ],
  "value_map": { "%3": "%prod" } }
```

Both sides answer with the same `params`, so a caller can compare them. Whether the map is right is for the outer alive2 check to settle; what outline checks is structural, that every live value is covered and every mapped value is in scope at the cut and has the type the signature gives.

The callee is declared with no attributes. An attribute is an assumption the call site has to honour, so adding one is a proof obligation that belongs to the strengthen flow rather than to the cut.

### A window rather than a suffix

`to` names the far end, and the outlined instructions are the ones from `cut` to there. The terminator stays where it is, and the callee hands back the one value the rest of the body still uses:

```json
{ "module": "...", "cut": "%v1", "to": "%v2", "callee": "r" }
```

```json
{ "ok": true, "outer": "...", "callee": "...",
  "params": [ { "param": "%p0", "type": "i32", "live": "%p1" } ],
  "result": { "type": "i32", "live": "%v2" } }
```

`result` is absent when nothing outside the window uses what it defines, and the callee then answers with `void`. A window that hands out two values is refused, since a call answers with one. So is one that takes the terminator with it: leaving `to` out is how a suffix is cut away.

What a window is for is asking about a local edit locally. Two versions of a body that differ only inside one window come out as the same outer and two small functions, so the small pair is the whole question, and the outers being byte-identical is what says the difference is confined to the window. Neither the instruction count nor the names have to line up for that. This is one program's own business rather than an agreement between two, so a window takes no `side`, `params` or `value_map`, and is refused if it is given one.

A window may hold memory. Its pair is then asked about an arbitrary entry state, which is conservative rather than unsound: the cost is that fewer such pairs prove.

## inline

Request `{ "outer": ..., "callee": ..., "callee_name": "g" }`, response `{ "ok": true, "module": ... }`.

The call is replaced by the callee's body in place, and the declaration that carried it is dropped once nothing uses it. So `outline`, then `inline`, then `canon` reproduces the module the outline started from, byte for byte, whatever the window was. That roundtrip is how the certificate checker tests a split for faithfulness, and it is why `outline` is tier 2: what a checker reruns is the inlining, not the cutting.

## analyze

Request `{ "module": ..., "kind": ..., "point": ... }`, response `{ "ok": true, "kind": ..., "point": ..., "facts": [ ... ] }`.

Facts are reported for every argument and every value defined before the point that the analysis applies to, and they hold just before the point runs. The point defaults to the end of the body.

The point is also the context for assumptions, so an `llvm.assume` earlier in the body counts, and one at the point itself does not, because it has not run yet.

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

The harness is not a v1 program, since it defines a second function, so `validate` will refuse what this produces. It is an artifact for the interpreter rather than a program under proof.

## assume

States a fact about a value, just before an instruction. This is the first half of interface strengthening: an attribute on an outlined callee's parameter is an assumption its caller has to honour, so it may only be added once the caller has been shown to honour it, and an assume is how that is shown. If the fact were false the assume would add UB the program did not have, and the alive2 check of the insertion refuses it.

Request `{ "module": ..., "before": ref, "value": ref, "fact": { ... } }`, response `{ "ok": true, "module": ... }`.

Where the assume goes can be said the other way instead, with `{ "before_call": "g", "arg": 0 }` in place of `before` and `value`: before the call to that function, about the argument at that position. That is what strengthening needs, since a fact about a call's argument outlives the reference that named it, which every edit before the call renumbers. The two forms are exclusive.

The fact vocabulary is the one `edit attrs` takes, so what is proved here and what is attributed cannot drift apart. How each one is written depends on what it says:

* `range` becomes two signed comparisons over the value, joined by an `and` when the interval runs upwards and by an `or` when it wraps, which is the same half-open interval the attribute means.
* `noundef` becomes a `"noundef"` operand bundle, which is UB exactly when the value is undef or poison, and which `analyze defined` reads back.
* `nonnull`, `align` and `dereferenceable` become operand bundles on an assume of `true`, since that is the only form they have.
* `noalias` is refused. It describes a function's whole argument list rather than a value at a point, so there is nothing here that would prove it.

A request that asks for a condition and a bundle at once produces two assumes, because an assume carrying operand bundles has to have `true` as its condition.

## Error codes

`validate` reports the codes above as diagnostics. Everywhere else they arrive as errors, alongside these:

| code | what it means |
| --- | --- |
| `bad_json` | the request is not JSON |
| `bad_request` | a field is missing, or has the wrong type |
| `parse_error` | the module does not parse |
| `shape_error` | the module is not one defined straightline function |
| `not_found` | a reference names nothing |
| `invalid` | the operation does not apply here |
| `type_mismatch` | two types had to agree and did not |
| `used` | an instruction still has users |
| `name_taken` | a snippet defines a name that exists |
| `undefined_value` | a snippet uses a value that is not in scope |
| `named_type` | a snippet names a type it cannot declare |
| `snippet_parse_error` | the snippet or the new body does not parse |
| `empty_snippet` | the snippet defines no instructions |

## Building and testing

`make llops` builds the binary and installs it into the prefix, against the LLVM that [implementation.md](./implementation.md) pins.

`make test-llops` runs [llops_test.py](../llops/test/llops_test.py), which drives the binary over the protocol above.
