# alive-next

Agent-driven, alive2-certified translation validation for large LLVM IR programs.

[alive2](https://github.com/AliveToolkit/alive2) decides whether one function refines another by sending the whole pair to an SMT solver in one query, so it stops answering as programs grow. alive-next keeps alive2 as the checker and puts an agent in front of it to cut the pair into pieces small enough to answer, and to rewrite one side toward the other a certified step at a time.

The agent is untrusted. Every step it proposes is validated by alive2 before it counts, and every counterexample by running both programs on a concrete input, so a bad proposal wastes time and never produces a wrong answer. A run ends verified, with a package anyone can replay; refuted, with the input that shows it; or unknown.

Straightline code for now, memory operations included. Conditionals and loops need further design.

## Build

Needs git, cmake, ninja, curl, a C++ compiler, and Z3's development headers. Everything else, LLVM included, is built from source against one pinned revision, which takes about an hour.

```sh
make install-deps
cp config.example.jsonc config.jsonc   # then set the model to use
make test
```

## Run

```sh
make examples                          # prove the worked examples, into sessions/
make agent SRC=a.ll TGT=b.ll           # prove one pair with the configured model
python3 scripts/check.py sessions/<id>/certificate
make visualize SESSION=sessions/<id>   # the run as one HTML page
make help                              # every target
```

`engine/examples/` is the tutorial: eight pairs, each with the moves that settle it, written as scripts so the framework runs with no model in front of it.

## Documents

* [docs/design.md](docs/design.md): what the system is.
* [docs/implementation.md](docs/implementation.md): how it is built.
* [docs/llops.md](docs/llops.md): the native binary's interface.
* [docs/agent.md](docs/agent.md): how the agent is wired.
