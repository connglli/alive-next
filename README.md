Alive2 (alive-next fork)
========================

![Alive2 logo](imgs/alive2.png)

> **alive-next addition (WIP, design phase).** This tree is alive2 plus an
> in-development extension that adds **compositional translation validation**:
> a new tool **`alive-tv-next`** that verifies a refinement query by cutting the
> function into small chunks and dispatching each chunk to alive2's existing
> per-pair refinement checker. The decomposition handles whole-function queries
> that hit alive2's SMT scaling cliff.
>
> Status: M1.2/M1.3 implemented — diff + single-instr cut + per-cut alive2 +
> compose. M1.4/M1.5 (Example 1 / Example 1' verify end-to-end) require the
> LLVM-trunk-against alive2 build to be ready. See [`IDEA.md`](IDEA.md) for
> the rationale, [`PLAN.md`](PLAN.md) for the staged plan + 7-example test
> set, and [`tests/alive-tv-next/`](tests/alive-tv-next/) for the reference
> tests. New source lives under `tv-next/` (library) and
> `tools/alive-tv-next.cpp` (entry point); everything else in this tree is
> upstream alive2, unmodified.
>
> See the [Alive-next quick start](#alive-next-quick-start) section below for
> alive-tv-next-specific build and usage notes.

Alive2 consists of several libraries and tools for analysis and verification
of LLVM code and transformations.
Alive2 includes the following libraries:
* Alive2 IR
* Symbolic executor
* LLVM → Alive2 IR converter
* Refinement check (aka optimization verifier)
* SMT abstraction layer

Included tools:
* Alive drop-in replacement
* Translation validation plugins for clang and LLVM's `opt`
* Standalone translation validation tool: `alive-tv` ([online](https://alive2.llvm.org))
* Clang drop-in replacement with translation validation (`alivecc` and
  `alive++`)
* An LLVM IR interpreter that is UB precise (`alive-exec`)
* **(alive-next, WIP)** Compositional translation validation tool: `alive-tv-next`

For a technical introduction to Alive2, please see [our paper from
PLDI 2021](https://web.ist.utl.pt/nuno.lopes/pubs/alive2-pldi21.pdf).


WARNING
-------
Alive2 does not support inter-procedural transformations. Alive2 may produce
spurious counterexamples if run with such passes.


Sponsors
--------
We thank the continuous support of all of our sponsors! Alive2 wouldn't be possible without their support.

[![Google](imgs/google.svg)](https://research.google)
&nbsp;&nbsp;&nbsp;&nbsp;
[![NLNet](imgs/nlnet.svg)](https://nlnet.nl)
&nbsp;&nbsp;&nbsp;&nbsp;
[![Woven by Toyota](imgs/woven.svg)](https://woven.toyota)
&nbsp;&nbsp;&nbsp;&nbsp;
[![Matter Labs](imgs/matterlabs.svg)](https://matter-labs.io)

If your company has benefitted from Alive2 (including having a less buggy LLVM), please consider sponsoring our research lab.


Prerequisites
-------------
To build Alive2 you need recent versions of:
* [cmake](https://cmake.org)
* [gcc](https://gcc.gnu.org)/[clang](https://clang.llvm.org)
* [re2c](https://re2c.org/)
* [Z3](https://github.com/Z3Prover/z3)
* [LLVM](https://github.com/llvm/llvm-project) (optional)
* [hiredis](https://github.com/redis/hiredis) (optional, needed for caching)


Building
--------

```
git clone git@github.com:AliveToolkit/alive2.git
cd alive2
mkdir build
cd build
cmake -GNinja -DCMAKE_BUILD_TYPE=Release ..
ninja
```

If CMake cannot find the Z3 include directory (or finds the wrong one) pass
the ``-DZ3_INCLUDE_DIR=/path/to/z3/include`` and ``-DZ3_LIBRARIES=/path/to/z3/lib/libz3.so`` arguments to CMake.


Building and Running Translation Validation
--------

Alive2's `opt` and `clang` translation validation requires a build of LLVM with
RTTI and exceptions turned on. The latest version of Alive2 is always intended
to be built against the latest version of LLVM, using the main branch from
the LLVM repo on Github.
LLVM can be built in the following way.
* You may prefer to add `-DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++` to the CMake step if your default compiler is `gcc`.
* Explicitly setting the target may not be necessary.
* `BUILD_SHARED_LIBS` may not be necessary, and for LLVM forks not normally
built with the option, may interfere with CMake files’ use of `USEDLIBS` and
`LLVMLIBS`, and perhaps `dd_llvm_target`.
* To build with Xcode rather than Ninja, replace `-GNinja` with `-GXcode` in
the `cmake` step below, and append `-DLLVM_MAIN_SRC_DIR=~/llvm/llvm`.
  * It may be necessary to disable warnings for “Implicit Conversion to 32 Bit
  Type” in the project build settings.
  * Xcode may place `tv.dylib` in a different location; a symbolic link from the
actual location to that in the resultant error message may help.

```
cd ~/llvm
mkdir build
cd build
cmake -GNinja -DLLVM_ENABLE_RTTI=ON -DBUILD_SHARED_LIBS=ON -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_ASSERTIONS=ON -DLLVM_ENABLE_PROJECTS="llvm;clang" ../llvm
ninja
```

Alive2 should then be configured and built as follows:
```
cd ~/alive2/build
cmake -GNinja -DCMAKE_PREFIX_PATH=~/llvm/build -DBUILD_TV=1 -DCMAKE_BUILD_TYPE=Release ..
ninja
```

Translation validation of one or more LLVM passes transforming an IR file:
```
~/alive/build/alive-tv -passes=instcombine foo.ll
```
Or using the opt wrapper:
```
~/alive2/build/opt-alive-test.sh -passes=instcombine foo.ll
```


Translation validation of a single LLVM unit test, using lit:
```
~/llvm/build/bin/llvm-lit -vv -Dopt=~/alive2/build/opt-alive.sh ~/llvm/llvm/test/Transforms/InstCombine/canonicalize-constant-low-bit-mask-and-icmp-sge-to-icmp-sle.ll
```

The output should be:
```
-- Testing: 1 tests, 1 threads --
PASS: LLVM :: Transforms/InstCombine/canonicalize-constant-low-bit-mask-and-icmp-sge-to-icmp-sle.ll (1 of 1)
Testing Time: 0.11s
  Expected Passes    : 1
```

To run translation validation on all the LLVM unit tests for IR-level
transformations:

```
~/llvm/build/bin/llvm-lit -s -Dopt=~/alive2/build/opt-alive.sh ~/llvm/llvm/test/Transforms
```

We run this command on the main LLVM branch each day, and keep track of the results
[here](https://web.ist.utl.pt/nuno.lopes/alive2/).  To detect unsound transformations in a local run:

```
grep -Fr "(unsound)" ~/alive2/build/logs/
```


Running Alive2 as a Clang Plugin
--------------------------------

This plugin tries to validate every IR-level transformation performed
by LLVM.  Invoke the plugin like this:

```
clang -O3 ~/llvm/clang/test/C/C99/n505.c -S -emit-llvm \
  -fpass-plugin=~/alive2/build/tv/tv.so \
  -Xclang -load -Xclang ~/alive2/build/tv/tv.so
```

Or, more conveniently:

```
~/alive2/build/alivecc -O3 -c ~/llvm/clang/test/C/C99/n505.c

~/alive2/build/alive++ -O3 -c ~/llvm/clang/test/Analysis/aggrinit-cfg-output.cpp
```

The Clang plugin can optionally use multiple cores. To enable parallel
translation validation, add the `-mllvm -tv-parallel=XXX` command line
options to Clang, where XXX is one of two parallelism managers
supported by Alive2. The first (XXX=fifo) uses alive-jobserver: for
details about how to use this program, please consult its help output
by running it without any command line arguments. The second
parallelism manager (XXX=unrestricted) does not restrict parallelism
at all, but rather calls fork() freely. This is mainly intended for
developer use; it tends to use a lot of RAM.

Use the `-mllvm -tv-report-dir=dir` to tell Alive2 to place its output
files into a specific directory.

The Clang plugin's output can be voluminous. To help control this, it
supports an option to reduce the amount of output (`-mllvm
-tv-quiet`).

Our goal is for the `alivecc` and `alive++` compiler drivers to be
drop-in replacements for `clang` and `clang++`. So, for example, they
try to detect when they are being invoked as assemblers or linkers, in
which case they do not load the Alive2 plugin. This means that some
projects cannot be built if you manually specify command line options
to Alive2, for example using `-DCMAKE_C_FLAGS=...`. Instead, you can
tell `alivecc` and `alive++` what to do using a collection of
environment variables that generally mirror the plugin's command line
interface. For example:

```
ALIVECC_PARALLEL_UNRESTRICTED=1
ALIVECC_PARALLEL_FIFO=1
ALIVECC_DISABLE_UNDEF_INPUT=1
ALIVECC_DISABLE_POISON_INPUT=1
ALIVECC_SMT_TO=timeout in milliseconds
ALIVECC_SUBPROCESS_TIMEOUT=timeout in seconds
ALIVECC_OVERWRITE_REPORTS=1
ALIVECC_REPORT_DIR=dir
```

If validating the program takes a long time, you can batch optimizations to
verify.
Please set `ALIVECC_BATCH_OPTS=1` and run `alivecc`/`alive++`.


Running the Standalone Translation Validation Tool (alive-tv)
--------

This tool has two modes.

In the first mode, specify either a source (original) and target (optimized) IR
file, or a single file containing a function called “src” and also a function
called “tgt”. For example, let’s prove that removing `nsw` is correct for
addition:

```
~/alive2/build/alive-tv src.ll tgt.ll

----------------------------------------
define i32 @f(i32 %a, i32 %b) {
  %add = add nsw i32 %b, %a
  ret i32 %add
}
=>
define i32 @f(i32 %a, i32 %b) {
  %add = add i32 %b, %a
  ret i32 %add
}

Transformation seems to be correct!
```

Flipping the inputs yields a counterexample, since it's not correct, in general,
to add `nsw`.
If you are not interested in counterexamples using `undef`, you can use the
command-line argument `-disable-undef-input`.

In the second mode, specify a single unoptimized IR file. alive-tv
will optimize it using an optimization pipeline similar to -O2, but
without any interprocedural passes, and then attempt to validate the
translation.

For example, as of February 6 2020, the `release/10.x` branch contains
an optimizer bug that can be triggered as follows:

```
cat foo.ll

define i3 @foo(i3) {
  %x1 = sub i3 0, %0
  %x2 = icmp ne i3 %0, 0
  %x3 = zext i1 %x2 to i3
  %x4 = lshr i3 %x1, %x3
  %x5 = lshr i3 %x4, %x3
  ret i3 %x5
}

~/alive2/build/alive-tv foo.ll

----------------------------------------
define i3 @foo(i3 %0) {
  %x1 = sub i3 0, %0
  %x2 = icmp ne i3 %0, 0
  %x3 = zext i1 %x2 to i3
  %x4 = lshr i3 %x1, %x3
  %x5 = lshr i3 %x4, %x3
  ret i3 %x5
}
=>
define i3 @foo(i3 %0) {
  %x1 = sub i3 0, %0
  ret i3 %x1
}
Transformation doesn't verify!
ERROR: Value mismatch

Example:
i3 %0 = #x5 (5, -3)

Source:
i3 %x1 = #x3 (3)
i1 %x2 = #x1 (1)
i3 %x3 = #x1 (1)
i3 %x4 = #x1 (1)
i3 %x5 = #x0 (0)

Target:
i3 %x1 = #x3 (3)
Source value: #x0 (0)
Target value: #x3 (3)

Summary:
  0 correct transformations
  1 incorrect transformations
  0 errors
```

Please keep in mind that you do not have to compile Alive2 in order to
try out alive-tv; it is available online: https://alive2.llvm.org/ce/


Running the Standalone LLVM Execution Tool (alive-exec)
-------------------------------------------------------

This tool uses Alive2 as an interpreter for an LLVM function. It is
currently highly experimental and has many restrictions. For example,
the function cannot take inputs, cannot use memory, cannot depend on
undefined behaviors, and cannot include loops that execute too many
iterations.

Caching
--------

The alive-tv tool and the Alive2 translation validation opt plugin
support using an external Redis server to avoid performing redundant
queries. This feature is not intended for general use, but rather to
speed up certain systematic testing workloads that perform a lot of
repeated work. When it hits a repeated refinement check, it prints
"Skipping repeated query" instead of performing the query.

If you want to use this functionality, you will need to manually start
and stop, as appropriate, a Redis server instance on localhost. Alive2
should be the only user of this server.

Diagnosing Unsoundness Reports
------------------------------

* Select a failing test file. It may be convenient to choose one whose path is
given at the beginning of a log file containing the text "(unsound)" as above;
this is guaranteed to contain an unsoundness report.  Many log files, however,
contain only “Source: \<stdin\>” rather than a file path; the names of these
files begin with “in_”.
* Do a verbose run of Lit for just that file, with the `opt`  option
`--print-after-all` appended.  (You may also append other `opt`  options, such
as other optimizations.)  E.g.:
```
~/llvm/build/bin/llvm-lit -vva "-Dopt=~/alive2/build/opt-alive.sh --print-after-all" ~/llvm/llvm/test/Transforms/InstCombine/insert-const-shuf.ll
```
* Collect Lit’s LLVM IR terminal output, for comparison with Alive2’s Alive2 IR
output in the log file indicated by “Report written to…”.  Sometimes the Lit
output may not contain useful LLVM IR, in which case executing the output
RUN command separately may give better results.
* The Alive2 unsoundness report in the corresponding log file will have two
versions of the misoptimized function.  The Alive2 IR function body may
indicate the problem to a human, but for Alive2 translation validation
you will need LLVM IR.  Search for the function name in the terminal output.
* Copy the first function definition and necessary declarations and metadata to
either a new file or to the Alive2 Compiler Explorer instance,
[https://alive2.llvm.org/ce/](https://alive2.llvm.org/ce/).
(The `-allow-incomplete-ir` flag may make copying declarations and metadata
unnecessary.)
The Alive2 Compiler Explorer instance will run automatically;
to check with the standalone `alive-tv`, see its instructions above.
Without a second version of the function to compare, Alive2 just runs the
`-O2` optimizations;
if it reports unsoundness, your fork’s optimizations are not to blame.
* If there is a second, unsound, function definition in the LLVM IR terminal
output, copy it and necessary declarations, and change the
second function name.
* If it now reports a misoptimization, presumably your fork has a bug,
demonstrated by the provided examples.
* To screen out exact duplicate reports when comparing different test runs,
move the `logs` directory out of the way before each run.  After each run, copy
the relevant logs to a separate destination directory.  (Systems with a non-GNU
version of `cp` will need to use coreutils’ `gcp` instead.)
```
fgrep --files-with-matches --recursive "(unsound)" ~/alive2/build/logs/ |  xargs cp -p --target-directory=<Destination>

```
* Unique unsoundness reports can then be found with a utility such as `jdupes --print-unique`.  
  * If the tests are run on different LLVM directories, the “Source:” line in
  files whose name does not begin with “in_”, as well as “Command line:” lines
  on Linux, should be stripped before comparison.


Troubleshooting
---------------
* Check the “LLVMConfig.cmake” and “CMAKE_PREFIX_PATH” output from CMake in
case of build problems. CMake may look for configuration information in old
installations of LLVM, e.g., under `/opt/`, if these are not set properly.
* Some combinations of Clang and MacOS versions may give link warnings 
“-undefined dynamic_lookup may not work with chained fixups,” and
runtime errors with “symbol not found in flat namespace.”  Setting
[CMAKE_OSX_DEPLOYMENT_TARGET](https://cmake.org/cmake/help/latest/variable/CMAKE_OSX_DEPLOYMENT_TARGET.html)
as a cache entry to 11.0 or less at the beginning of CMakeLists.txt may work
around this.
* Building for Translation Validation is tightly coupled to LLVM top of tree
source.  Building a fork with older source may require reverting to the
corresponding Alive2 commit.  This in turn may require experimentation with
Clang and SDK versions and vendors.
* Building older source on an up-to-date machine may require adjustments.  For
example, the now-deleted file `scripts/rewritepass.py` depended on the
deprecated Python 2; update the shebang line to `python3`.
* The `opt` wrapper script `build/opt-alive.sh` accepts a `--verbose` option,
which outputs the command passed to `opt`.  Note that this may interfere 
with tests which check output.
* The script also accepts a `--no-timeout` option, which disables the `opt`
process timeout.  This timeout is not supported on Macintosh.  To change the
SMT timeout, instead pass an `-smt-to:` option to the `alive` executable.

LLVM Bugs Found by Alive2
-------------------------

[BugList.md](BugList.md) shows the list of LLVM bugs found by Alive2.


Alive-next quick start
----------------------

> *This section is from the alive-next fork, not upstream alive2.*

The fork adds a `alive-tv-next` binary that performs **compositional translation
validation**: structural diff + per-cut dispatch into alive2's existing
refinement checker. For context-dependent rewrites, `alive-tv-next` derives the
needed assume itself — hand-coded proposers in Phase 3 cover the test set's
patterns (range-from-mask, no-overflow-from-sext); an LLM-driven generic
proposer is a follow-on. The decomposition handles whole-function queries
that hit alive2's SMT scaling cliff.

### Status

WIP. The design and reference test set are done; the implementation is queued
behind milestone M1.1 in [`PLAN.md`](PLAN.md).

| Path | Status | Description |
|------|--------|-------------|
| [`IDEA.md`](IDEA.md) | done | Design rationale: compositional frame, the four sub-cases, LLM-as-oracle. |
| [`PLAN.md`](PLAN.md) | done | Phased plan + 7-example test set. |
| [`tests/alive-tv-next/`](tests/alive-tv-next/) | done | The 7 reference tests in `.srctgt.ll` form. |
| `tv-next/` | M1.2/M1.3 done | Pilot library — diff / cut / verify / compose. |
| `tools/alive-tv-next.cpp` | M1.2/M1.3 done | Driver / `main()`, parallel to `alive-tv.cpp`. |

### Building `alive-tv-next`

The same alive2 build steps above apply. The top-level `CMakeLists.txt`
registers an executable `alive-tv-next` (from `tools/alive-tv-next.cpp`,
parallel to `tools/alive-tv.cpp`) and includes the library subdirectory:

```cmake
add_llvm_executable(alive-tv-next "tools/alive-tv-next.cpp")
add_subdirectory(tv-next)               # builds the static library `tv-next`
target_link_libraries(alive-tv-next PRIVATE
  tv-next ${ALIVE_LIBS_LLVM} ${Z3_LIBRARIES} ${HIREDIS_LIBRARIES} ${llvm_libs})
```

(All three lines already added.) `ninja alive-tv-next` produces `build/alive-tv-next`
alongside the upstream `build/alive-tv`, `build/alive`, etc.

### Running

```
# Two-file form, or @src/@tgt single-file form. The slice is the only input;
# assumes (when needed for Phase 3+ rewrites) are derived internally by
# alive-tv-next and injected into per-cut alive2 queries as `llvm.assume`.
~/alive-next/build/alive-tv-next pre.ll post.ll
~/alive-next/build/alive-tv-next combined.srctgt.ll

# With LLM fallback (later phases):
~/alive-next/build/alive-tv-next combined.srctgt.ll --model gpt-4o
```

`alive-tv-next` inherits all of `alive-tv`'s flags (`--smt-to`,
`--disable-undef-input`, `--src-fn`, `--tgt-fn`, …) by including
alive-tv's `cmd_args_list.h`. The catalog of pre-verified rewrite
templates is bundled with the binary at a compiled-in path; there is no
user-facing catalog flag.

Output is alive2-compatible (`Transformation seems to be correct!` on
success). Existing lit infrastructure handles the test files as-is.

### Environment variables

Phase 1–4 uses **hand-coded assume proposers** inside `alive-tv-next`; no LLM
is needed. An LLM-driven proposer is a later-phase fallback for what hand-coded
proposers don't cover, opt-in via `--model`. Auth and endpoint live in env vars
so they don't end up on the command line:

| Variable | Used for | Required? |
|----------|----------|-----------|
| `ALIVE_NEXT_LLM_API_KEY` | Auth token for the LLM provider | Yes, when `--model` is set |
| `ALIVE_NEXT_LLM_BASE_URL` | API endpoint (default: provider's public endpoint) | Optional; for self-hosted / proxy / region-local instances |

(The model name itself is a CLI flag — `--model` — not an env var, since it's
a per-invocation choice users will A/B-test, distinct from deployment-fixed
secrets and endpoints.)

None of these affect the Phase 1–4 path. An `alive-tv-next` invocation without
`--model` reads them lazily and never errors out.

### Reference test set

Seven cases under [`tests/alive-tv-next/`](tests/alive-tv-next/), each documenting which
example from `IDEA.md` / `PLAN.md` it implements and which mechanism the pilot
must use:

| File | Phase | Mechanism |
|------|-------|-----------|
| `e1.srctgt.ll`, `e1alt.srctgt.ll` | 1 | single-instr catalog dispatch |
| `e2.srctgt.ll`, `varB.srctgt.ll` | 2 | multi-instr catalog dispatch |
| `varA.srctgt.ll`, `e4.srctgt.ll` | 3 | scalar assume-needed |
| `e3.srctgt.ll` | 4 | vectorization + per-lane lifting + assume |

All seven currently time out on upstream `alive-tv` even at 60 s — direct
empirical motivation for the pilot.
