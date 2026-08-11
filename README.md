# alive-next

Agent-driven, alive2-certified translation validation for large LLVM IR programs.

[alive2](https://github.com/AliveToolkit/alive2) decides whether one function refines another by sending the whole pair to an SMT solver in one query, so it stops answering as programs grow. alive-next keeps alive2 as the checker and puts an agent in front of it to cut the pair into pieces small enough to answer, and to rewrite one side toward the other a certified step at a time.

The agent is untrusted. Every step it proposes is validated by alive2 before it counts, and every counterexample by running both programs on a concrete input, so a bad proposal wastes time and never produces a wrong answer. A run ends verified, with a package anyone can replay; refuted, with the input that shows it; or unknown.

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
```

This agent will use the default model and provider registered in Pi. To change it, use for example `-m deepseek/deepseek-v4-flash`. Or use `--pause` to pause the agent after it starts, then set the model in Pi's TUI with `/model`, and then start it with any instruction.

More example commands:

```sh
make examples                          # prove the worked examples, into sessions/
make agent SRC=a.ll TGT=b.ll           # prove one pair, watched in Pi's TUI
python3 scripts/check.py sessions/<id>/certificate
make visualize SESSION=sessions/<id>   # the run as one HTML page
make help                              # every target
```

```sh
bun run agent --list-models                        # what this machine can reach
bun run agent -m ollama/qwen3:0.6b a.ll b.ll       # prove with one model for one run
bun run agent --pause a.ll b.ll                    # open without starting, enter starts it
bun run agent --help                               # every option
```

`engine/examples/` is the tutorial: eight pairs, each with the moves that settle it, written as scripts so the framework runs with no model in front of it.

## Documents

* [docs/design.md](docs/design.md): what the system is.
* [docs/implementation.md](docs/implementation.md): how it is built.
* [docs/llops.md](docs/llops.md): the native binary's interface.
* [docs/agent.md](docs/agent.md): how the agent is wired.
