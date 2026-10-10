# Semantics

alive-next follows alive2's semantics of LLVM IR ([docs/design.md](./design.md)), and runs llubi only where alive2 does not decide a counterexample. This document lists where the LangRef, llubi and alive2 model a point of LLVM IR differently. Each reading follows the LangRef or the source at the revision pinned in [scripts/depman.sh](../scripts/depman.sh), so each point is rechecked when a pin moves.

## Values

### `undef`

**LangRef.** Each use may take a different value.

**llubi.** An `undef` constant is zero.

**alive2.** As in the LangRef, and `--disable-undef-input` keeps every input from being `undef`.

### `freeze` of poison

**LangRef.** An arbitrary value.

**llubi.** Zero.

**alive2.** Any value, and the src's freeze may take the one that matches the tgt's.

### A store of poison

**LangRef.** Memory holds poison.

**llubi.** UB, unless `--store-poison-is-ub=false`.

**alive2.** Memory holds poison.

## Termination and unwinding

### `mustprogress` and `llvm.loop.mustprogress`

**LangRef.** A loop that runs forever without side effects is UB.

**llubi.** Ignored.

**alive2.** Ignored.

### `willreturn`

**LangRef.** Not returning is UB.

**llubi.** Ignored.

**alive2.** A call to a callee without `willreturn` is UB, whether or not the callee returns, and a loop that never ends is not.

### `noreturn`

**LangRef.** Returning is UB.

**llubi.** Ignored.

**alive2.** Returning is UB.

### `nounwind`

**LangRef.** Unwinding out of the function is UB.

**llubi.** Ignored.

**alive2.** Ignored.

## Memory

### `memory(...)` and callees

**LangRef.** The attribute covers what callees do.

**llubi.** Each call, `memset` included, is checked against the callee's memory effects.

**alive2.** A call to an unknown function never breaks it, and a memory intrinsic such as `memset`, which is the function's own instruction, does.

### Addresses

**LangRef.** Unspecified, for a new allocation and for a global.

**llubi.** One concrete address each, with globals laid out from the module, so the two programs may place a global apart.

**alive2.** Any address for a new allocation, while a global has one address, the same in the src and the tgt.

### `noalias` parameter

**LangRef.** Memory accessed through the pointer is not accessed through other pointers during the call.

**llubi.** Ignored.

**alive2.** Refused: the function is not checked.

### `!tbaa`

**LangRef.** Accesses whose types the metadata calls unrelated do not alias.

**llubi.** Ignored.

**alive2.** Ignored.

## Parameters

### Parameter attributes of a definition

**LangRef.** They hold at every call.

**llubi.** Read only where a call passes them.

**alive2.** They hold for every input of the checked function.

### `writeonly`

**LangRef.** A read before the function writes the location is poison.

**llubi.** A read returns what memory holds.

**alive2.** A read through the pointer is UB.

### `captures(none)`

**LangRef.** The call captures neither the address nor the provenance of the pointer.

**llubi.** Storing or returning the pointer is not UB.

**alive2.** Storing the pointer where it outlives the call, or returning it, is UB, and comparing it is allowed.

### Partial `captures`

**LangRef.** `captures(address)` or `captures(provenance)` lets only that component be captured, and `captures(address, provenance)` is no attribute.

**llubi.** Comparing the pointer, or reading through a copy loaded back from memory, behaves as without the attribute.

**alive2.** Dropped with a warning.

### `initializes`

**LangRef.** Through the parameter, a load of a byte not yet stored is poison, and bytes left unstored are `undef` at a normal return. Other pointers are unaffected.

**llubi.** A read of the range returns what memory holds, and the function need not store it.

**alive2.** Only the function's own stores count, and returning before they cover the range is UB. Reads are checked only when a side has a `memory(...)` that limits something, and then a read of a byte not yet stored through any argument pointer, one that aliases the parameter included, is UB.

### `dead_on_return`

**LangRef.** Memory written through the pointer is poison after the return.

**llubi.** Ignored.

**alive2.** The memory behind the pointer is overwritten with poison at the return.

## alive-next

alive-next follows alive2. Where alive2 checks an attribute only against the function's own instructions, a cut or a window moves no instruction out of a function that has it, and `llops respected` drops those it shows the body keeps ([docs/implementation.md](./implementation.md), [docs/llops.md](./llops.md)). Where llubi differs, [docs/design.md](./design.md) and [docs/llops.md](./llops.md) state which differences a run is screened for and which the harness closes.
