# alive-next

Interactive translation validation framework with agent-driven, alive2-certified proofs for large LLVM IR programs.

`alive-next` builds an interactive translation validation framework analogous to interactive theorem proving. [alive2](https://github.com/AliveToolkit/alive2) decides whether one function refines another by sending the whole pair to an SMT solver in one query, so it stops answering as programs grow. alive-next keeps alive2 as the trusted formal checker and puts a proof writer (an untrusted autonomous agent or scripted proof) in front of it to search for proofs using decomposition, Hoare-style reasoning, and stepwise certified rewriting.

The proof writer is untrusted. Every decomposition step, subproof, rewrite, and interface fact it proposes is validated with respect to operational semantics by alive2 before it counts, and every counterexample by running both programs on a concrete input under llubi. A bad proposal wastes time and never produces a wrong answer. A run ends verified, with a package anyone can replay; refuted, with the input that shows it; or unknown.

Straightline code for now, memory operations included. Conditionals and loops need further design.

## Build

Needs git, cmake, ninja, curl, a C++ compiler, and Z3's development headers. Everything else, LLVM included, is built from source against one pinned revision, which takes about an hour.

```sh
make install-deps
cp config.example.jsonc config.jsonc   # toolchain, timeouts
make test
```

### Agent
The agent is built upon [Pi](https://github.com/earendil-works/pi). Start `./engine/node_modules/.bin/pi` and `/login` to login, or export a provider's key as environment variables such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DEEPSEEK_API_KEY`. To use local OpenAI-compatible servers, such as Ollama or vLLM or llama.cpp, declare it in `~/.pi/agent/models.json` or in `.pi/extensions/`, [docs/agent.md](docs/agent.md#configuration) has the recipe.

## Run

Run the agent to find a refinement proof of a pair of LLVM IR files, `a.ll` and `b.ll`:

```sh
cd engine
bun run agent a.ll b.ll

bun run agent --list-models                        # what this machine can reach

bun run agent -m deepseek/deepseek-v4-flash a.ll b.ll # prove with one model for one run

bun run agent --pause a.ll b.ll                    # open without starting, enter starts it

bun run agent --help                               # every option
```

This agent will use the default model and provider registered in Pi. To change it, use for example `-m deepseek/deepseek-v4-flash`. Or use `--pause` to pause the agent after it starts, then set the model in Pi's TUI with `/model`, and then start it with any instruction.

More example commands:

```sh
make help                              # every target

make examples                          # prove the worked examples, into sessions/

python3 scripts/check.py sessions/<id>/certificate # independently replay the certificate

python3 scripts/visualize.py sessions/<id> # the run as one HTML page
```

`engine/examples/` is the tutorial: eight pairs, each with the moves that settle it, written as scripts so the framework runs with no model in front of it.

## Documents

* [docs/design.md](docs/design.md): what the system is.
* [docs/implementation.md](docs/implementation.md): how it is built.
* [docs/llops.md](docs/llops.md): the native binary's interface.
* [docs/agent.md](docs/agent.md): how the agent is wired.
